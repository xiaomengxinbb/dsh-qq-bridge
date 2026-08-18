/**
 * 隔离 AgentSession — DSH 版（Phase 3）
 *
 * 每个 QQ 对话 = 一个独立持久 DSH Agent（sessionId 自管，cwd = 桥工作区路径）。
 * - 创建：ctx.agents.create({sessionId, meta:{cwd}, agentOptions, setup})
 * - 恢复：ctx.agents.resume({resumeSessionId, ...})（按 id 自动定位持久化）
 * - 运行：agent.followup(createUserMessage(...)) + whenIdle + summarize（官方范式，见 dsh-headless）
 * - 插嘴：agent.steer（DSH 原生）；中止：agent.cancel({kind:'user'})
 * - 模型切换：installModelSelection ref（对下一步骤生效）
 * - 会话 id 方案：qq-<sha256("dsh-qq-bridge\0"+key+"\0"+workspace)[:12]>-<seq>（按对话+工作区隔离）
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { expandHome } from "../core/config.js";
function metaPathFor(base) {
    return join(expandHome("~/.dsh/qq-bridge"), "meta", `${base}.json`);
}
function readMeta(base) {
    try {
        return JSON.parse(readFileSync(metaPathFor(base), "utf8"));
    }
    catch {
        return {};
    }
}
function writeMeta(base, meta) {
    const path = metaPathFor(base);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
}
function getSessionName(base, id) {
    return readMeta(base)[id]?.name;
}
function setSessionNameMeta(base, id, name) {
    const meta = readMeta(base);
    meta[id] = { ...(meta[id] ?? {}), name };
    writeMeta(base, meta);
}
// ── 归一化 ────────────────────────────────────────────────────────────
export function toModelInfo(model) {
    const m = model;
    if (!m || typeof m.provider !== "string" || typeof m.id !== "string")
        return undefined;
    return {
        provider: m.provider,
        id: m.id,
        name: typeof m.name === "string" ? m.name : m.id,
        input: Array.isArray(m.input) ? m.input.filter((v) => typeof v === "string") : [],
        reasoning: m.reasoning === true,
    };
}
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function normalizeThinkingLevel(value) {
    const normalized = value.trim().toLowerCase();
    return THINKING_LEVELS.includes(normalized) ? normalized : undefined;
}
function normalizeSessionName(value) {
    if (value === undefined)
        return undefined;
    const trimmed = value.trim().replace(/\s+/g, " ").slice(0, 60);
    return trimmed || undefined;
}
/** 会话 id 基座：sha256("dsh-qq-bridge\0"+key+"\0"+workspacePath) 前 12 位。
 * 工作区路径变化 → 新 id 家族（防跨 cwd id 撞车）；路径稳定 → id 稳定可恢复。 */
export function sessionIdBase(key, workspacePath) {
    return `qq-${createHash("sha256").update(`dsh-qq-bridge\0${key}\0${workspacePath}`).digest("hex").slice(0, 12)}`;
}
function maxSeqOf(ids, base) {
    let max = 0;
    for (const id of ids) {
        if (!id.startsWith(`${base}-`))
            continue;
        const n = Number(id.slice(base.length + 1));
        if (Number.isInteger(n) && n > max)
            max = n;
    }
    return max;
}
// ── DSH 实现 ──────────────────────────────────────────────────────────
export class QQAgentSession {
    host;
    base = "";
    cwd = "";
    persistent = true;
    restore = "recent";
    handle;
    ref;
    disposed = false;
    outboundDelivery;
    constructor(host) {
        this.host = host;
    }
    requireHost() {
        if (!this.host)
            throw new Error("QQAgentSession 未绑定 DSH 宿主（需通过注册表工厂注入）");
        return this.host;
    }
    /** cordis 服务访问（get 语义：可选服务返回 undefined） */
    svc(name) {
        try {
            return this.host?.ctx.get?.(name);
        }
        catch {
            return undefined;
        }
    }
    requireAgents() {
        const agents = this.svc("agents");
        if (!agents)
            throw new Error("DSH agents 服务不可用（插件需在 dsh-base 组合中运行）");
        return agents;
    }
    /**
     * QQ 会话专属工具：qq_send_local_file（agent 作用域注册，仅 QQ 会话可见）。
     * 交付上下文由 router 每回合经 bindOutboundDelivery 绑定到本会话实例。
     */
    setupQQTools(agentCtx) {
        const qqSession = this;
        try {
            const tools = agentCtx.get?.("tools");
            if (!tools)
                return;
            tools.register(defineTool({
                name: "qq_send_local_file",
                description: "Send one real local computer file to the QQ conversation that requested the current task. Use this when the QQ user explicitly asks to send/upload/transfer a local image or file. Provide only the local path.",
                parameters: { path: { type: "string", description: "Local file path returned by a tool or explicitly provided by the user" } },
                output: {
                    schema: { type: "json" },
                    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
                },
                execute: async (args, _exec) => {
                    const delivery = qqSession.outboundDelivery;
                    if (!delivery)
                        throw new Error("No active QQ delivery context (delivery_context_closed)");
                    const record = await delivery.sendLocalFile(args.path ?? "", "auto");
                    return { filename: record.filename, kind: record.kind, bytes: record.bytes, status: record.status };
                },
            }));
        }
        catch {
            // 工具注册失败不阻塞会话创建（出站媒体退化为不可用）
        }
    }
    /** agentPresets 服务窄接口：mount 挂载默认 preset（id 缺省 = settings.yaml agent-presets.default） */
    async mountDefaultPreset(agentCtx) {
        const presets = this.svc("agentPresets");
        if (!presets) {
            throw new Error("agentPresets 服务不可用：QQ 会话无法挂载 preset，工具集将为空");
        }
        // mount 失败会回滚 agent 创建（dsh-agent-presets 语义），保证不会产生空工具集的半成品会话
        await presets.mount(agentCtx);
    }
    /** base64 图片 → dsh-attachment 保存 → ImageBlock（保存失败降级为文本说明） */
    async appendImages(blocks, images) {
        if (!images || images.length === 0)
            return;
        const attachments = this.svc("attachments");
        for (const image of images) {
            try {
                if (!attachments)
                    throw new Error("attachments 服务不可用");
                const data = Buffer.from(image.source.data, "base64");
                const ref = await attachments.saveImage({
                    data,
                    mediaType: image.source.mediaType,
                });
                blocks.push({ type: "image", attachment: ref });
            }
            catch (err) {
                blocks.push({ type: "text", text: `[图片处理失败：${err instanceof Error ? err.message : String(err)}]` });
            }
        }
    }
    isReady() {
        return !!this.handle && !this.disposed;
    }
    isStreaming() {
        const agent = this.handle?.agent;
        return agent?.status === "running";
    }
    /** 创建或恢复 DSH agent（懒创建入口；registry 保证每对话一个实例） */
    async init(cwd, options = {}) {
        this.cwd = cwd;
        this.base = options.sessionId ?? "qq-default";
        this.persistent = options.persistent !== false;
        this.restore = options.restore ?? "recent";
        const persisted = this.persistent ? await this.listPersisted() : [];
        const atCwd = persisted.filter((h) => h.cwd === this.cwd).map((h) => h.id);
        let sessionId;
        let resume = false;
        if (atCwd.length > 0 && this.restore === "recent") {
            // 恢复当前 cwd 下最近（最大 seq）的会话
            atCwd.sort((a, b) => b.localeCompare(a));
            sessionId = atCwd[0];
            resume = true;
        }
        else {
            // 序号基于全部持久化 id（含其他 cwd），杜绝 id 撞车
            sessionId = `${this.base}-${maxSeqOf(persisted.map((h) => h.id), this.base) + 1}`;
        }
        const selection = this.svc("agentDefaultModel")?.currentSelection();
        const agentOptions = selection
            ? { provider: selection.provider, model: selection.model }
            : {};
        const ref = {
            current: selection ?? undefined,
            assembled: undefined,
        };
        const setup = async (agentCtx) => {
            this.requireHost().setupAgent?.(agentCtx);
            this.setupQQTools(agentCtx);
            // 挂载默认 agent preset（settings.yaml agent-presets.default → standard），
            // 否则 agent 工具集为空，只有插件注册的 qq_send_local_file / update_memory
            await this.mountDefaultPreset(agentCtx);
            // 把选择器绑定到 agent 作用域（对下一步骤生效）
            try {
                installModelSelection(agentCtx, ref);
            }
            catch {
                // 绑定失败不阻塞会话创建（模型切换退化为重建时指定）
            }
        };
        const agents = this.requireAgents();
        const handle = resume
            ? (await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup }))
            : (await agents.create({ sessionId: SessionId(sessionId), meta: { cwd }, agentOptions, setup }));
        this.handle = handle;
        this.ref = ref;
    }
    /** 列出本 id 家族的全部持久化会话（不过滤 cwd：序号统计必须全局，防 id 撞车） */
    async listPersisted() {
        const persistence = this.svc("sessionPersistence");
        if (!persistence)
            return [];
        try {
            const headers = await persistence.list();
            return headers
                .filter((h) => typeof h.id === "string" && h.id.startsWith(`${this.base}-`))
                .map((h) => ({ id: h.id, cwd: h.cwd }));
        }
        catch {
            return [];
        }
    }
    requireAgent() {
        if (!this.handle || this.disposed)
            throw new Error("QQ 会话未初始化");
        return this.handle.agent;
    }
    // ── 运行 ─────────────────────────────────────────────────────────────
    async run(prompt, options = {}) {
        const agent = this.requireAgent();
        const session = agent.session;
        if (!session)
            throw new Error("QQ 会话未初始化");
        const observer = options.observer;
        const emit = (event) => {
            try {
                observer?.(event);
            }
            catch {
                // 观察者失败绝不影响 agent 运行
            }
        };
        emit({ kind: "agent_start" });
        await agent.whenIdle();
        const firstSeq = session.seq;
        const blocks = [{ type: "text", text: prompt }];
        await this.appendImages(blocks, options.images);
        agent.followup(createUserMessage({ content: blocks, source: { kind: "user" } }));
        await agent.whenIdle();
        try {
            const sessions = this.svc("sessions");
            if (sessions)
                await sessions.flush(session);
        }
        catch {
            // flush 失败不阻塞返回（持久化由后端尽力而为）
        }
        return summarizeRun(session, firstSeq, emit);
    }
    /** 插嘴：运行中注入下一步骤（DSH 原生 steer） */
    async steer(prompt, options = {}) {
        const agent = this.requireAgent();
        const blocks = [{ type: "text", text: prompt }];
        await this.appendImages(blocks, options.images);
        agent.steer(createUserMessage({ content: blocks, source: { kind: "user" } }));
    }
    clearPendingMessages() {
        const agent = this.requireAgent();
        // 丢弃排队 + steering（保留当前活跃回合的已有结果）
        agent.cancel({ kind: "user" }, { keepInbox: false });
    }
    // ── 会话管理 ─────────────────────────────────────────────────────────
    currentModel() {
        const current = this.ref?.current;
        if (!current)
            return undefined;
        return {
            provider: current.provider,
            id: current.model,
            name: current.model,
            input: [],
            reasoning: false,
        };
    }
    async availableModels() {
        const llm = this.svc("llm");
        if (!llm)
            return [];
        const out = [];
        for (const provider of llm.listProviders()) {
            try {
                const models = await llm.listModels(provider.name);
                for (const model of models) {
                    const info = toModelInfo(model);
                    if (info)
                        out.push({ ...info, provider: provider.name });
                }
            }
            catch {
                // 单 provider 失败跳过
            }
        }
        return out;
    }
    async setModel(provider, modelId) {
        const all = await this.availableModels();
        const target = all.find((m) => m.provider === provider && m.id === modelId);
        if (!target)
            throw new Error(`模型不存在或当前未配置认证：${provider}/${modelId}`);
        if (this.ref) {
            const base = this.ref.current;
            this.ref.current = { provider, model: modelId, reasoningEffort: base?.reasoningEffort };
        }
        return target;
    }
    thinkingLevel() {
        return this.ref?.current?.reasoningEffort ?? "off";
    }
    availableThinkingLevels() {
        return [...THINKING_LEVELS];
    }
    setThinkingLevel(level) {
        const normalized = normalizeThinkingLevel(level);
        if (!normalized)
            throw new Error(`不支持的思考等级：${level}（可选：${THINKING_LEVELS.join("、")}）`);
        if (this.ref) {
            const base = this.ref.current;
            this.ref.current = { provider: base?.provider ?? "", model: base?.model ?? "", reasoningEffort: normalized };
        }
        return normalized;
    }
    /** 新建会话：同对话新 seq 的独立 DSH 会话（旧会话保留可恢复） */
    async newSession(name) {
        this.assertIdle("新建会话");
        if (this.handle)
            await this.handle.dispose().catch(() => undefined);
        this.handle = undefined;
        // 重新 init（restore=new 语义 → 分配新 seq）
        const fresh = new QQAgentSession(this.requireHost());
        await fresh.init(this.cwd, { sessionId: this.base, persistent: this.persistent, restore: "new" });
        this.handle = fresh.handle;
        this.ref = fresh.ref;
        this.disposed = false;
        const normalized = normalizeSessionName(name);
        // 名称归属新会话（旧会话保留原名）
        const newId = fresh.sessionId();
        if (normalized && newId)
            setSessionNameMeta(this.base, newId, normalized);
        return { id: newId, ...(normalized ? { name: normalized } : {}) };
    }
    async listSessions() {
        const persistence = this.svc("sessionPersistence");
        if (!persistence)
            return [];
        try {
            const headers = (await persistence.list())
                .filter((h) => h.cwd === this.cwd && typeof h.id === "string" && h.id.startsWith(`${this.base}-`))
                .sort((a, b) => b.createdAt - a.createdAt);
            const out = [];
            for (const header of headers) {
                let firstMessage = "";
                let messageCount = 0;
                let allMessagesText = "";
                try {
                    const inspected = await persistence.inspect(header.id);
                    for (const event of inspected.events) {
                        if (event.type === "user/message") {
                            const data = event.data;
                            const text = (data.content ?? [])
                                .filter((block) => block.type === "text")
                                .map((block) => block.text ?? "")
                                .join("");
                            if (text) {
                                messageCount += 1;
                                allMessagesText += (allMessagesText ? "\n" : "") + text;
                                if (!firstMessage)
                                    firstMessage = text;
                            }
                        }
                        if (event.type === "assistant/message") {
                            const data = event.data;
                            const text = (data.message?.content ?? [])
                                .filter((block) => block.type === "text")
                                .map((block) => block.text ?? "")
                                .join("");
                            if (text)
                                allMessagesText += (allMessagesText ? "\n" : "") + text;
                        }
                    }
                }
                catch {
                    // inspect 失败保留 header 级信息
                }
                out.push({
                    path: header.id,
                    id: header.id,
                    name: getSessionName(this.base, header.id),
                    created: new Date(header.createdAt),
                    modified: new Date(header.createdAt),
                    messageCount,
                    firstMessage: firstMessage.slice(0, 120),
                    allMessagesText: allMessagesText.slice(0, 4000),
                });
            }
            return out;
        }
        catch {
            return [];
        }
    }
    async resumeSession(path) {
        this.assertIdle("恢复会话");
        if (!path.startsWith(`${this.base}-`))
            throw new Error("目标 QQ 会话不存在或不属于当前对话");
        if (this.handle)
            await this.handle.dispose().catch(() => undefined);
        this.handle = undefined;
        const fresh = new QQAgentSession(this.requireHost());
        // 直接以指定 id 恢复
        const selection = this.svc("agentDefaultModel")?.currentSelection();
        const agentOptions = selection ? { provider: selection.provider, model: selection.model } : {};
        const ref = { current: selection ?? undefined, assembled: undefined };
        const agents = this.requireAgents();
        const handle = (await agents.resume({
            resumeSessionId: SessionId(path),
            agentOptions,
            setup: async (agentCtx) => {
                this.requireHost().setupAgent?.(agentCtx);
                this.setupQQTools(agentCtx);
                await this.mountDefaultPreset(agentCtx);
                try {
                    installModelSelection(agentCtx, ref);
                }
                catch {
                    // 同上
                }
            },
        }));
        this.handle = handle;
        this.ref = ref;
        this.cwd = this.cwd;
        return { id: this.sessionId(), ...(this.sessionName() ? { name: this.sessionName() } : {}) };
    }
    setSessionName(name) {
        const normalized = normalizeSessionName(name);
        if (!normalized)
            throw new Error("会话名称不能为空");
        const id = this.sessionId();
        if (id)
            setSessionNameMeta(this.base, id, normalized);
        return normalized;
    }
    sessionId() {
        return (this.handle?.agent?.id ?? "");
    }
    sessionName() {
        const id = this.sessionId();
        return id ? getSessionName(this.base, id) : undefined;
    }
    async compact(_instructions) {
        this.assertIdle("压缩会话");
        const agent = this.requireAgent();
        const compaction = this.svc("compaction");
        if (!compaction)
            return { tokensBefore: undefined };
        try {
            await compaction.compactNow(agent, new AbortController().signal);
        }
        catch {
            // 压缩失败（忙/无可用范围）不阻塞
        }
        return { tokensBefore: undefined };
    }
    async abort() {
        try {
            this.requireAgent().cancel({ kind: "user" });
        }
        catch {
            // 中止错误在停机路径忽略
        }
    }
    bindOutboundDelivery(context) {
        this.outboundDelivery = context;
    }
    async dispose() {
        this.disposed = true;
        const handle = this.handle;
        this.handle = undefined;
        if (handle) {
            try {
                await handle.dispose();
            }
            catch {
                // 释放失败不阻塞
            }
        }
    }
    assertIdle(action) {
        if (this.isStreaming())
            throw new Error(`当前 QQ 任务仍在执行，无法${action}；请先发送 /stop`);
    }
}
function summarizeRun(session, firstSeq, emit) {
    let text = "";
    const tools = [];
    let lastToolReason;
    for (const event of session.events) {
        if (event.seq < firstSeq)
            continue;
        switch (event.type) {
            case "assistant/message": {
                const data = event.data;
                const joined = (data.message?.content ?? [])
                    .filter((block) => block.type === "text")
                    .map((block) => block.text ?? "")
                    .join("");
                if (joined) {
                    text = joined;
                    emit({ kind: "assistant_delta", delta: joined });
                }
                emit({ kind: "assistant_end" });
                break;
            }
            case "tool/call": {
                const data = event.data;
                const callId = typeof data.callId === "string" ? data.callId : `tool-${tools.length}`;
                const name = typeof data.name === "string" ? data.name : "tool";
                tools.push({ toolCallId: callId, name, args: safeParseJson(data.arguments), isError: false });
                emit({ kind: "tool_start", toolName: name });
                break;
            }
            case "tool/result": {
                const data = event.data;
                const callId = typeof data.callId === "string" ? data.callId : "";
                const tool = tools.find((t) => t.toolCallId === callId);
                if (tool)
                    tool.isError = !!data.error;
                emit({ kind: "tool_end", toolName: tool?.name ?? "tool", isError: !!data.error });
                break;
            }
            case "turn/end": {
                lastToolReason = event.data;
                break;
            }
        }
    }
    if (lastToolReason?.kind === "error") {
        const message = lastToolReason.error?.message ?? "agent turn failed";
        throw new Error(message);
    }
    return { text, tools };
}
function safeParseJson(value) {
    if (typeof value !== "string")
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
//# sourceMappingURL=qq-session.js.map