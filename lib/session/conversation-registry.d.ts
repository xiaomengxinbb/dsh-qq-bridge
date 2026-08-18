/**
 * 会话注册表（spec §6.5 + M5 workspace 维度）
 * - key = 私聊 user_openid / 群 group_openid
 * - 懒创建 + idleDisposeMs 回收 + maxResident 上限
 * - sessionDir = sha256("pi-qq-bridge\0"+key+"\0"+workspaceName) 前 32 位（P1-10 裁决：
 *   会话历史按 (conversationKey, workspace) 隔离，永不跨 workspace 恢复）
 * - setWorkspace：切换后旧会话 dispose，新 runtime 以新 cwd 创建
 */
import { type QQSessionLike } from "./qq-session.ts";
import type { PiQQBridgeConfig } from "../core/config.ts";
import type { QQInboundMessage } from "../core/types.ts";
export declare function conversationKey(msg: QQInboundMessage): string;
export interface QQSessionFactory {
    create(): QQSessionLike;
}
export interface ConversationEntry {
    key: string;
    session: QQSessionLike;
    lastUsedAt: number;
    initializing?: Promise<void>;
}
export declare class ConversationRegistry {
    private readonly entries;
    private disposed;
    /** 由 DSH session id 反查 QQ 用户 openid(审批转发用) */
    sessionIdToUserOpenId(sessionId: string): string | undefined;
    private readonly config;
    private readonly agentDir;
    private readonly sessionFactory;
    /** 当前 workspace（M5）：name + 绝对路径 */
    private workspace;
    constructor(config: PiQQBridgeConfig, agentDir: string, cwd: string, sessionFactory?: QQSessionFactory, workspace?: {
        name: string;
        path: string;
    });
    /** 当前 workspace 信息（/workspace 展示用） */
    get currentWorkspace(): {
        name: string;
        path: string;
    };
    /**
     * 切换 workspace（spec §7.3）：旧会话全部 dispose（含初始化中的），
     * 新会话以新 cwd 懒创建；模型等配置由 QQAgentSession 重建时继承
     */
    setWorkspace(name: string, path: string): Promise<void>;
    /** 移除某个对话的驻留会话（workspace 切换后旧会话已随 setWorkspace 清理；此方法供未来按需剔除） */
    drop(msg: QQInboundMessage): Promise<void>;
    get(msg: QQInboundMessage): Promise<QQSessionLike>;
    peek(msg: QQInboundMessage): QQSessionLike | undefined;
    get residentCount(): number;
    dispose(): Promise<void>;
    private evictExpired;
    private evictIfNeeded;
    /** DSH 版：会话 id 基座 = sha256("dsh-qq-bridge\0"+key+"\0"+workspacePath) 前 12 位（路径稳定 → id 稳定） */
    private sessionIdFor;
}
//# sourceMappingURL=conversation-registry.d.ts.map