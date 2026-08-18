/**
 * QQ 侧命令白名单与权限（spec §6.8）+ 命令状态机（P0-3）
 *
 * 状态机：QQ 没有终端式回车确认，多步命令需要显式 pending 状态。
 *   selection    — /model 候选选择、/sessions 候选选择、/resume 消歧（selectionTtlMs）
 *   confirmation — /new（提示保留旧会话）、/workspace 切换、admin 二次确认（confirmationTtlMs）
 */
import type { PiQQBridgeConfig } from "../core/config.ts";
import type { QQInboundMessage } from "../core/types.ts";
import type { ParsedQQCommand } from "./command-parser.ts";
export declare const QQ_COMMAND_NAMES: Set<string>;
export declare const QQ_REMOTE_BLOCKED_COMMANDS: Set<string>;
export declare function isMutatingQQCommand(name: string): boolean;
export type QQCommandAuthorization = {
    allowed: true;
} | {
    allowed: false;
    reason: string;
};
export declare function authorizeQQCommand(config: PiQQBridgeConfig, msg: QQInboundMessage, command: ParsedQQCommand): QQCommandAuthorization;
export type PendingCommandKind = "selection" | "confirmation";
export interface PendingCommand {
    kind: PendingCommandKind;
    command: string;
    /** 命令私有状态（如候选列表、目标） */
    state: unknown;
    createdAt: number;
    ttlMs: number;
}
export interface CommandStateMachineOptions {
    selectionTtlMs?: number;
    confirmationTtlMs?: number;
}
export declare class CommandStateMachine {
    private readonly pending;
    private readonly selectionTtlMs;
    private readonly confirmationTtlMs;
    constructor(options?: CommandStateMachineOptions);
    /** 设置/覆盖 pending 状态（同对话新命令覆盖旧状态） */
    set(conversationKey: string, kind: PendingCommandKind, command: string, state: unknown, now?: number): void;
    /** 取 pending；TTL 过期静默清除 */
    get(conversationKey: string, now?: number): PendingCommand | undefined;
    clear(conversationKey: string): void;
    /** 取并清除（消费一次性确认/选择） */
    take(conversationKey: string, now?: number): PendingCommand | undefined;
    get size(): number;
}
//# sourceMappingURL=command-controller.d.ts.map