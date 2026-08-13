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
import type { QQImageContent, QQInboundMessage } from "../core/types.ts";
import type { PiQQBridgeConfig } from "../core/config.ts";
import { expandHome } from "../core/config.ts";

// ── 宿主上下文（窄接口；完整类型来自 dsh 包 module augmentation） ──────

/**
 * 宿主上下文：cordis Context 的 get() 访问器。
 * 注意：cordis 服务必须经 ctx.get(name) 访问（属性访问需 inject 声明，未声明会抛错）；
 * get() 对可选服务返回 undefined。类型均为窄接口，完整类型见 dsh 包 module augmentation。
 */
export interface DshHostCtx {
  get<T = unknown>(name: string): T | undefined;
}

/** agents 服务窄接口 */
export interface DshAgentsService {
  create(options: Record<string, unknown>): Promise<{ agent: unknown; dispose(): Promise<void> }>;
  resume(options: Record<string, unknown>): Promise<{ agent: unknown; dispose(): Promise<void> }>;
}

/** sessions 服务窄接口 */
export interface DshSessionsService {
  flush(session: unknown): Promise<boolean>;
}

/** sessionPersistence 服务窄接口 */
export interface DshSessionPersistenceService {
  list(signal?: AbortSignal): Promise<Array<{ id: string; cwd?: string; createdAt: number }>>;
  inspect(id: string, signal?: AbortSignal): Promise<{ meta: unknown; events: Array<{ type: string; data: Record<string, unknown> }> }>;
}

/** llm 服务窄接口 */
export interface DshLlmService {
  listProviders(): Array<{ name: string }>;
  listModels(provider: string): Promise<Array<Record<string, unknown>>>;
}

/** attachments 服务窄接口 */
export interface DshAttachmentsService {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<{ attachmentId: string }>;
}

export interface DshHost {
  ctx: DshHostCtx;
  /** QQ 会话专属 setup（Phase 5 注册 qq_send_local_file 工具等） */
  setupAgent?(agentCtx: unknown): void;
}

// ── 运行结果与事件（保持 pi 接口，router 原样消费） ────────────────────

export interface QQRunResult {
  text: string;
  tools: { toolCallId: string; name: string; args: unknown; isError: boolean }[];
}

export type QQAgentRunEvent =
  | { kind: "agent_start" }
  | { kind: "assistant_delta"; delta: string }
  | { kind: "tool_start"; toolName: string }
  | { kind: "tool_end"; toolName: string; isError: boolean }
  | { kind: "assistant_end" };

export type QQAgentRunObserver = (event: QQAgentRunEvent) => void;

export interface QQSessionOptions {
  /** 会话 id 基座（registry 按 对话+工作区 计算）；DSH 版取代 pi 的 sessionDir */
  sessionId?: string;
  persistent?: boolean;
  restore?: "recent" | "new";
}

/** 模型信息（归一化 dsh-llm LlmModelInfo） */
export interface QQModelInfo {
  provider: string;
  id: string;
  name: string;
  input: string[];
  reasoning: boolean;
}

/** 会话信息（listSessions 返回项） */
export interface QQSessionInfo {
  path: string;
  id: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

/** 会话结构接口（registry 创建、router 使用；DSH 实现结构兼容） */
export interface QQSessionLike {
  init(cwd: string, options?: QQSessionOptions): Promise<void>;
  isReady(): boolean;
  isStreaming(): boolean;
  dispose(): Promise<void>;
  run(prompt: string, options?: { images?: QQImageContent[]; observer?: QQAgentRunObserver }): Promise<QQRunResult>;
  currentModel(): QQModelInfo | undefined;
  availableModels(): Promise<QQModelInfo[]>;
  setModel(provider: string, modelId: string): Promise<QQModelInfo>;
  thinkingLevel(): string;
  availableThinkingLevels(): string[];
  setThinkingLevel(level: string): string;
  newSession(name?: string): Promise<{ id: string; name?: string }>;
  listSessions(): Promise<QQSessionInfo[]>;
  resumeSession(path: string): Promise<{ id: string; name?: string }>;
  setSessionName(name: string): string;
  sessionId(): string;
  sessionName(): string | undefined;
  compact(instructions?: string): Promise<{ tokensBefore?: number }>;
  abort(): Promise<void>;
  bindOutboundDelivery?(context?: unknown): void;
  steer?(prompt: string, options?: { images?: QQImageContent[] }): Promise<void>;
  clearPendingMessages?(): void;
}

// ── 会话名元数据（DSH 无会话名概念，桥自管；按会话 id 基座分文件） ──────

interface SessionMetaFile {
  [sessionId: string]: { name?: string };
}

function metaPathFor(base: string): string {
  return join(expandHome("~/.dsh/qq-bridge"), "meta", `${base}.json`);
}

function readMeta(base: string): SessionMetaFile {
  try {
    return JSON.parse(readFileSync(metaPathFor(base), "utf8")) as SessionMetaFile;
  } catch {
    return {};
  }
}

function writeMeta(base: string, meta: SessionMetaFile): void {
  const path = metaPathFor(base);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
}

function getSessionName(base: string, id: string): string | undefined {
  return readMeta(base)[id]?.name;
}

function setSessionNameMeta(base: string, id: string, name: string): void {
  const meta = readMeta(base);
  meta[id] = { ...(meta[id] ?? {}), name };
  writeMeta(base, meta);
}

// ── 归一化 ────────────────────────────────────────────────────────────

export function toModelInfo(model: unknown): QQModelInfo | undefined {
  const m = model as { provider?: unknown; id?: unknown; name?: unknown; input?: unknown; reasoning?: unknown } | undefined;
  if (!m || typeof m.provider !== "string" || typeof m.id !== "string") return undefined;
  return {
    provider: m.provider,
    id: m.id,
    name: typeof m.name === "string" ? m.name : m.id,
    input: Array.isArray(m.input) ? m.input.filter((v): v is string => typeof v === "string") : [],
    reasoning: m.reasoning === true,
  };
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function normalizeThinkingLevel(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(normalized) ? normalized : undefined;
}

function normalizeSessionName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, 60);
  return trimmed || undefined;
}

/** 会话 id 基座：sha256("dsh-qq-bridge\0"+key+"\0"+workspacePath) 前 12 位。
 * 工作区路径变化 → 新 id 家族（防跨 cwd id 撞车）；路径稳定 → id 稳定可恢复。 */
export function sessionIdBase(key: string, workspacePath: string): string {
  return `qq-${createHash("sha256").update(`dsh-qq-bridge\0${key}\0${workspacePath}`).digest("hex").slice(0, 12)}`;
}

function maxSeqOf(ids: string[], base: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(`${base}-`)) continue;
    const n = Number(id.slice(base.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

// ── DSH 实现 ──────────────────────────────────────────────────────────

export class QQAgentSession implements QQSessionLike {
  private host: DshHost | undefined;
  private base = "";
  private cwd = "";
  private persistent = true;
  private restore: "recent" | "new" = "recent";
  private handle: { agent: AgentLike; dispose(): Promise<void> } | undefined;
  private ref: { current: { provider: string; model: string; reasoningEffort?: string } | undefined; assembled: unknown } | undefined;
  private disposed = false;
  private outboundDelivery: unknown;

  constructor(host?: DshHost) {
    this.host = host;
  }

  private requireHost(): DshHost {
    if (!this.host) throw new Error("QQAgentSession 未绑定 DSH 宿主（需通过注册表工厂注入）");
    return this.host;
  }

  /** cordis 服务访问（get 语义：可选服务返回 undefined） */
  private svc<T>(name: string): T | undefined {
    try {
      return this.host?.ctx.get?.(name) as T | undefined;
    } catch {
      return undefined;
    }
  }

  private requireAgents(): DshAgentsService {
    const agents = this.svc<DshAgentsService>("agents");
    if (!agents) throw new Error("DSH agents 服务不可用（插件需在 dsh-base 组合中运行）");
    return agents;
  }

  /**
   * QQ 会话专属工具：qq_send_local_file（agent 作用域注册，仅 QQ 会话可见）。
   * 交付上下文由 router 每回合经 bindOutboundDelivery 绑定到本会话实例。
   */
  private setupQQTools(agentCtx: unknown): void {
    const qqSession = this;
    try {
      const tools = (agentCtx as { get?(name: string): unknown }).get?.("tools") as { register(def: unknown): unknown } | undefined;
      if (!tools) return;
      tools.register(
        defineTool({
          name: "qq_send_local_file",
          description:
            "Send one real local computer file to the QQ conversation that requested the current task. Use this when the QQ user explicitly asks to send/upload/transfer a local image or file. Provide only the local path.",
          parameters: { path: { type: "string", description: "Local file path returned by a tool or explicitly provided by the user" } },
          output: {
            schema: { type: "json" },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
          },
          execute: async (args: { path?: string }, _exec) => {
            const delivery = qqSession.outboundDelivery as
              | { sendLocalFile(path: string, kind: string): Promise<{ filename: string; kind: string; bytes: number; status: string }> }
              | undefined;
            if (!delivery) throw new Error("No active QQ delivery context (delivery_context_closed)");
            const record = await delivery.sendLocalFile(args.path ?? "", "auto");
            return { filename: record.filename, kind: record.kind, bytes: record.bytes, status: record.status };
          },
        }),
      );
    } catch {
      // 工具注册失败不阻塞会话创建（出站媒体退化为不可用）
    }
  }

  /** base64 图片 → dsh-attachment 保存 → ImageBlock（保存失败降级为文本说明） */
  private async appendImages(blocks: Array<Record<string, unknown>>, images?: QQImageContent[]): Promise<void> {
    if (!images || images.length === 0) return;
    const attachments = this.svc<DshAttachmentsService>("attachments");
    for (const image of images) {
      try {
        if (!attachments) throw new Error("attachments 服务不可用");
        const data = Buffer.from(image.source.data, "base64");
        const ref = await attachments.saveImage({
          data,
          mediaType: image.source.mediaType,
        });
        blocks.push({ type: "image", attachment: ref });
      } catch (err) {
        blocks.push({ type: "text", text: `[图片处理失败：${err instanceof Error ? err.message : String(err)}]` });
      }
    }
  }

  isReady(): boolean {
    return !!this.handle && !this.disposed;
  }

  isStreaming(): boolean {
    const agent = this.handle?.agent as { status?: string } | undefined;
    return agent?.status === "running";
  }

  /** 创建或恢复 DSH agent（懒创建入口；registry 保证每对话一个实例） */
  async init(cwd: string, options: QQSessionOptions = {}): Promise<void> {
    this.cwd = cwd;
    this.base = options.sessionId ?? "qq-default";
    this.persistent = options.persistent !== false;
    this.restore = options.restore ?? "recent";
    const persisted = this.persistent ? await this.listPersisted() : [];
    const atCwd = persisted.filter((h) => h.cwd === this.cwd).map((h) => h.id);

    let sessionId: string;
    let resume = false;
    if (atCwd.length > 0 && this.restore === "recent") {
      // 恢复当前 cwd 下最近（最大 seq）的会话
      atCwd.sort((a, b) => b.localeCompare(a));
      sessionId = atCwd[0]!;
      resume = true;
    } else {
      // 序号基于全部持久化 id（含其他 cwd），杜绝 id 撞车
      sessionId = `${this.base}-${maxSeqOf(persisted.map((h) => h.id), this.base) + 1}`;
    }

    const selection = this.svc<{ currentSelection(): { provider: string; model: string; reasoningEffort?: string } }>("agentDefaultModel")?.currentSelection();
    const agentOptions = selection
      ? { provider: selection.provider, model: selection.model }
      : {};
    const ref: { current: { provider: string; model: string; reasoningEffort?: string } | undefined; assembled: unknown } = {
      current: selection ?? undefined,
      assembled: undefined,
    };
    const setup = (agentCtx: unknown): void => {
      this.requireHost().setupAgent?.(agentCtx);
      this.setupQQTools(agentCtx);
      // 把选择器绑定到 agent 作用域（对下一步骤生效）
      try {
        installModelSelection(agentCtx as never, ref as never);
      } catch {
        // 绑定失败不阻塞会话创建（模型切换退化为重建时指定）
      }
    };
    const agents = this.requireAgents();
    const handle = resume
      ? ((await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup })) as { agent: AgentLike; dispose(): Promise<void> })
      : ((await agents.create({ sessionId: SessionId(sessionId), meta: { cwd }, agentOptions, setup })) as { agent: AgentLike; dispose(): Promise<void> });
    this.handle = handle;
    this.ref = ref;
  }

  /** 列出本 id 家族的全部持久化会话（不过滤 cwd：序号统计必须全局，防 id 撞车） */
  private async listPersisted(): Promise<Array<{ id: string; cwd?: string }>> {
    const persistence = this.svc<DshSessionPersistenceService>("sessionPersistence");
    if (!persistence) return [];
    try {
      const headers = await persistence.list();
      return headers
        .filter((h) => typeof h.id === "string" && h.id.startsWith(`${this.base}-`))
        .map((h) => ({ id: h.id, cwd: h.cwd }));
    } catch {
      return [];
    }
  }

  private requireAgent(): AgentLike {
    if (!this.handle || this.disposed) throw new Error("QQ 会话未初始化");
    return this.handle.agent;
  }

  // ── 运行 ─────────────────────────────────────────────────────────────

  async run(prompt: string, options: { images?: QQImageContent[]; observer?: QQAgentRunObserver } = {}): Promise<QQRunResult> {
    const agent = this.requireAgent();
    const session = (agent as { session: SessionLike }).session;
    if (!session) throw new Error("QQ 会话未初始化");
    const observer = options.observer;
    const emit = (event: QQAgentRunEvent): void => {
      try {
        observer?.(event);
      } catch {
        // 观察者失败绝不影响 agent 运行
      }
    };
    emit({ kind: "agent_start" });
    await agent.whenIdle();
    const firstSeq = session.seq;
    const blocks: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    await this.appendImages(blocks, options.images);
    agent.followup(createUserMessage({ content: blocks as never, source: { kind: "user" } }));
    await agent.whenIdle();
    try {
      const sessions = this.svc<DshSessionsService>("sessions");
      if (sessions) await sessions.flush(session);
    } catch {
      // flush 失败不阻塞返回（持久化由后端尽力而为）
    }
    return summarizeRun(session, firstSeq, emit);
  }

  /** 插嘴：运行中注入下一步骤（DSH 原生 steer） */
  async steer(prompt: string, options: { images?: QQImageContent[] } = {}): Promise<void> {
    const agent = this.requireAgent();
    const blocks: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    await this.appendImages(blocks, options.images);
    agent.steer(createUserMessage({ content: blocks as never, source: { kind: "user" } }));
  }

  clearPendingMessages(): void {
    const agent = this.requireAgent();
    // 丢弃排队 + steering（保留当前活跃回合的已有结果）
    agent.cancel({ kind: "user" }, { keepInbox: false });
  }

  // ── 会话管理 ─────────────────────────────────────────────────────────

  currentModel(): QQModelInfo | undefined {
    const current = this.ref?.current;
    if (!current) return undefined;
    return {
      provider: current.provider,
      id: current.model,
      name: current.model,
      input: [],
      reasoning: false,
    };
  }

  async availableModels(): Promise<QQModelInfo[]> {
    const llm = this.svc<DshLlmService>("llm");
    if (!llm) return [];
    const out: QQModelInfo[] = [];
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.name);
        for (const model of models) {
          const info = toModelInfo(model);
          if (info) out.push({ ...info, provider: provider.name });
        }
      } catch {
        // 单 provider 失败跳过
      }
    }
    return out;
  }

  async setModel(provider: string, modelId: string): Promise<QQModelInfo> {
    const all = await this.availableModels();
    const target = all.find((m) => m.provider === provider && m.id === modelId);
    if (!target) throw new Error(`模型不存在或当前未配置认证：${provider}/${modelId}`);
    if (this.ref) {
      const base = this.ref.current;
      this.ref.current = { provider, model: modelId, reasoningEffort: base?.reasoningEffort };
    }
    return target;
  }

  thinkingLevel(): string {
    return this.ref?.current?.reasoningEffort ?? "off";
  }

  availableThinkingLevels(): string[] {
    return [...THINKING_LEVELS];
  }

  setThinkingLevel(level: string): string {
    const normalized = normalizeThinkingLevel(level);
    if (!normalized) throw new Error(`不支持的思考等级：${level}（可选：${THINKING_LEVELS.join("、")}）`);
    if (this.ref) {
      const base = this.ref.current;
      this.ref.current = { provider: base?.provider ?? "", model: base?.model ?? "", reasoningEffort: normalized };
    }
    return normalized;
  }

  /** 新建会话：同对话新 seq 的独立 DSH 会话（旧会话保留可恢复） */
  async newSession(name?: string): Promise<{ id: string; name?: string }> {
    this.assertIdle("新建会话");
    if (this.handle) await this.handle.dispose().catch(() => undefined);
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
    if (normalized && newId) setSessionNameMeta(this.base, newId, normalized);
    return { id: newId, ...(normalized ? { name: normalized } : {}) };
  }

  async listSessions(): Promise<QQSessionInfo[]> {
    const persistence = this.svc<DshSessionPersistenceService>("sessionPersistence");
    if (!persistence) return [];
    try {
      const headers = (await persistence.list())
        .filter((h) => h.cwd === this.cwd && typeof h.id === "string" && h.id.startsWith(`${this.base}-`))
        .sort((a, b) => b.createdAt - a.createdAt);
      const out: QQSessionInfo[] = [];
      for (const header of headers) {
        let firstMessage = "";
        let messageCount = 0;
        let allMessagesText = "";
        try {
          const inspected = await persistence.inspect(header.id);
          for (const event of inspected.events) {
            if (event.type === "user/message") {
              const data = event.data as { content?: Array<{ type?: string; text?: string }> };
              const text = (data.content ?? [])
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("");
              if (text) {
                messageCount += 1;
                allMessagesText += (allMessagesText ? "\n" : "") + text;
                if (!firstMessage) firstMessage = text;
              }
            }
            if (event.type === "assistant/message") {
              const data = event.data as { message?: { content?: Array<{ type?: string; text?: string }> } };
              const text = (data.message?.content ?? [])
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("");
              if (text) allMessagesText += (allMessagesText ? "\n" : "") + text;
            }
          }
        } catch {
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
    } catch {
      return [];
    }
  }

  async resumeSession(path: string): Promise<{ id: string; name?: string }> {
    this.assertIdle("恢复会话");
    if (!path.startsWith(`${this.base}-`)) throw new Error("目标 QQ 会话不存在或不属于当前对话");
    if (this.handle) await this.handle.dispose().catch(() => undefined);
    this.handle = undefined;
    const fresh = new QQAgentSession(this.requireHost());
    // 直接以指定 id 恢复
    const selection = this.svc<{ currentSelection(): { provider: string; model: string; reasoningEffort?: string } }>("agentDefaultModel")?.currentSelection();
    const agentOptions = selection ? { provider: selection.provider, model: selection.model } : {};
    const ref = { current: selection ?? undefined, assembled: undefined };
    const agents = this.requireAgents();
    const handle = (await agents.resume({
      resumeSessionId: SessionId(path),
      agentOptions,
      setup: (agentCtx: unknown) => {
        this.requireHost().setupAgent?.(agentCtx);
        try {
          installModelSelection(agentCtx as never, ref as never);
        } catch {
          // 同上
        }
      },
    })) as { agent: AgentLike; dispose(): Promise<void> };
    this.handle = handle;
    this.ref = ref;
    this.cwd = this.cwd;
    return { id: this.sessionId(), ...(this.sessionName() ? { name: this.sessionName() } : {}) };
  }

  setSessionName(name: string): string {
    const normalized = normalizeSessionName(name);
    if (!normalized) throw new Error("会话名称不能为空");
    const id = this.sessionId();
    if (id) setSessionNameMeta(this.base, id, normalized);
    return normalized;
  }

  sessionId(): string {
    return ((this.handle?.agent as { id?: string } | undefined)?.id ?? "") as string;
  }

  sessionName(): string | undefined {
    const id = this.sessionId();
    return id ? getSessionName(this.base, id) : undefined;
  }

  async compact(_instructions?: string): Promise<{ tokensBefore?: number }> {
    this.assertIdle("压缩会话");
    const agent = this.requireAgent();
    const compaction = this.svc<{ compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<unknown> }>("compaction");
    if (!compaction) return { tokensBefore: undefined };
    try {
      await compaction.compactNow(agent, new AbortController().signal);
    } catch {
      // 压缩失败（忙/无可用范围）不阻塞
    }
    return { tokensBefore: undefined };
  }

  async abort(): Promise<void> {
    try {
      this.requireAgent().cancel({ kind: "user" });
    } catch {
      // 中止错误在停机路径忽略
    }
  }

  bindOutboundDelivery(context?: unknown): void {
    this.outboundDelivery = context;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const handle = this.handle;
    this.handle = undefined;
    if (handle) {
      try {
        await handle.dispose();
      } catch {
        // 释放失败不阻塞
      }
    }
  }

  private assertIdle(action: string): void {
    if (this.isStreaming()) throw new Error(`当前 QQ 任务仍在执行，无法${action}；请先发送 /stop`);
  }
}

// ── 内部类型与摘要 ──────────────────────────────────────────────────────

interface AgentLike {
  id?: string;
  status?: string;
  session: SessionLike;
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
  steer(message: unknown): void;
  cancel(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;
}

interface SessionLike {
  seq: number;
  events: Array<{
    seq: number;
    type: string;
    data: Record<string, unknown>;
  }>;
}

function summarizeRun(
  session: SessionLike,
  firstSeq: number,
  emit: (event: QQAgentRunEvent) => void,
): QQRunResult {
  let text = "";
  const tools: QQRunResult["tools"] = [];
  let lastToolReason: { kind: string; error?: { message?: string } } | undefined;
  for (const event of session.events) {
    if (event.seq < firstSeq) continue;
    switch (event.type) {
      case "assistant/message": {
        const data = event.data as { message?: { content?: Array<{ type?: string; text?: string }> } };
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
        const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown };
        const callId = typeof data.callId === "string" ? data.callId : `tool-${tools.length}`;
        const name = typeof data.name === "string" ? data.name : "tool";
        tools.push({ toolCallId: callId, name, args: safeParseJson(data.arguments), isError: false });
        emit({ kind: "tool_start", toolName: name });
        break;
      }
      case "tool/result": {
        const data = event.data as { callId?: unknown; error?: unknown };
        const callId = typeof data.callId === "string" ? data.callId : "";
        const tool = tools.find((t) => t.toolCallId === callId);
        if (tool) tool.isError = !!data.error;
        emit({ kind: "tool_end", toolName: tool?.name ?? "tool", isError: !!data.error });
        break;
      }
      case "turn/end": {
        lastToolReason = event.data as { kind: string; error?: { message?: string } };
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

function safeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
