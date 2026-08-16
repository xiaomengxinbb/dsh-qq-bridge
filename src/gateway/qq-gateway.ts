/**
 * WebSocket 网关（spec §6.2）
 *
 * 状态机：disconnected → connecting → connected → error / closed
 * - GET {base}/gateway 取 wss url（Authorization: QQBot {token}）
 * - op10 Hello → op2 Identify {token, intents: 1<<25, shard:[0,1]} → READY
 * - 每 heartbeat_interval 发 op1（d=last seq）；op11 Heartbeat ACK
 * - 断线：指数退避 1s→30s，最多 5 次后停止（/qqbot-reconnect 手动重试）
 * - 重连：op6 Resume {token, session_id, seq} 补发遗漏事件；非 4009 错误走 Identify
 * - 依赖 Node 内置 WebSocket（Node >=22.19），零运行时依赖
 */
import type {
	QQGatewayState,
	QQGatewayStateListener,
	QQInboundListener,
	QQInboundMessage,
} from "../core/types.ts";
import type { QQAuth } from "./qq-auth.ts";

export const QQ_INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT

export interface QQGatewayOptions {
	sandbox: boolean;
	/** 调试日志回调（写文件等；诊断连接问题用） */
	debugLog?: (message: string) => void;
	/** API 基础域名（测试/代理覆盖） */
	apiBase?: string;
	/** 重连最大次数，默认 5 */
	maxReconnectAttempts?: number;
	/** 重连退避基数 ms，默认 1000 */
	reconnectBaseMs?: number;
	/** 重连退避上限 ms，默认 30000 */
	reconnectMaxMs?: number;
}

const OP_HELLO = 10;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_HEARTBEAT_ACK = 11;
const OP_DISPATCH = 0;

const ERR_RESUMEABLE = 4009;

export class QQGateway {
	private ws: WebSocket | undefined;
	private state: QQGatewayState = "disconnected";
	private stateInfo = "";
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private heartbeatAckPending = false;
	private lastHeartbeatAt = 0;
	private readonly heartbeatAckTimeoutMs = 15_000;
	private sessionId: string | undefined;
	private lastSeq = 0;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private readonly stateListeners = new Set<QQGatewayStateListener>();
	private readonly inboundListeners = new Set<QQInboundListener>();
	private readonly apiBase: string;
	private readonly maxReconnectAttempts: number;
	private readonly reconnectBaseMs: number;
	private readonly reconnectMaxMs: number;

	private readonly auth: QQAuth;
	private readonly debugLog?: (message: string) => void;

	constructor(auth: QQAuth, options: QQGatewayOptions) {
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

	getState(): { state: QQGatewayState; info: string } {
		return { state: this.state, info: this.stateInfo };
	}

	onStateChange(listener: QQGatewayStateListener): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	onInbound(listener: QQInboundListener): () => void {
		this.inboundListeners.add(listener);
		return () => this.inboundListeners.delete(listener);
	}

	/** 启动网关（幂等：已 connected 直接返回 true） */
	async start(): Promise<boolean> {
		if (this.state === "connected" || this.state === "connecting") return true;
		this.stopped = false;
		this.reconnectAttempts = 0;
		try {
			await this.connect();
			return true;
		} catch (err) {
			this.setState("error", `连接失败：${(err as Error).message}`);
			return false;
		}
	}

	/** 手动重连（自动重连停止后使用） */
	async reconnect(): Promise<boolean> {
		this.reconnectAttempts = 0;
		this.stopped = false;
		this.closeSocket();
		try {
			await this.connect();
			return true;
		} catch (err) {
			this.setState("error", `重连失败：${(err as Error).message}`);
			return false;
		}
	}

	/** 停止网关（关闭 socket、清理定时器、不再自动重连） */
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.closeSocket();
		this.setState("disconnected", "已停止");
	}

	private setState(state: QQGatewayState, info = ""): void {
		this.state = state;
		this.stateInfo = info;
		this.debugLog?.(`[gw] 状态: ${state}${info ? `（${info}）` : ""}`);
		for (const listener of this.stateListeners) listener(state, info);
	}

	private closeSocket(): void {
		this.clearHeartbeat();
		if (this.ws) {
			// 摘除监听后再 close，避免触发重连路径
			this.ws.onopen = null;
			this.ws.onmessage = null;
			this.ws.onclose = null;
			this.ws.onerror = null;
			try {
				this.ws.close();
			} catch {
				// 拆除路径：socket 可能已半关闭，close 抛错无需处理（监听器已摘除，不会触发重连）
			}
			this.ws = undefined;
		}
	}

	private async connect(): Promise<void> {
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
				throw new Error(
					`gateway 端点 HTTP ${retryRes.status} ${retryRes.statusText}`,
				);
			}
			const retryBody = (await retryRes.json()) as { url?: string };
			if (typeof retryBody.url !== "string" || retryBody.url === "") {
				throw new Error("gateway 响应缺少 url");
			}
			this.setState("connecting", "获取网关地址");
			await this.openSocket(retryBody.url, token2);
			return;
		}
		if (!gatewayRes.ok) {
			throw new Error(
				`gateway 端点 HTTP ${gatewayRes.status} ${gatewayRes.statusText}`,
			);
		}
		const gatewayBody = (await gatewayRes.json()) as { url?: string };
		if (typeof gatewayBody.url !== "string" || gatewayBody.url === "") {
			throw new Error("gateway 响应缺少 url");
		}
		this.setState("connecting", "获取网关地址");
		await this.openSocket(gatewayBody.url, token);
	}

	private openSocket(url: string, token: string): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const ws = new WebSocket(url);
			this.ws = ws;
			this.debugLog?.(
				`[gw] openSocket ${url} | WebSocket 实现: ${(WebSocket as unknown as { name?: string }).name ?? "anonymous"} / toString: ${String(WebSocket).slice(0, 80)}`,
			);

			const fail = (err: Error) => {
				if (settled) return;
				settled = true;
				this.closeSocket();
				reject(err);
			};

			ws.onopen = () => {
				// 等待 op10 Hello
			};

			ws.onmessage = (event) => {
				const dataType = typeof event.data;
				const data =
					dataType === "string"
						? event.data
						: dataType === "object" &&
								event.data !== null &&
								"text" in event.data
							? String((event.data as { text: unknown }).text)
							: Buffer.from(event.data as ArrayBuffer).toString("utf8");
				this.debugLog?.(
					`[gw] 收到帧 type=${dataType} len=${data.length} 前120: ${data.slice(0, 120)}`,
				);
				let frame: { op: number; s?: number; t?: string; d?: unknown };
				try {
					frame = JSON.parse(data) as {
						op: number;
						s?: number;
						t?: string;
						d?: unknown;
					};
				} catch {
					return; // 忽略非 JSON 帧
				}
				this.handleFrame(frame, token, resolve, fail);
			};

			ws.onerror = () => {
				fail(new Error("WebSocket 连接错误"));
			};

			ws.onclose = () => {
				if (this.ws !== ws) return; // 已被 closeSocket 替换
				this.ws = undefined;
				this.clearHeartbeat();
				if (settled) {
					// 连接建立后断开 → 自动重连
					this.scheduleReconnect("连接已断开");
				} else if (!this.stopped) {
					fail(new Error("连接在握手完成前关闭"));
				}
			};
		});
	}

	private handleFrame(
		frame: { op: number; s?: number; t?: string; d?: unknown },
		token: string,
		onReady: () => void,
		onFail: (err: Error) => void,
	): void {
		switch (frame.op) {
			case OP_HELLO: {
				const d = frame.d as { heartbeat_interval?: number } | undefined;
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
				this.debugLog?.(
					`[gw] Hello 收到，发送 ${this.sessionId ? "Resume" : "Identify"}（sessionId=${this.sessionId ?? "无"}）`,
				);
				this.ws?.send(JSON.stringify(payload));
				break;
			}
			case OP_HEARTBEAT_ACK:
				this.heartbeatAckPending = false;
				break;
			case OP_DISPATCH: {
				if (typeof frame.s === "number") this.lastSeq = frame.s;
				if (frame.t === "READY") {
					const d = frame.d as { session_id?: string } | undefined;
					if (typeof d?.session_id === "string") this.sessionId = d.session_id;
					this.reconnectAttempts = 0;
					this.debugLog?.(`[gw] READY session_id=${this.sessionId ?? "?"}`);
					this.setState("connected", "已连接");
					onReady();
				} else if (frame.t === "RESUMED") {
					this.reconnectAttempts = 0;
					this.debugLog?.("[gw] RESUMED");
					this.setState("connected", "已恢复（Resume）");
					onReady();
				} else if (frame.t) {
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
				const d = frame.d as number | undefined;
				if (d === ERR_RESUMEABLE) {
					// 4009：可以 resume —— 等下一次重连自然 resume
					this.lastSeq = 0;
				} else {
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

	private dispatchEvent(t: string, d: unknown): void {
		if (t !== "C2C_MESSAGE_CREATE" && t !== "GROUP_AT_MESSAGE_CREATE") return;
		const data = d as {
			id?: unknown;
			author?: { user_openid?: unknown };
			content?: unknown;
			group_openid?: unknown;
			attachments?: Array<{
				url?: unknown;
				filename?: unknown;
				size?: unknown;
				content_type?: unknown;
				width?: unknown;
				height?: unknown;
				asr_refer_text?: unknown;
			}>;
		};
		if (typeof data.id !== "string" || data.id === "") return;
		if (
			typeof data.author?.user_openid !== "string" ||
			data.author.user_openid === ""
		)
			return;
		const isGroup = t === "GROUP_AT_MESSAGE_CREATE";
		const groupOpenId =
			isGroup && typeof data.group_openid === "string"
				? data.group_openid
				: undefined;
		if (isGroup && !groupOpenId) return;
		const msg: QQInboundMessage = {
			id: data.id,
			type: isGroup ? "group" : "private",
			text: typeof data.content === "string" ? data.content : "",
			userOpenId: data.author.user_openid,
			groupOpenId,
			attachments: Array.isArray(data.attachments)
				? data.attachments
						.filter((a) => a && typeof a.url === "string")
						.map((a) => ({
							url: a.url as string,
							filename: typeof a.filename === "string" ? a.filename : "",
							size: typeof a.size === "number" ? a.size : 0,
							contentType:
								typeof a.content_type === "string" ? a.content_type : "",
							width: typeof a.width === "number" ? a.width : undefined,
							height: typeof a.height === "number" ? a.height : undefined,
							asrReferText:
								typeof a.asr_refer_text === "string"
									? a.asr_refer_text
									: undefined,
						}))
				: [],
			receivedAt: Date.now(),
			raw: d,
		};
		for (const listener of this.inboundListeners) listener(msg);
	}

	private startHeartbeat(intervalMs: number): void {
		this.clearHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (!this.ws) return;
			// 假死检测：上次心跳未确认且超时 → 主动重连（M7 加固）
			if (
				this.heartbeatAckPending &&
				Date.now() - this.lastHeartbeatAt > this.heartbeatAckTimeoutMs
			) {
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

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		this.heartbeatAckPending = false;
	}

	private scheduleReconnect(reason: string): void {
		if (this.stopped) return;
		// maxReconnectAttempts <= 0 表示无限重连（默认 0，避免静默掉线后 bot 永久失联）
		if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.setState(
				"error",
				`自动重连已停止（${this.maxReconnectAttempts} 次失败，${reason}）；请手动 /qqbot-reconnect`,
			);
			return;
		}
		this.reconnectAttempts += 1;
		const delay = Math.min(
			this.reconnectMaxMs,
			this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1),
		);
		this.setState(
			"connecting",
			`断线（${reason}），${Math.round(delay / 1000)}s 后第 ${this.reconnectAttempts} 次重连`,
		);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect().catch((err) => {
				// connect 失败（含 /gateway 端点 5xx 等平台临时故障）→ 继续退避重试，直到次数上限
				this.scheduleReconnect(`连接失败：${(err as Error).message}`);
			});
		}, delay);
		this.reconnectTimer.unref?.();
	}
}
