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

export const QQ_COMMAND_NAMES = new Set([
	"help",
	"status",
	"last",
	"model",
	"thinking",
	"new",
	"sessions",
	"resume",
	"name",
	"compact",
	"stop",
	"workspace", // 实现见 M5；白名单先行
]);

export const QQ_REMOTE_BLOCKED_COMMANDS = new Set([
	"login",
	"logout",
	"theme",
	"settings",
	"quit",
	"exit",
	"reload",
	"tree",
	"fork",
	"clone",
	"clear",
	"redo",
	"undo",
]);

export function isMutatingQQCommand(name: string): boolean {
	return [
		"model",
		"thinking",
		"new",
		"resume",
		"name",
		"compact",
		"stop",
		"workspace",
	].includes(name);
}

export type QQCommandAuthorization =
	| { allowed: true }
	| { allowed: false; reason: string };

export function authorizeQQCommand(
	config: PiQQBridgeConfig,
	msg: QQInboundMessage,
	command: ParsedQQCommand,
): QQCommandAuthorization {
	if (!QQ_COMMAND_NAMES.has(command.name)) {
		return {
			allowed: false,
			reason: QQ_REMOTE_BLOCKED_COMMANDS.has(command.name)
				? `命令 \`/${command.name}\` 只能在受信任的主机终端中执行。QQ 命令只管理隔离的 QQ 会话。`
				: `未知命令 \`/${command.name}\`。`,
		};
	}
	if (
		!config.commands.enabled &&
		!["help", "status", "last"].includes(command.name)
	) {
		return {
			allowed: false,
			reason:
				"当前只允许 `/help`、`/status` 和 `/last`。请在主机配置 `commands.enabled: true`。",
		};
	}
	if (!isMutatingQQCommand(command.name)) return { allowed: true };
	const admins = config.commands.admins;
	if (msg.type === "private") {
		const allowed = admins.includes(msg.userOpenId);
		return allowed
			? { allowed: true }
			: {
					allowed: false,
					reason:
						"你是普通用户，没有 QQ 会话管理权限。请让主机管理员将你加入 `commands.admins`。",
				};
	}
	const allowed =
		config.commands.allowInGroups && admins.includes(msg.userOpenId);
	return allowed
		? { allowed: true }
		: {
				allowed: false,
				reason: "群聊管理命令默认关闭，或你不在 `commands.admins` 中。",
			};
}

// ── 命令状态机 ────────────────────────────────────────────────────

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

export class CommandStateMachine {
	private readonly pending = new Map<string, PendingCommand>();
	private readonly selectionTtlMs: number;
	private readonly confirmationTtlMs: number;

	constructor(options: CommandStateMachineOptions = {}) {
		this.selectionTtlMs = options.selectionTtlMs ?? 300_000;
		this.confirmationTtlMs = options.confirmationTtlMs ?? 120_000;
	}

	/** 设置/覆盖 pending 状态（同对话新命令覆盖旧状态） */
	set(
		conversationKey: string,
		kind: PendingCommandKind,
		command: string,
		state: unknown,
		now = Date.now(),
	): void {
		this.pending.set(conversationKey, {
			kind,
			command,
			state,
			createdAt: now,
			ttlMs:
				kind === "selection" ? this.selectionTtlMs : this.confirmationTtlMs,
		});
	}

	/** 取 pending；TTL 过期静默清除 */
	get(conversationKey: string, now = Date.now()): PendingCommand | undefined {
		const pending = this.pending.get(conversationKey);
		if (!pending) return undefined;
		if (now - pending.createdAt > pending.ttlMs) {
			this.pending.delete(conversationKey);
			return undefined;
		}
		return pending;
	}

	clear(conversationKey: string): void {
		this.pending.delete(conversationKey);
	}

	/** 取并清除（消费一次性确认/选择） */
	take(conversationKey: string, now = Date.now()): PendingCommand | undefined {
		const pending = this.get(conversationKey, now);
		if (pending) this.pending.delete(conversationKey);
		return pending;
	}

	get size(): number {
		return this.pending.size;
	}
}
