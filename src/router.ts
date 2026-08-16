/**
 * 消息路由（spec §6.7；M1 文本闭环 + M2 命令体系）
 *
 * handleInbound → 去重 → 白名单（未授权走访问申请）→ / 命令控制器 | prompt 队列
 * prompt：FIFO 串行 → 隔离会话 run → progress ack（可选）→ 被动回复（showProcess 摘要）
 */
import { MessageDedupe } from "./session/message-dedupe.ts";
import { ReplyBudget } from "./session/reply-budget.ts";
import type { QQApi } from "./gateway/qq-api.ts";
import type { QQKeyboard } from "./commands/qq-keyboard.ts";
import { formatUserFacingAgentError } from "./core/user-facing.ts";
import type { PiQQBridgeConfig } from "./core/config.ts";
import {
	CommandStateMachine,
	authorizeQQCommand,
} from "./commands/command-controller.ts";
import { parseQQCommand, type ParsedQQCommand } from "./commands/command-parser.ts";
import {
	buildModelPage,
	formatModelPageFallback,
	type QQModelInfo,
} from "./commands/model-pages.ts";
import { buildCommandKeyboard, type QQCommandButton } from "./commands/qq-keyboard.ts";
import type { QQAccessRequestStore } from "./commands/access-requests.ts";
import {
	type AttachmentPipeline,
	formatAttachmentFailures,
	hasUsableAgentInput,
} from "./media/attachment-pipeline.ts";
import type { WorkspaceRegistry } from "./session/workspace-registry.ts";
import { QQOutboundDeliveryContext } from "./media/outbound-media.ts";
import { formatQQReply } from "./reply-formatter.ts";
import type { QQInboundMessage, QQReplyTarget } from "./core/types.ts";
import type { QQSessionInfo, QQSessionLike } from "./session/qq-session.ts";

/** 注册表结构接口（ConversationRegistry 结构兼容） */
export interface ConversationRegistryLike {
	get(msg: QQInboundMessage): Promise<QQSessionLike>;
	peek(msg: QQInboundMessage): QQSessionLike | undefined;
	dispose(): Promise<void>;
	/** M5：当前 workspace（/workspace 展示用） */
	readonly currentWorkspace?: { name: string; path: string };
	/** M5：切换 workspace（旧会话全部 dispose，新会话以新 cwd 创建） */
	setWorkspace?(name: string, path: string): Promise<void>;
}

/** 路由事件（M7 TUI 视图消费；测试可断言） */
export type QQRouterEvent =
	| { kind: "queued"; messageId: string; queueSize: number }
	| { kind: "run_start"; messageId: string }
	| { kind: "run_end"; messageId: string; ok: boolean }
	| { kind: "reply"; messageId: string; msgSeq: number; content: string }
	| { kind: "access_request"; userOpenId: string; code: string }
	| { kind: "command"; messageId: string; name: string }
	| { kind: "error"; messageId: string; stage: string; message: string };

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
	/** 审批桥(按钮/命令审批;不传则 /approve 命令不可用) */
	approvalBridge?: ApprovalBridgeLike;
}

/** ApprovalBridge 的最小接口(避免循环依赖) */
export interface ApprovalBridgeLike {
	handleTextCommand(command: string, operatorOpenId: string): { handled: boolean; approvalId?: string };
	pendingCount: number;
}

interface LastEntry {
	at: number;
	text: string;
}

const LAST_RING_MAX = 20;

export class QQRouter {
	private readonly queue: QQInboundMessage[] = [];
	private readonly dedupe: MessageDedupe;
	private running = false;
	private activeSession: QQSessionLike | undefined;
	private activeAbort: AbortController | undefined;
	/** M7：当前运行中的对话（同对话消息可 steering 插嘴） */
	private activeConversation:
		| { key: string; session: QQSessionLike; accepting: boolean }
		| undefined;
	private readonly replyBudgetLimit: number;
	private readonly maxQueueSize: number;
	private readonly stateMachine: CommandStateMachine;
	private readonly accessRequests?: QQAccessRequestStore;
	private readonly onEvent?: (event: QQRouterEvent) => void;
	private readonly statusProvider?: () => string;
	private readonly debugLog?: (message: string) => void;
	private readonly attachmentPipeline?: AttachmentPipeline;
	private readonly workspaceRegistry?: WorkspaceRegistry;
	private readonly recentInbound: LastEntry[] = [];
	private readonly recentOutbound: LastEntry[] = [];

	private readonly config: PiQQBridgeConfig;
	private readonly registry: ConversationRegistryLike;
	private readonly api: QQApi;
	private readonly approvalBridge?: ApprovalBridgeLike;

	constructor(
		config: PiQQBridgeConfig,
		registry: ConversationRegistryLike,
		api: QQApi,
		options: QQRouterOptions = {},
	) {
		this.config = config;
		this.registry = registry;
		this.api = api;
		this.replyBudgetLimit = options.replyBudgetLimit ?? 4;
		this.dedupe = new MessageDedupe(options.dedupeTtlMs);
		this.maxQueueSize = config.maxQueueSize;
		this.stateMachine =
			options.stateMachine ?? new CommandStateMachine(config.commands);
		this.accessRequests = options.accessRequests;
		this.onEvent = options.onEvent;
		this.statusProvider = options.statusProvider;
		this.debugLog = options.debugLog;
		this.attachmentPipeline = options.attachmentPipeline;
		this.workspaceRegistry = options.workspaceRegistry;
		this.approvalBridge = options.approvalBridge;
	}

	// ── 入站入口 ───────────────────────────────────────────────────

	handleInbound(msg: QQInboundMessage): void {
		this.debugLog?.(`[router] 入站 id=${msg.id.slice(0, 24)} user=${msg.userOpenId} group=${msg.groupOpenId ?? "-"} text=${msg.text.slice(0, 30)}`);
		if (!this.dedupe.admit(msg.id)) {
			this.debugLog?.("[router] 去重丢弃");
			return; // 平台重复推送
		}
		this.recordInbound(msg);
		if (!this.isAuthorized(msg)) {
			this.debugLog?.("[router] 未授权 → 拒绝/申请流程");
			this.handleUnauthorized(msg);
			return;
		}
		this.debugLog?.("[router] 已授权");
		const text = msg.text.trim();
		if (text.startsWith("/")) {
			if (msg.attachments.length > 0) {
				void this.replyToQQ(
					msg,
					"## 命令未执行\n\n管理命令不能与附件同时发送。请单独发送命令，附件没有被下载。",
				);
				return;
			}
			void this.handleCommand(msg, text);
			return;
		}
		// 无文本且无附件 → 忽略（P1-8 裁决）；纯附件消息 M3 入队
		if (!text && msg.attachments.length === 0) return;
		// 同对话运行中 → steering 插嘴（不等旧任务完成）
		const active = this.activeConversation;
		if (active?.accepting && active.key === conversationKeyOf(msg)) {
			void this.steerInto(active, msg);
			return;
		}
		if (this.queue.length >= this.maxQueueSize) return; // 满则丢最新
		this.queue.push(msg);
		this.debugLog?.(`[router] 入队 queue=${this.queue.length}`);
		this.emit({
			kind: "queued",
			messageId: msg.id,
			queueSize: this.queue.length,
		});
		void this.pump();
	}

	// ── 状态查询（/qqbot-status 用） ───────────────────────────────

	get queueSize(): number {
		return this.queue.length;
	}

	isRunning(): boolean {
		return this.running;
	}

	clearQueue(): void {
		this.queue.length = 0;
	}

	// ── 白名单与访问申请 ──────────────────────────────────────────

	private isAuthorized(msg: QQInboundMessage): boolean {
		if (msg.type === "private")
			return this.config.allowUsers.includes(msg.userOpenId);
		return this.config.allowGroups.includes(msg.groupOpenId ?? "");
	}

	private handleUnauthorized(msg: QQInboundMessage): void {
		// spec §6.13：未授权私聊 → 访问申请（附件不下载、正文不入库）
		if (
			msg.type === "private" &&
			this.config.commands.accessRequests &&
			this.accessRequests
		) {
			const admission = this.accessRequests.admit(msg);
			if (admission.request && !admission.suppressed) {
				this.emit({
					kind: "access_request",
					userOpenId: msg.userOpenId,
					code: admission.request.code,
				});
				void this.replyToQQ(
					msg,
					`## 访问申请已提交\n\n审批码：**${admission.request.code}**\n\n请主机管理员执行 \`/qqbot-approve ${admission.request.code} <user|admin>\` 批准（10 分钟内有效）。`,
				);
				return;
			}
		}
		void this.replyDenied(msg);
	}

	private async replyDenied(msg: QQInboundMessage): Promise<void> {
		try {
			await this.replyToQQ(
				msg,
				"抱歉，你没有权限使用此机器人。如需访问请联系管理员。",
			);
		} catch {
			// 拒绝回复失败无需再补救
		}
	}

	// ── 命令控制面（M2） ───────────────────────────────────────────

	private async handleCommand(
		msg: QQInboundMessage,
		text: string,
	): Promise<void> {
		// 审批命令优先: /approve /always /deny → 直接交给审批桥(仿 Hermes 网关拦截)
		if (this.approvalBridge) {
			const cmdName = text.trim().slice(1).split(/[\s]+/)[0]?.toLowerCase();
			if (
				cmdName === "approve" ||
				cmdName === "always" ||
				cmdName === "deny" ||
				cmdName === "yes" ||
				cmdName === "no" ||
				cmdName === "cancel"
			) {
				const result = this.approvalBridge.handleTextCommand(cmdName, msg.userOpenId);
				if (result.handled) {
					await this.replyToQQ(msg, `✅ 审批已处理（${cmdName}）`);
					return;
				}
				// 无挂起审批:继续走普通命令解析(如 /approve 无参数时给帮助)
			}
		}
		let command: ParsedQQCommand | undefined;
		try {
			command = parseQQCommand(text);
		} catch (err) {
			await this.replyToQQ(
				msg,
				`## 命令未执行\n\n${err instanceof Error ? err.message : String(err)}\n\n发送 \`/help\` 查看用法。`,
			);
			return;
		}
		if (!command) return;
		const authorization = authorizeQQCommand(this.config, msg, command);
		if (!authorization.allowed) {
			await this.replyToQQ(
				msg,
				`## 命令未执行\n\n${authorization.reason}\n\n发送 \`/help\` 查看可用命令。`,
			);
			return;
		}
		this.emit({ kind: "command", messageId: msg.id, name: command.name });
		try {
			await this.executeCommand(msg, command);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			this.emit({
				kind: "error",
				messageId: msg.id,
				stage: "command",
				message: detail,
			});
			await this.replyToQQ(
				msg,
				`## 命令未执行\n\n${detail}\n\n当前 QQ 会话仍保持原状态。发送 \`/help ${command.name}\` 查看用法。`,
			);
		}
	}

	private async executeCommand(
		msg: QQInboundMessage,
		command: ParsedQQCommand,
	): Promise<void> {
		switch (command.name) {
			case "help":
				await this.replyToQQ(
					msg,
					this.commandHelp(command.args[0]),
					this.helpKeyboard(msg),
				);
				return;
			case "status":
				await this.replyToQQ(
					msg,
					await this.statusText(msg),
					this.helpKeyboard(msg),
				);
				return;
			case "last":
				await this.replyToQQ(msg, this.lastSummary());
				return;
			case "model":
				await this.handleModelCommand(msg, command.rawArgs);
				return;
			case "thinking":
				await this.handleThinkingCommand(msg, command.args[0]);
				return;
			case "new":
				await this.handleNewCommand(msg, command.rawArgs);
				return;
			case "sessions":
				await this.handleSessionsCommand(msg, command.rawArgs);
				return;
			case "resume":
				await this.handleResumeCommand(msg, command.args[0]);
				return;
			case "name":
				await this.handleNameCommand(msg, command.rawArgs);
				return;
			case "compact":
				await this.handleCompactCommand(msg, command.rawArgs);
				return;
			case "stop":
				await this.handleStopCommand(msg);
				return;
			case "workspace":
				await this.handleWorkspaceCommand(msg, command.args);
				return;
			default:
				await this.replyToQQ(
					msg,
					`## 未知命令\n\n\`/${command.name}\` 不在支持列表中。发送 \`/help\` 查看。`,
				);
		}
	}

	private async getConversation(msg: QQInboundMessage): Promise<QQSessionLike> {
		return this.registry.get(msg);
	}

	private async handleModelCommand(
		msg: QQInboundMessage,
		rawArgs: string,
	): Promise<void> {
		const key = conversationKeyOf(msg);
		// 选择态解析：/model <序号> 且存在 pending selection
		const pending = this.stateMachine.get(key);
		const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 1 && /^\d+$/.test(tokens[0]!)) {
			// 数字参数：必须有选择上下文，否则直接报错（避免被当作搜索词）
			if (pending?.command !== "model") {
				throw new Error(
					"请先发送 /model <关键词> 获取候选列表，再发送 /model <序号> 选择",
				);
			}
			const state = pending.state as { candidates: QQModelInfo[] };
			const index = Number(tokens[0]) - 1;
			const selected = state.candidates[index];
			if (!selected)
				throw new Error("模型序号无效或列表已变化；请重新发送 /model");
			this.stateMachine.clear(key);
			await this.switchModel(msg, selected);
			return;
		}
		const qq = await this.getConversation(msg);
		const current = qq.currentModel();
		const all = await qq.availableModels();
		// 翻页：`/model page 2` 或 `/model <查询> page 2`
		let page = 1;
		if (
			tokens.length >= 2 &&
			/^page$/i.test(tokens.at(-2) ?? "") &&
			/^\d+$/.test(tokens.at(-1) ?? "")
		) {
			page = Math.max(1, Number(tokens.at(-1)));
			tokens.splice(-2, 2);
		}
		const query = tokens.join(" ").trim().toLowerCase();
		if (!query) {
			const modelPage = buildModelPage(
				all,
				page,
				this.config.commands.modelPageSize,
			);
			const lines = [
				"## 当前 QQ 模型",
				"",
				current ? `**${current.provider}/${current.id}**` : "当前没有可用模型",
				current ? `- 输入：${current.input.join("、")}` : "",
				`- 思考等级：${qq.thinkingLevel()}`,
				"",
				`## 可用模型（${modelPage.page}/${modelPage.totalPages}，共 ${modelPage.total} 个）`,
				"",
				...modelPage.models.map(
					(model, index) =>
						`${modelPage.offset + index + 1}. \`${model.provider}/${model.id}\`${model.input.includes("image") ? " · 图片" : ""}${model.reasoning ? " · 推理" : ""}`,
				),
				"",
				formatModelPageFallback(modelPage),
			].filter(Boolean);
			await this.replyToQQ(
				msg,
				lines.join("\n"),
				this.modelKeyboard(msg, modelPage.keyboardRows),
			);
			return;
		}
		// 精确匹配 → 直接切换
		const exact = all.find(
			(model) => `${model.provider}/${model.id}`.toLowerCase() === query,
		);
		if (exact) {
			await this.switchModel(msg, exact);
			return;
		}
		// 模糊匹配 → 分页 + pending selection
		const matches = all.filter((model) => modelMatches(model, query));
		if (!matches.length)
			throw new Error(`没有找到已配置认证且匹配“${rawArgs.trim()}”的模型`);
		this.stateMachine.set(key, "selection", "model", { candidates: matches });
		const lines = [
			"## 未切换模型",
			"",
			`找到 ${matches.length} 个匹配项，发送 \`/model <序号>\` 选择：`,
			"",
			...matches.map(
				(model, index) => `${index + 1}. \`${model.provider}/${model.id}\``,
			),
			"",
			`选择在 ${Math.round(this.config.commands.selectionTtlMs / 1000)} 秒内有效；或发送完整 \`provider/model\` 直接切换。`,
		];
		await this.replyToQQ(msg, lines.join("\n"));
	}

	private async switchModel(
		msg: QQInboundMessage,
		selected: QQModelInfo,
	): Promise<void> {
		const qq = await this.getConversation(msg);
		const result = await qq.setModel(selected.provider, selected.id);
		await this.replyToQQ(
			msg,
			`## 已切换 QQ 会话模型\n\n- 模型：\`${result.provider}/${result.id}\`\n- 输入：${result.input.join("、")}\n- 思考等级：${qq.thinkingLevel()}\n\n继续发送问题即可。`,
			this.helpKeyboard(msg),
		);
	}

	private async handleThinkingCommand(
		msg: QQInboundMessage,
		requested?: string,
	): Promise<void> {
		const qq = await this.getConversation(msg);
		const levels = qq.availableThinkingLevels();
		if (!requested) {
			await this.replyToQQ(
				msg,
				`## QQ 会话思考等级\n\n当前：**${qq.thinkingLevel()}**\n\n可选：${levels.map((level) => `\`${level}\``).join("、")}\n\n示例：\`/thinking high\``,
			);
			return;
		}
		const effective = qq.setThinkingLevel(requested);
		await this.replyToQQ(
			msg,
			`## 已更新 QQ 会话\n\n思考等级：**${effective}**`,
		);
	}

	private async handleNewCommand(
		msg: QQInboundMessage,
		name: string,
	): Promise<void> {
		const qq = await this.getConversation(msg);
		if (qq.isStreaming()) {
			throw new Error("当前 QQ 任务仍在执行；请先发送 /stop，再发送 /new");
		}
		const created = await qq.newSession(name);
		const model = qq.currentModel();
		await this.replyToQQ(
			msg,
			`## 已新建 QQ 会话\n\n- 会话：${created.name ? `**${created.name}**` : "未命名"}\n- ID：\`${created.id.slice(0, 8)}\`\n- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\`\n\n直接发送新任务即可；旧会话仍保存在历史中。`,
			this.helpKeyboard(msg),
		);
	}

	private async handleSessionsCommand(
		msg: QQInboundMessage,
		rawArgs: string,
	): Promise<void> {
		const qq = await this.getConversation(msg);
		const all = await qq.listSessions();
		const query = rawArgs.trim().toLowerCase();
		const sessions = (
			query ? all.filter((s) => sessionMatches(s, query)) : all
		).slice(0, this.config.commands.maxListItems);
		if (!sessions.length) {
			await this.replyToQQ(
				msg,
				"## QQ 会话\n\n没有找到可恢复的历史会话。发送 `/new` 创建一个新会话。",
			);
			return;
		}
		const lines = [
			"## QQ 会话",
			"",
			...sessions.map((s, index) => {
				const when = new Date(s.modified).toLocaleString("zh-CN", {
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
				});
				return `${index + 1}. \`${shortId(s.id)}\`${s.name ? ` **${s.name}**` : ""} · ${s.messageCount} 条 · ${when}${index === 0 ? "（当前）" : ""}`;
			}),
			"",
			`发送 \`/resume <短ID|名称>\` 恢复会话。`,
		];
		await this.replyToQQ(msg, lines.join("\n"));
	}

	private async handleResumeCommand(
		msg: QQInboundMessage,
		selector?: string,
	): Promise<void> {
		const key = conversationKeyOf(msg);
		const pending = this.stateMachine.get(key);
		if (pending?.command === "resume" && selector && /^\d+$/.test(selector)) {
			const state = pending.state as { sessions: QQSessionInfo[] };
			const target = state.sessions[Number(selector) - 1];
			if (!target) throw new Error("序号无效；请重新发送 /resume");
			this.stateMachine.clear(key);
			await this.doResume(msg, target);
			return;
		}
		if (!selector)
			throw new Error("请提供会话短 ID 或名称：/resume <短ID|名称>");
		const qq = await this.getConversation(msg);
		const all = await qq.listSessions();
		const normalized = selector.toLowerCase();
		const matches = all.filter(
			(s) =>
				s.id.toLowerCase().includes(normalized) ||
				(s.name ?? "").toLowerCase().includes(normalized),
		);
		if (!matches.length)
			throw new Error(
				`没有找到匹配“${selector}”的会话；发送 /sessions 查看历史`,
			);
		if (matches.length === 1) {
			await this.doResume(msg, matches[0]!);
			return;
		}
		this.stateMachine.set(key, "selection", "resume", {
			sessions: matches.slice(0, this.config.commands.maxListItems),
		});
		const lines = [
			"## 多个会话匹配",
			"",
			...matches
				.slice(0, this.config.commands.maxListItems)
				.map(
					(s, index) =>
						`${index + 1}. \`${shortId(s.id)}\`${s.name ? ` **${s.name}**` : ""}`,
				),
			"",
			`发送 \`/resume <序号>\` 选择（${Math.round(this.config.commands.selectionTtlMs / 1000)} 秒内有效）。`,
		];
		await this.replyToQQ(msg, lines.join("\n"));
	}

	private async doResume(
		msg: QQInboundMessage,
		target: QQSessionInfo,
	): Promise<void> {
		const qq = await this.getConversation(msg);
		const resumed = await qq.resumeSession(target.path);
		const model = qq.currentModel();
		await this.replyToQQ(
			msg,
			`## 已恢复 QQ 会话\n\n- 会话：${resumed.name ? `**${resumed.name}**` : "未命名"}\n- ID：\`${resumed.id.slice(0, 8)}\`\n- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\`\n\n直接发送任务即可。`,
			this.helpKeyboard(msg),
		);
	}

	private async handleNameCommand(
		msg: QQInboundMessage,
		name: string,
	): Promise<void> {
		const qq = await this.getConversation(msg);
		const effective = qq.setSessionName(name);
		await this.replyToQQ(
			msg,
			`## 已命名 QQ 会话\n\n当前会话：**${effective}**`,
		);
	}

	private async handleCompactCommand(
		msg: QQInboundMessage,
		instructions: string,
	): Promise<void> {
		const qq = await this.getConversation(msg);
		if (qq.isStreaming())
			throw new Error("当前 QQ 任务仍在执行；请先发送 /stop");
		const result = await qq.compact(instructions);
		const tokens =
			result.tokensBefore !== undefined
				? `（压缩前 ${result.tokensBefore} tokens）`
				: "";
		await this.replyToQQ(
			msg,
			`## 已压缩 QQ 会话\n\n上下文已压缩${tokens}，可继续发送任务。`,
		);
	}

	private async handleStopCommand(msg: QQInboundMessage): Promise<void> {
		const removed = this.queue.length;
		this.clearQueue();
		let aborted = false;
		this.activeAbort?.abort(new Error("QQ task stopped"));
		if (this.activeConversation) {
			this.activeConversation.accepting = false;
			this.activeConversation.session.clearPendingMessages?.();
		}
		if (this.activeSession?.isStreaming() === true) {
			await this.activeSession.abort();
			aborted = true;
		}
		this.stateMachine.clear(conversationKeyOf(msg));
		await this.replyToQQ(
			msg,
			aborted || removed > 0
				? `## 已停止 QQ 任务\n\n${aborted ? "当前生成已中止。" : ""}${removed > 0 ? ` 已移除 ${removed} 条待处理消息。` : ""}\n\nQQ 会话历史已保留。`
				: "当前 QQ 会话没有正在执行或等待的任务。",
		);
	}

	private async handleWorkspaceCommand(
		msg: QQInboundMessage,
		args: string[],
	): Promise<void> {
		const registry = this.workspaceRegistry;
		if (!registry) {
			await this.replyToQQ(
				msg,
				"## 工作区不可用\n\n当前未配置 workspaces（配置文件中添加 workspaces 数组）。",
			);
			return;
		}
		const conversation = this.registry;
		// /workspace → 列出
		if (args.length === 0) {
			const current = conversation.currentWorkspace;
			const lines = [
				"## 工作区",
				"",
				`当前：**${current?.name ?? "default"}**（${current?.path ?? "?"}）`,
				"",
				...registry
					.list()
					.map(
						(w) =>
							`- \`${w.name}\`  ${w.path}${w.description ? `（${w.description}）` : ""}`,
					),
				"",
				"发送 /workspace <名称> 切换（需要管理员权限）。",
			];
			await this.replyToQQ(msg, lines.join("\n"), this.helpKeyboard(msg));
			return;
		}
		// /workspace add <name> <path> / remove <name>：管理命令（QQ 侧 admin）
		if (args[0] === "add" || args[0] === "remove") {
			await this.replyToQQ(
				msg,
				"## 命令未执行\n\n`/workspace add|remove` 请在主机终端执行（本地管理员操作）。",
			);
			return;
		}
		// /workspace <name> → 切换（mutating，已由授权矩阵校验 admin）
		const name = args[0]!;
		const resolved = registry.resolve(name);
		if (conversation.currentWorkspace?.name === name) {
			await this.replyToQQ(
				msg,
				`## 工作区\n\n已在 **${name}**（${resolved.path}）。`,
			);
			return;
		}
		await conversation.setWorkspace?.(resolved.name, resolved.path);
		await this.replyToQQ(
			msg,
			`## 已切换工作区\n\n- 工作区：**${resolved.name}**\n- 路径：\`${resolved.path}\`\n- 会话已重置到该目录，直接发送任务即可。`,
			this.helpKeyboard(msg),
		);
	}

	// ── 回复文本辅助 ───────────────────────────────────────────────

	private commandHelp(target?: string): string {
		const help: Record<string, string> = {
			help: "`/help [命令]` — 查看命令列表或单个命令用法",
			status: "`/status` — 查看 QQ 会话、模型、队列与连接状态",
			last: "`/last` — 查看最近的入站/出站摘要",
			model: "`/model [查询|provider/model] [page N]` — 查看或切换模型",
			thinking: "`/thinking [等级]` — 查看或修改思考等级",
			new: "`/new [名称]` — 新建 QQ 会话（旧会话保留）",
			sessions: "`/sessions [关键词]` — 查看/搜索历史会话",
			resume: "`/resume <短ID|名称>` — 恢复历史会话",
			name: "`/name <名称>` — 命名当前会话",
			compact: "`/compact [要求]` — 压缩当前会话上下文",
			stop: "`/stop` — 中止当前任务并清空待处理消息",
			workspace: "`/workspace` — 工作区切换（即将上线）",
		};
		if (target && help[target]) return `## /${target}\n\n${help[target]}`;
		const lines = [
			"## QQ 命令",
			"",
			...Object.entries(help).map(([, text]) => `- ${text}`),
			"",
			"普通文本会作为任务发给 DeepSeek Harness Agent。管理命令需要管理员权限。",
		];
		return lines.join("\n");
	}

	private async statusText(msg: QQInboundMessage): Promise<string> {
		const qq = await this.getConversation(msg);
		const model = qq.currentModel();
		return [
			"## QQ 会话状态",
			"",
			`- 会话：\`${qq.sessionId().slice(0, 8)}\`${qq.sessionName() ? ` **${qq.sessionName()}**` : ""}`,
			`- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\``,
			`- 思考等级：${qq.thinkingLevel()}`,
			`- 队列：${this.queue.length} 条待处理${this.running ? "，运行中" : ""}`,
			this.statusProvider ? `- 网关：${this.statusProvider()}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	private lastSummary(): string {
		const inbound = this.recentInbound
			.slice(-5)
			.map(
				(e) =>
					`- ${new Date(e.at).toLocaleTimeString()} 入站：${truncate(e.text, 40)}`,
			);
		const outbound = this.recentOutbound
			.slice(-5)
			.map(
				(e) =>
					`- ${new Date(e.at).toLocaleTimeString()} 出站：${truncate(e.text, 40)}`,
			);
		const lines = ["## 最近活动", ""];
		if (!inbound.length && !outbound.length) {
			lines.push("（暂无记录）");
			return lines.join("\n");
		}
		if (inbound.length) lines.push("### 入站", ...inbound, "");
		if (outbound.length) lines.push("### 出站", ...outbound);
		return lines.join("\n");
	}

	// ── 键盘 ───────────────────────────────────────────────────────

	private helpKeyboard(msg: QQInboundMessage): QQKeyboard | undefined {
		if (!this.config.commands.buttons) return undefined;
		const rows: QQCommandButton[][] = [
			[
				{ label: "状态", command: "/status" },
				{ label: "新会话", command: "/new" },
			],
			[
				{ label: "模型", command: "/model" },
				{ label: "思考等级", command: "/thinking" },
			],
			[
				{ label: "会话列表", command: "/sessions" },
				{ label: "停止", command: "/stop" },
			],
			[{ label: "帮助", command: "/help" }],
		];
		return buildCommandKeyboard(msg, rows);
	}

	private modelKeyboard(
		msg: QQInboundMessage,
		rows: QQCommandButton[][],
	): QQKeyboard | undefined {
		if (!this.config.commands.buttons) return undefined;
		return buildCommandKeyboard(msg, rows);
	}

	// ── prompt 队列（M1） ──────────────────────────────────────────

	/** steering 插嘴：附件走管线后 session.steer（中间回合不回 QQ，聚合回复在 runOne 结束时发送） */
	private async steerInto(
		active: { key: string; session: QQSessionLike; accepting: boolean },
		msg: QQInboundMessage,
	): Promise<void> {
		try {
			let prompt = msg.text;
			let images: import("./core/types.ts").QQImageContent[] = [];
			if (msg.attachments.length > 0 && this.attachmentPipeline) {
				const controller = new AbortController();
				const prepared = await this.attachmentPipeline.prepare(
					msg,
					controller.signal,
				);
				if (hasUsableAgentInput(msg, prepared.resources)) {
					prompt = prepared.prompt;
					images = prepared.images;
				} else {
					await prepared.cleanup();
					await this.replyToQQ(
						msg,
						formatAttachmentFailures(prepared.resources),
					);
					return;
				}
				await prepared.cleanup();
			}
			await active.session.steer?.(prompt, { images });
		} catch {
			// steering 失败（如任务已结束）→ 重新入队处理
			if (
				this.activeConversation?.key === active.key &&
				this.activeConversation.accepting
			) {
				this.queue.push(msg);
				void this.pump();
			}
		}
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length > 0) {
				const msg = this.queue.shift()!;
				await this.runOne(msg);
			}
		} finally {
			this.running = false;
			this.activeSession = undefined;
		}
	}

	private async runOne(msg: QQInboundMessage): Promise<void> {
		const budget = new ReplyBudget(msg.id, this.replyBudgetLimit);
		const target = this.targetOf(msg);
		const abort = new AbortController();
		this.activeAbort = abort;
		this.emit({ kind: "run_start", messageId: msg.id });
		// progress ack：任务超时未完成 → 先发回执（占 1 次配额）
		const ackTimer =
			this.config.progress.enabled && this.config.progress.ackAfterMs > 0
				? setTimeout(() => {
						if (budget.isExhausted) return;
						const seq = budget.nextSeq();
						if (seq !== undefined) {
							void this.api
								.sendText(target, "已收到，正在处理…", seq)
								.catch(() => {
									// ack 失败不阻塞
								});
						}
					}, this.config.progress.ackAfterMs)
				: undefined;
		let preparedCleanup: (() => Promise<void>) | undefined;
		try {
			let prompt = msg.text;
			let images: import("./core/types.ts").QQImageContent[] = [];
			if (msg.attachments.length > 0 && this.attachmentPipeline) {
				const prepared = await this.attachmentPipeline.prepare(
					msg,
					abort.signal,
				);
				preparedCleanup = prepared.cleanup;
				if (!hasUsableAgentInput(msg, prepared.resources)) {
					await this.replyToQQ(
						msg,
						formatAttachmentFailures(prepared.resources),
					);
					this.emit({ kind: "run_end", messageId: msg.id, ok: false });
					return;
				}
				prompt = prepared.prompt;
				images = prepared.images;
				if (prepared.resources.some((r) => r.status === "rejected")) {
					// 部分失败：告知但不阻断（追加在最终回复前占 1 次配额）
					void this.replyToQQ(
						msg,
						formatAttachmentFailures(prepared.resources),
					);
				}
			}
			const session = await this.registry.get(msg);
			this.activeSession = session;
			this.activeConversation = {
				key: conversationKeyOf(msg),
				session,
				accepting: true,
			};
			// 出站媒体交付上下文（M6）：绑定当前回合；agent 可调用 qq_send_local_file
			const delivery = new QQOutboundDeliveryContext({
				config: this.config,
				cwd: this.registry.currentWorkspace?.path ?? process.cwd(),
				message: msg,
				target,
				api: this.api,
				signal: abort.signal,
				reserveMessageSequence: () =>
					budget.isExhausted ? undefined : budget.nextSeq(),
			});
			session.bindOutboundDelivery?.(delivery);
			const result = await session.run(prompt, { images });
			delivery.close();
			let text = result.text;
			if (this.config.showProcess && result.tools.length > 0) {
				const summary = result.tools
					.slice(0, 6)
					.map((tool) => `- ${tool.isError ? "❌" : "✅"} **${tool.name}**`)
					.join("\n");
				text = `${text}\n\n---\n\n## 执行摘要\n${summary}`;
			}
			if (text) {
				await this.sendFormatted(msg, text, undefined, true, budget);
			}
			this.emit({ kind: "run_end", messageId: msg.id, ok: true });
		} catch (err) {
			this.emit({
				kind: "error",
				messageId: msg.id,
				stage: "run",
				message: String(err),
			});
			if (!budget.isExhausted) {
				const seq = budget.nextSeq();
				if (seq !== undefined) {
					try {
						const errorText = formatUserFacingAgentError(err);
						await this.api.sendText(target, errorText, seq);
						this.recordOutbound(msg, errorText, seq);
					} catch {
						// 回复失败不抛出到 pump（避免队列卡死）
					}
				}
			}
			this.emit({ kind: "run_end", messageId: msg.id, ok: false });
		} finally {
			if (ackTimer) clearTimeout(ackTimer);
			this.activeAbort = undefined;
			this.activeConversation = undefined;
			if (preparedCleanup) await preparedCleanup().catch(() => undefined);
		}
	}

	/** 发送回复（命令/拒绝/申请共用）：分块发送，每块占 1 次配额 */
	private async replyToQQ(
		msg: QQInboundMessage,
		content: string,
		keyboard?: QQKeyboard,
	): Promise<void> {
		await this.sendFormatted(msg, content, keyboard, true);
	}

	/** 发送日志辅助 */
	private debugSend(tag: string, detail: string): void {
		this.debugLog?.(`[router] ${tag} ${detail}`);
	}

	/** 分块 + Markdown 优先（降级纯文本保持 msg_seq 对齐） */
	private async sendFormatted(
		msg: QQInboundMessage,
		content: string,
		keyboard: QQKeyboard | undefined,
		fallbackToPlain: boolean,
		budget?: ReplyBudget,
	): Promise<void> {
		const sharedBudget =
			budget ?? new ReplyBudget(msg.id, this.replyBudgetLimit);
		const target = this.targetOf(msg);
		this.debugSend("sendFormatted", `内容 ${content.length} 字符`);
		const formatted = formatQQReply(content, this.config.replyFormat);
		const chunks = formatted.markdown;
		const plainChunks = formatted.plain;
		this.debugSend("sendFormatted", `分块 ${chunks.length} 块`);
		for (let index = 0; index < chunks.length; index++) {
			if (sharedBudget.isExhausted) break;
			const seq = sharedBudget.nextSeq();
			if (seq === undefined) break;
			const chunk = chunks[index]!;
			const plain = plainChunks[index] ?? chunk;
			try {
				if (this.config.replyFormat === "plain") {
					await this.api.sendText(
						target,
						plain,
						seq,
						index === 0 ? keyboard : undefined,
					);
				} else {
					try {
						await this.api.sendMarkdown(
							target,
							chunk,
							seq,
							index === 0 ? keyboard : undefined,
						);
					} catch (err) {
						if (fallbackToPlain && isMarkdownRejected(err)) {
							// Markdown 被平台拒绝 → 本条与后续全部降级纯文本（msg_seq 对齐）
							await this.api.sendText(
								target,
								plain,
								seq,
								index === 0 ? keyboard : undefined,
							);
							for (let rest = index + 1; rest < chunks.length; rest++) {
								if (sharedBudget.isExhausted) break;
								const restSeq = sharedBudget.nextSeq();
								if (restSeq === undefined) break;
								await this.api.sendText(
									target,
									plainChunks[rest] ?? chunks[rest]!,
									restSeq,
								);
							}
						} else {
							throw err;
						}
						break;
					}
				}
				this.recordOutbound(msg, chunk, seq);
				this.emit({
					kind: "reply",
					messageId: msg.id,
					msgSeq: seq,
					content: chunk,
				});
			} catch (err) {
				// 回复失败不抛出（避免队列卡死）；命令场景由调用方处理
				if (!(err instanceof Error && /Markdown|markdown/i.test(err.message)))
					break;
			}
		}
	}

	private targetOf(msg: QQInboundMessage): QQReplyTarget {
		return {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
		};
	}

	private recordInbound(msg: QQInboundMessage): void {
		this.recentInbound.push({ at: msg.receivedAt, text: msg.text });
		if (this.recentInbound.length > LAST_RING_MAX) this.recentInbound.shift();
	}

	private recordOutbound(
		_msg: QQInboundMessage,
		text: string,
		_seq: number,
	): void {
		this.recentOutbound.push({ at: Date.now(), text });
		if (this.recentOutbound.length > LAST_RING_MAX) this.recentOutbound.shift();
	}

	private emit(event: QQRouterEvent): void {
		try {
			this.onEvent?.(event);
		} catch {
			// 观察者失败不影响路由
		}
	}
}

function isMarkdownRejected(err: unknown): boolean {
	// QQ 平台拒绝 Markdown：msg_type=2 被拒时返回错误（平台无统一 code，按文本特征判断）
	const message = err instanceof Error ? err.message : String(err);
	return /markdown|格式|format|msg_type/i.test(message);
}

// ── 模块级辅助 ────────────────────────────────────────────────────

function conversationKeyOf(msg: QQInboundMessage): string {
	return msg.type === "private"
		? `private:${msg.userOpenId}`
		: `group:${msg.groupOpenId ?? ""}`;
}

function modelMatches(model: QQModelInfo, query: string): boolean {
	const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
	return haystack.includes(query);
}

function sessionMatches(session: QQSessionInfo, query: string): boolean {
	return (
		session.id.toLowerCase().includes(query) ||
		(session.name ?? "").toLowerCase().includes(query) ||
		session.firstMessage.toLowerCase().includes(query)
	);
}

function shortId(id: string): string {
	return id.replace(/[^a-z0-9]/gi, "").slice(0, 8);
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
