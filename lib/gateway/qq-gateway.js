export const QQ_INTENTS = (1 << 25) | (1 << 26); // GROUP_AND_C2C_EVENT + INTERACTION(按钮回调;仿 Hermes)
const OP_HELLO = 10;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_HEARTBEAT_ACK = 11;
const OP_DISPATCH = 0;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const ERR_RESUMEABLE = 4009;
// 关闭码分类(Hermes adapter 对齐)
// 致命码:不可恢复,停止重连
const FATAL_CLOSE_CODES = new Set([
    4001, // Invalid opcode
    4002, // Invalid payload
    4010, // Invalid shard
    4011, // Sharding required
    4012, // Invalid API version
    4013, // Invalid intent
    4014, // Intent not authorized
    4914, // Offline/sandbox-only
    4915, // Banned
]);
// 会话失效码:需清 session 重新 Identify
const SESSION_INVALID_CODES = new Set([
    4006, 4007, 4900, 4901, 4902, 4903, 4904,
    4905, 4906, 4907, 4908, 4909, 4910, 4911, 4912, 4913,
]);
// 快速断连检测:5s 内断开计一次,3 次后停止(疑似凭据/权限问题)
const QUICK_DISCONNECT_THRESHOLD_MS = 5000;
const MAX_QUICK_DISCONNECT_COUNT = 3;
export class QQGateway {
    ws;
    state = "disconnected";
    stateInfo = "";
    heartbeatTimer;
    heartbeatAckPending = false;
    lastHeartbeatAt = 0;
    heartbeatAckTimeoutMs = 15_000;
    sessionId;
    lastSeq = 0;
    reconnectAttempts = 0;
    reconnectTimer;
    stopped = false;
    stateListeners = new Set();
    inboundListeners = new Set();
    apiBase;
    maxReconnectAttempts;
    reconnectBaseMs;
    reconnectMaxMs;
    auth;
    debugLog;
    constructor(auth, options) {
        this.auth = auth;
        this.debugLog = options.debugLog;
        this.apiBase =
            options.apiBase ??
                (options.sandbox
                    ? "https://sandbox.api.sgroup.qq.com"
                    : "https://api.sgroup.qq.com");
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
        this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
        this.reconnectMaxMs = options.reconnectMaxMs ?? 30000;
    }
    getState() {
        return { state: this.state, info: this.stateInfo };
    }
    onStateChange(listener) {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }
    onInbound(listener) {
        this.inboundListeners.add(listener);
        return () => this.inboundListeners.delete(listener);
    }
    /** 启动网关（幂等：已 connected 直接返回 true） */
    async start() {
        if (this.state === "connected" || this.state === "connecting")
            return true;
        this.stopped = false;
        this.reconnectAttempts = 0;
        try {
            await this.connect();
            return true;
        }
        catch (err) {
            this.setState("error", `连接失败：${err.message}`);
            return false;
        }
    }
    /** 手动重连（自动重连停止后使用） */
    async reconnect() {
        this.reconnectAttempts = 0;
        this.stopped = false;
        this.closeSocket();
        try {
            await this.connect();
            return true;
        }
        catch (err) {
            this.setState("error", `重连失败：${err.message}`);
            return false;
        }
    }
    /** 停止网关（关闭 socket、清理定时器、不再自动重连） */
    async stop() {
        this.stopped = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.closeSocket();
        this.setState("disconnected", "已停止");
    }
    setState(state, info = "") {
        this.state = state;
        this.stateInfo = info;
        this.debugLog?.(`[gw] 状态: ${state}${info ? `（${info}）` : ""}`);
        for (const listener of this.stateListeners)
            listener(state, info);
    }
    closeSocket() {
        this.clearHeartbeat();
        if (this.ws) {
            // 摘除监听后再 close，避免触发重连路径
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            try {
                this.ws.close();
            }
            catch {
                // 拆除路径：socket 可能已半关闭，close 抛错无需处理（监听器已摘除，不会触发重连）
            }
            this.ws = undefined;
        }
    }
    async connect() {
        const token = await this.auth.getToken();
        const gatewayRes = await fetch(`${this.apiBase}/gateway`, {
            headers: { Authorization: `QQBot ${token}` },
        });
        if (gatewayRes.status === 401) {
            // token 失效（如长期运行后预刷新被跳过）：强制刷新后重试一次
            this.debugLog?.(`gateway 端点 401，强制刷新 token 后重试`);
            await this.auth.forceRefresh();
            const token2 = await this.auth.getToken();
            const retryRes = await fetch(`${this.apiBase}/gateway`, {
                headers: { Authorization: `QQBot ${token2}` },
            });
            if (!retryRes.ok) {
                throw new Error(`gateway 端点 HTTP ${retryRes.status} ${retryRes.statusText}`);
            }
            const retryBody = (await retryRes.json());
            if (typeof retryBody.url !== "string" || retryBody.url === "") {
                throw new Error("gateway 响应缺少 url");
            }
            this.setState("connecting", "获取网关地址");
            await this.openSocket(retryBody.url, token2);
            return;
        }
        if (!gatewayRes.ok) {
            throw new Error(`gateway 端点 HTTP ${gatewayRes.status} ${gatewayRes.statusText}`);
        }
        const gatewayBody = (await gatewayRes.json());
        if (typeof gatewayBody.url !== "string" || gatewayBody.url === "") {
            throw new Error("gateway 响应缺少 url");
        }
        this.setState("connecting", "获取网关地址");
        await this.openSocket(gatewayBody.url, token);
    }
    lastConnectAt = 0;
    quickDisconnectCount = 0;
    openSocket(url, token) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const ws = new WebSocket(url);
            this.ws = ws;
            this.debugLog?.(`[gw] openSocket ${url} | WebSocket 实现: ${WebSocket.name ?? "anonymous"} / toString: ${String(WebSocket).slice(0, 80)}`);
            const fail = (err) => {
                if (settled)
                    return;
                settled = true;
                this.closeSocket();
                reject(err);
            };
            ws.onopen = () => {
                // 等待 op10 Hello
            };
            ws.onmessage = (event) => {
                const dataType = typeof event.data;
                const data = dataType === "string"
                    ? event.data
                    : dataType === "object" &&
                        event.data !== null &&
                        "text" in event.data
                        ? String(event.data.text)
                        : Buffer.from(event.data).toString("utf8");
                this.debugLog?.(`[gw] 收到帧 type=${dataType} len=${data.length} 前120: ${data.slice(0, 120)}`);
                let frame;
                try {
                    frame = JSON.parse(data);
                }
                catch {
                    return; // 忽略非 JSON 帧
                }
                this.handleFrame(frame, token, resolve, fail);
            };
            ws.onerror = () => {
                fail(new Error("WebSocket 连接错误"));
            };
            ws.onclose = (ev) => {
                if (this.ws !== ws)
                    return; // 已被 closeSocket 替换
                this.ws = undefined;
                this.clearHeartbeat();
                // 记录连接时长用于快速断连检测
                if (this.lastConnectAt > 0) {
                    const duration = Date.now() - this.lastConnectAt;
                    if (duration < QUICK_DISCONNECT_THRESHOLD_MS) {
                        this.quickDisconnectCount += 1;
                        this.debugLog?.(`[gw] 快速断连(${duration}ms)，第 ${this.quickDisconnectCount} 次`);
                        if (this.quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
                            this.setState("error", "多次快速断连：请检查 AppID/Secret 与机器人权限（QQ 开放平台）");
                            return;
                        }
                    }
                    else {
                        this.quickDisconnectCount = 0;
                    }
                }
                // 关闭码分类（Hermes adapter 对齐）
                const code = ev?.code;
                if (code !== undefined) {
                    if (FATAL_CLOSE_CODES.has(code)) {
                        this.setState("error", `致命关闭码 ${code}（机器人下线/封禁/配置错误），停止重连`);
                        return;
                    }
                    if (code === 4004) {
                        // token 无效 → 清缓存,下次 connect 会刷新
                        this.debugLog?.(`[gw] 关闭码 4004（token 无效），将刷新后重连`);
                        void this.auth.forceRefresh().catch(() => undefined);
                    }
                    else if (code === 4008) {
                        this.debugLog?.(`[gw] 关闭码 4008（限流），退避 60s`);
                        this.setState("connecting", "限流(4008)，60s 后重连");
                        setTimeout(() => {
                            if (!this.stopped)
                                this.scheduleReconnect("rate limited (4008)");
                        }, 60_000).unref?.();
                        return;
                    }
                    else if (SESSION_INVALID_CODES.has(code)) {
                        this.debugLog?.(`[gw] 关闭码 ${code}（会话失效），清 session 重新 Identify`);
                        this.sessionId = undefined;
                        this.lastSeq = 0;
                    }
                    else if (code !== 4009) {
                        this.debugLog?.(`[gw] 关闭码 ${code}`);
                    }
                    // 4009:可恢复,保留 session 走 Resume
                }
                if (settled) {
                    // 连接建立后断开 → 自动重连
                    this.scheduleReconnect(`连接已断开${code !== undefined ? `(code=${code})` : ""}`);
                }
                else if (!this.stopped) {
                    fail(new Error("连接在握手完成前关闭"));
                }
            };
        });
    }
    handleFrame(frame, token, onReady, onFail) {
        switch (frame.op) {
            case OP_HELLO: {
                const d = frame.d;
                const interval = d?.heartbeat_interval ?? 30_000;
                this.startHeartbeat(interval);
                // Identify 或 Resume
                const payload = this.sessionId
                    ? {
                        op: OP_RESUME,
                        d: {
                            token: `QQBot ${token}`,
                            session_id: this.sessionId,
                            seq: this.lastSeq,
                        },
                    }
                    : {
                        op: OP_IDENTIFY,
                        d: {
                            token: `QQBot ${token}`,
                            intents: QQ_INTENTS,
                            shard: [0, 1],
                            properties: { os: process.platform, language: "node" },
                        },
                    };
                this.debugLog?.(`[gw] Hello 收到，发送 ${this.sessionId ? "Resume" : "Identify"}（sessionId=${this.sessionId ?? "无"}）`);
                this.ws?.send(JSON.stringify(payload));
                break;
            }
            case OP_HEARTBEAT_ACK:
                this.heartbeatAckPending = false;
                break;
            case OP_DISPATCH: {
                if (typeof frame.s === "number")
                    this.lastSeq = frame.s;
                if (frame.t === "READY") {
                    const d = frame.d;
                    if (typeof d?.session_id === "string")
                        this.sessionId = d.session_id;
                    this.reconnectAttempts = 0;
                    this.lastConnectAt = Date.now();
                    this.debugLog?.(`[gw] READY session_id=${this.sessionId ?? "?"}`);
                    this.setState("connected", "已连接");
                    onReady();
                }
                else if (frame.t === "RESUMED") {
                    this.reconnectAttempts = 0;
                    this.lastConnectAt = Date.now();
                    this.debugLog?.("[gw] RESUMED");
                    this.setState("connected", "已恢复（Resume）");
                    onReady();
                }
                else if (frame.t) {
                    this.debugLog?.(`[gw] 事件 ${frame.t}`);
                    this.dispatchEvent(frame.t, frame.d);
                }
                break;
            }
            case 7: {
                // op7 Reconnect：平台要求客户端重新连接
                // 注意：连接已 READY 后 onFail 因 settled 失效，必须显式重连
                this.debugLog?.("[gw] 收到 op7 Reconnect，主动重连");
                this.closeSocket();
                this.scheduleReconnect("平台要求重连(op7)");
                break;
            }
            case 9: {
                // op9 Invalid Session
                const d = frame.d;
                if (d === ERR_RESUMEABLE) {
                    // 4009：可以 resume —— 等下一次重连自然 resume
                    this.lastSeq = 0;
                }
                else {
                    // 其他错误：必须重新 Identify
                    this.sessionId = undefined;
                    this.lastSeq = 0;
                }
                onFail(new Error(`Invalid Session(op9) code=${JSON.stringify(d)}`));
                break;
            }
            default:
                break;
        }
    }
    dispatchEvent(t, d) {
        if (t === "INTERACTION_CREATE") {
            this.dispatchInteraction(d);
            return;
        }
        if (t !== "C2C_MESSAGE_CREATE" && t !== "GROUP_AT_MESSAGE_CREATE")
            return;
        const data = d;
        if (typeof data.id !== "string" || data.id === "")
            return;
        if (typeof data.author?.user_openid !== "string" ||
            data.author.user_openid === "")
            return;
        const isGroup = t === "GROUP_AT_MESSAGE_CREATE";
        const groupOpenId = isGroup && typeof data.group_openid === "string"
            ? data.group_openid
            : undefined;
        if (isGroup && !groupOpenId)
            return;
        const msg = {
            id: data.id,
            type: isGroup ? "group" : "private",
            text: typeof data.content === "string" ? data.content : "",
            userOpenId: data.author.user_openid,
            groupOpenId,
            attachments: Array.isArray(data.attachments)
                ? data.attachments
                    .filter((a) => a && typeof a.url === "string")
                    .map((a) => ({
                    url: a.url,
                    filename: typeof a.filename === "string" ? a.filename : "",
                    size: typeof a.size === "number" ? a.size : 0,
                    contentType: typeof a.content_type === "string" ? a.content_type : "",
                    width: typeof a.width === "number" ? a.width : undefined,
                    height: typeof a.height === "number" ? a.height : undefined,
                    asrReferText: typeof a.asr_refer_text === "string"
                        ? a.asr_refer_text
                        : undefined,
                }))
                : [],
            receivedAt: Date.now(),
            raw: d,
        };
        for (const listener of this.inboundListeners)
            listener(msg);
    }
    // ── INTERACTION_CREATE(按钮/交互事件,审批用) ──────────────────────
    /** 交互监听器:收到按钮点击时回调(仿 Hermes set_interaction_callback) */
    interactionListeners = new Set();
    onInteraction(listener) {
        this.interactionListeners.add(listener);
        return () => this.interactionListeners.delete(listener);
    }
    dispatchInteraction(d) {
        const data = d;
        if (typeof data.id !== "string" || data.id === "")
            return;
        const operator = typeof data.user_openid === "string" && data.user_openid !== ""
            ? data.user_openid
            : typeof data.oper_openid === "string"
                ? data.oper_openid
                : typeof data.oper_author?.user_openid === "string"
                    ? data.oper_author.user_openid
                    : typeof data.oper_author?.member_openid === "string"
                        ? data.oper_author.member_openid
                        : "";
        // 按钮 data 在 data.resolved.button_data(QQ 官方 INTERACTION_CREATE 结构;仿 Hermes)
        const dataObj = data.data;
        const buttonData = dataObj?.resolved?.button_data;
        const interaction = {
            id: data.id,
            buttonData: typeof buttonData === "string" ? buttonData : "",
            operatorOpenId: operator,
            groupOpenId: typeof data.group_openid === "string" ? data.group_openid : undefined,
            raw: d,
        };
        this.debugLog?.(`[gw] INTERACTION_CREATE id=${interaction.id} button=${interaction.buttonData.slice(0, 60)}`);
        for (const listener of this.interactionListeners) {
            try {
                listener(interaction);
            }
            catch (err) {
                this.debugLog?.(`[gw] interaction listener error: ${err.message}`);
            }
        }
    }
    startHeartbeat(intervalMs) {
        this.clearHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.ws)
                return;
            // 假死检测：上次心跳未确认且超时 → 主动重连（M7 加固）
            if (this.heartbeatAckPending &&
                Date.now() - this.lastHeartbeatAt > this.heartbeatAckTimeoutMs) {
                this.setState("connecting", "心跳超时，主动重连");
                this.closeSocket();
                this.scheduleReconnect("heartbeat timeout");
                return;
            }
            this.ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }));
            this.heartbeatAckPending = true;
            this.lastHeartbeatAt = Date.now();
            this.debugLog?.("[gw] 心跳发送 op1");
        }, intervalMs);
        this.heartbeatTimer.unref?.();
    }
    clearHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        this.heartbeatAckPending = false;
    }
    scheduleReconnect(reason) {
        if (this.stopped)
            return;
        // maxReconnectAttempts <= 0 表示无限重连（默认 0，避免静默掉线后 bot 永久失联）
        if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.setState("error", `自动重连已停止（${this.maxReconnectAttempts} 次失败，${reason}）；请手动 /qqbot-reconnect`);
            return;
        }
        this.reconnectAttempts += 1;
        const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1));
        this.setState("connecting", `断线（${reason}），${Math.round(delay / 1000)}s 后第 ${this.reconnectAttempts} 次重连`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect().catch((err) => {
                // connect 失败（含 /gateway 端点 5xx 等平台临时故障）→ 继续退避重试，直到次数上限
                this.scheduleReconnect(`连接失败：${err.message}`);
            });
        }, delay);
        this.reconnectTimer.unref?.();
    }
}
//# sourceMappingURL=qq-gateway.js.map