import type { QQImageContent } from "../core/types.ts";
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
    create(options: Record<string, unknown>): Promise<{
        agent: unknown;
        dispose(): Promise<void>;
    }>;
    resume(options: Record<string, unknown>): Promise<{
        agent: unknown;
        dispose(): Promise<void>;
    }>;
}
/** sessions 服务窄接口 */
export interface DshSessionsService {
    flush(session: unknown): Promise<boolean>;
}
/** sessionPersistence 服务窄接口 */
export interface DshSessionPersistenceService {
    list(signal?: AbortSignal): Promise<Array<{
        id: string;
        cwd?: string;
        createdAt: number;
    }>>;
    inspect(id: string, signal?: AbortSignal): Promise<{
        meta: unknown;
        events: Array<{
            type: string;
            data: Record<string, unknown>;
        }>;
    }>;
}
/** llm 服务窄接口 */
export interface DshLlmService {
    listProviders(): Array<{
        name: string;
    }>;
    listModels(provider: string): Promise<Array<Record<string, unknown>>>;
}
/** attachments 服务窄接口 */
export interface DshAttachmentsService {
    saveImage(input: {
        data: Uint8Array;
        mediaType: string;
        name?: string;
    }): Promise<{
        attachmentId: string;
    }>;
}
export interface DshHost {
    ctx: DshHostCtx;
    /** QQ 会话专属 setup（Phase 5 注册 qq_send_local_file 工具等） */
    setupAgent?(agentCtx: unknown): void;
}
export interface QQRunResult {
    text: string;
    tools: {
        toolCallId: string;
        name: string;
        args: unknown;
        isError: boolean;
    }[];
}
export type QQAgentRunEvent = {
    kind: "agent_start";
} | {
    kind: "assistant_delta";
    delta: string;
} | {
    kind: "tool_start";
    toolName: string;
} | {
    kind: "tool_end";
    toolName: string;
    isError: boolean;
} | {
    kind: "assistant_end";
};
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
    run(prompt: string, options?: {
        images?: QQImageContent[];
        observer?: QQAgentRunObserver;
    }): Promise<QQRunResult>;
    currentModel(): QQModelInfo | undefined;
    availableModels(): Promise<QQModelInfo[]>;
    setModel(provider: string, modelId: string): Promise<QQModelInfo>;
    thinkingLevel(): string;
    availableThinkingLevels(): string[];
    setThinkingLevel(level: string): string;
    newSession(name?: string): Promise<{
        id: string;
        name?: string;
    }>;
    listSessions(): Promise<QQSessionInfo[]>;
    resumeSession(path: string): Promise<{
        id: string;
        name?: string;
    }>;
    setSessionName(name: string): string;
    sessionId(): string;
    sessionName(): string | undefined;
    compact(instructions?: string): Promise<{
        tokensBefore?: number;
    }>;
    abort(): Promise<void>;
    bindOutboundDelivery?(context?: unknown): void;
    steer?(prompt: string, options?: {
        images?: QQImageContent[];
    }): Promise<void>;
    clearPendingMessages?(): void;
}
export declare function toModelInfo(model: unknown): QQModelInfo | undefined;
/** 会话 id 基座：sha256("dsh-qq-bridge\0"+key+"\0"+workspacePath) 前 12 位。
 * 工作区路径变化 → 新 id 家族（防跨 cwd id 撞车）；路径稳定 → id 稳定可恢复。 */
export declare function sessionIdBase(key: string, workspacePath: string): string;
export declare class QQAgentSession implements QQSessionLike {
    private host;
    private base;
    private cwd;
    private persistent;
    private restore;
    private handle;
    private ref;
    private disposed;
    private outboundDelivery;
    constructor(host?: DshHost);
    private requireHost;
    /** cordis 服务访问（get 语义：可选服务返回 undefined） */
    private svc;
    private requireAgents;
    /**
     * QQ 会话专属工具：qq_send_local_file（agent 作用域注册，仅 QQ 会话可见）。
     * 交付上下文由 router 每回合经 bindOutboundDelivery 绑定到本会话实例。
     */
    private setupQQTools;
    /** agentPresets 服务窄接口：mount 挂载默认 preset（id 缺省 = settings.yaml agent-presets.default） */
    private mountDefaultPreset;
    /** base64 图片 → dsh-attachment 保存 → ImageBlock（保存失败降级为文本说明） */
    private appendImages;
    isReady(): boolean;
    isStreaming(): boolean;
    /** 创建或恢复 DSH agent（懒创建入口；registry 保证每对话一个实例） */
    init(cwd: string, options?: QQSessionOptions): Promise<void>;
    /** 列出本 id 家族的全部持久化会话（不过滤 cwd：序号统计必须全局，防 id 撞车） */
    private listPersisted;
    private requireAgent;
    run(prompt: string, options?: {
        images?: QQImageContent[];
        observer?: QQAgentRunObserver;
    }): Promise<QQRunResult>;
    /** 插嘴：运行中注入下一步骤（DSH 原生 steer） */
    steer(prompt: string, options?: {
        images?: QQImageContent[];
    }): Promise<void>;
    clearPendingMessages(): void;
    currentModel(): QQModelInfo | undefined;
    availableModels(): Promise<QQModelInfo[]>;
    setModel(provider: string, modelId: string): Promise<QQModelInfo>;
    thinkingLevel(): string;
    availableThinkingLevels(): string[];
    setThinkingLevel(level: string): string;
    /** 新建会话：同对话新 seq 的独立 DSH 会话（旧会话保留可恢复） */
    newSession(name?: string): Promise<{
        id: string;
        name?: string;
    }>;
    listSessions(): Promise<QQSessionInfo[]>;
    resumeSession(path: string): Promise<{
        id: string;
        name?: string;
    }>;
    setSessionName(name: string): string;
    sessionId(): string;
    sessionName(): string | undefined;
    compact(_instructions?: string): Promise<{
        tokensBefore?: number;
    }>;
    abort(): Promise<void>;
    bindOutboundDelivery(context?: unknown): void;
    dispose(): Promise<void>;
    private assertIdle;
}
//# sourceMappingURL=qq-session.d.ts.map