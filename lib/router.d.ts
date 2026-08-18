import type { QQApi } from "./gateway/qq-api.ts";
import type { PiQQBridgeConfig } from "./core/config.ts";
import { CommandStateMachine } from "./commands/command-controller.ts";
import type { QQAccessRequestStore } from "./commands/access-requests.ts";
import { type AttachmentPipeline } from "./media/attachment-pipeline.ts";
import type { WorkspaceRegistry } from "./session/workspace-registry.ts";
import type { QQInboundMessage } from "./core/types.ts";
import type { QQSessionLike } from "./session/qq-session.ts";
/** 注册表结构接口（ConversationRegistry 结构兼容） */
export interface ConversationRegistryLike {
    get(msg: QQInboundMessage): Promise<QQSessionLike>;
    peek(msg: QQInboundMessage): QQSessionLike | undefined;
    dispose(): Promise<void>;
    /** M5：当前 workspace（/workspace 展示用） */
    readonly currentWorkspace?: {
        name: string;
        path: string;
    };
    /** M5：切换 workspace（旧会话全部 dispose，新会话以新 cwd 创建） */
    setWorkspace?(name: string, path: string): Promise<void>;
}
/** 路由事件（M7 TUI 视图消费；测试可断言） */
export type QQRouterEvent = {
    kind: "queued";
    messageId: string;
    queueSize: number;
} | {
    kind: "run_start";
    messageId: string;
} | {
    kind: "run_end";
    messageId: string;
    ok: boolean;
} | {
    kind: "reply";
    messageId: string;
    msgSeq: number;
    content: string;
} | {
    kind: "access_request";
    userOpenId: string;
    code: string;
} | {
    kind: "command";
    messageId: string;
    name: string;
} | {
    kind: "error";
    messageId: string;
    stage: string;
    message: string;
};
export interface QQRouterOptions {
    /** 每条入站消息被动回复上限（QQ 文档 4/5 冲突，保守取 4） */
    replyBudgetLimit?: number;
    /** 去重 TTL（默认 2h） */
    dedupeTtlMs?: number;
    /** 附件预处理管线（M3；不传则附件消息按无附件处理） */
    attachmentPipeline?: AttachmentPipeline;
    /** Workspace 注册表（M5；不传则 /workspace 提示不可用） */
    workspaceRegistry?: WorkspaceRegistry;
    /** 访问申请存储（未授权私聊入口；不传则直接拒绝） */
    accessRequests?: QQAccessRequestStore;
    /** 命令状态机（selection/confirmation） */
    stateMachine?: CommandStateMachine;
    /** 事件观察者（TUI/测试） */
    onEvent?: (event: QQRouterEvent) => void;
    /** 调试日志（文件输出；诊断用） */
    debugLog?: (message: string) => void;
    /** /status 的网关状态文本提供者（index.ts 接线） */
    statusProvider?: () => string;
}
export declare class QQRouter {
    private readonly queue;
    private readonly dedupe;
    private running;
    private activeSession;
    private activeAbort;
    /** M7：当前运行中的对话（同对话消息可 steering 插嘴） */
    private activeConversation;
    private readonly replyBudgetLimit;
    private readonly maxQueueSize;
    private readonly stateMachine;
    private readonly accessRequests?;
    private readonly onEvent?;
    private readonly statusProvider?;
    private readonly debugLog?;
    private readonly attachmentPipeline?;
    private readonly workspaceRegistry?;
    private readonly recentInbound;
    private readonly recentOutbound;
    private readonly config;
    private readonly registry;
    private readonly api;
    constructor(config: PiQQBridgeConfig, registry: ConversationRegistryLike, api: QQApi, options?: QQRouterOptions);
    handleInbound(msg: QQInboundMessage): void;
    get queueSize(): number;
    isRunning(): boolean;
    clearQueue(): void;
    /**
     * 启动周期"对方正在输入"指示器(仿 Hermes send_typing 的 50s 去抖)。
     * 返回定时器,agent 处理结束(或取消)时调用方 clearInterval。
     */
    private startTypingIndicator;
    private isAuthorized;
    private handleUnauthorized;
    private replyDenied;
    private handleCommand;
    private executeCommand;
    private getConversation;
    private handleModelCommand;
    private switchModel;
    private handleThinkingCommand;
    private handleNewCommand;
    private handleSessionsCommand;
    private handleResumeCommand;
    private doResume;
    private handleNameCommand;
    private handleCompactCommand;
    private handleStopCommand;
    private handleWorkspaceCommand;
    private commandHelp;
    private statusText;
    private lastSummary;
    private helpKeyboard;
    private modelKeyboard;
    /** steering 插嘴：附件走管线后 session.steer（中间回合不回 QQ，聚合回复在 runOne 结束时发送） */
    private steerInto;
    private pump;
    private runOne;
    /** 发送回复（命令/拒绝/申请共用）：分块发送，每块占 1 次配额 */
    private replyToQQ;
    /** 发送日志辅助 */
    private debugSend;
    /** 分块 + Markdown 优先（降级纯文本保持 msg_seq 对齐） */
    private sendFormatted;
    private targetOf;
    private recordInbound;
    private recordOutbound;
    private emit;
}
//# sourceMappingURL=router.d.ts.map