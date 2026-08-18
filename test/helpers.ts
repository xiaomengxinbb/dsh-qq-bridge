/**
 * 测试共享工具：完整配置 + 完整功能 fake 会话/注册表/API
 * （QQSessionLike 接口较大，fake 必须实现全部方法）
 */
import { DEFAULT_CONFIG, type PiQQBridgeConfig } from "../src/core/config.ts";
import type { QQApi } from "../src/gateway/qq-api.ts";
import type { QQInboundMessage, QQReplyTarget } from "../src/core/types.ts";
import type {
	QQRunResult,
	QQModelInfo,
	QQSessionInfo,
} from "../src/session/qq-session.ts";
import type { ConversationRegistryLike } from "../src/router.ts";
import type { QQSessionLike } from "../src/session/qq-session.ts";

/** 从 DEFAULT_CONFIG 构造完整配置（默认无管理员、单授权用户可选） */
export function makeTestConfig(
	overrides: Partial<PiQQBridgeConfig> = {},
): PiQQBridgeConfig {
	return {
		...DEFAULT_CONFIG,
		appId: "test-app",
		clientSecret: "test-secret",
		allowUsers: ["user_allowed"],
		allowGroups: [],
		...overrides,
	} as PiQQBridgeConfig;
}

export interface SentMessage {
	target: QQReplyTarget;
	content: string;
	msgSeq: number;
	keyboard?: unknown;
}

export function makeApi(sent: SentMessage[], failWith?: Error): QQApi {
	const push = (
		target: QQReplyTarget,
		content: string,
		msgSeq: number,
		keyboard?: unknown,
	): void => {
		if (failWith) throw failWith;
		sent.push({ target, content, msgSeq, keyboard });
	};
	return {
		async sendText(
			target: QQReplyTarget,
			content: string,
			msgSeq: number,
			keyboard?: unknown,
		): Promise<void> {
			push(target, content, msgSeq, keyboard);
		},
		async sendMarkdown(
			target: QQReplyTarget,
			content: string,
			msgSeq: number,
			keyboard?: unknown,
		): Promise<void> {
			push(target, content, msgSeq, keyboard);
		},
		async sendTyping(): Promise<void> {
			// 合并自 PR #5（对方正在输入）：测试桩静默即可
		},
	} as unknown as QQApi;
}

export interface FakeSessionOpts {
	text?: string;
	error?: Error;
	delayMs?: number;
	onPrompt?: (prompt: string) => void;
	onRun?: (prompt: string, options?: unknown) => void;
	models?: QQModelInfo[];
	thinkingLevel?: string;
	thinkingLevels?: string[];
	sessions?: QQSessionInfo[];
	tools?: QQRunResult["tools"];
	streaming?: boolean;
	/** newSession 调用计数 */
	onNewSession?: () => void;
	onAbort?: () => void;
	onCompact?: () => void;
	onSteer?: (prompt: string) => void;
	onClearPending?: () => void;
}

export class FakeSession implements QQSessionLike {
	private readonly opts: FakeSessionOpts;

	constructor(opts: FakeSessionOpts = {}) {
		this.opts = opts;
	}

	async init(): Promise<void> {}

	isReady(): boolean {
		return true;
	}

	async run(prompt: string, options?: unknown): Promise<QQRunResult> {
		this.opts.onPrompt?.(prompt);
		this.opts.onRun?.(prompt, options);
		if (this.opts.delayMs)
			await new Promise((r) => setTimeout(r, this.opts.delayMs));
		if (this.opts.error) throw this.opts.error;
		return {
			text: this.opts.text ?? "fake answer",
			tools: this.opts.tools ?? [],
		};
	}

	isStreaming(): boolean {
		return this.opts.streaming ?? false;
	}

	async dispose(): Promise<void> {}

	currentModel(): QQModelInfo | undefined {
		return this.opts.models?.[0];
	}

	async availableModels(): Promise<QQModelInfo[]> {
		return this.opts.models ?? [];
	}

	async setModel(provider: string, modelId: string): Promise<QQModelInfo> {
		const found = (this.opts.models ?? []).find(
			(m) => m.provider === provider && m.id === modelId,
		);
		if (!found)
			throw new Error(`模型不存在或当前未配置认证：${provider}/${modelId}`);
		this.opts.models = [
			found,
			...(this.opts.models ?? []).filter((m) => m !== found),
		];
		return found;
	}

	thinkingLevel(): string {
		return this.opts.thinkingLevel ?? "off";
	}

	availableThinkingLevels(): string[] {
		return this.opts.thinkingLevels ?? ["off", "low", "high"];
	}

	setThinkingLevel(level: string): string {
		this.opts.thinkingLevel = level;
		return level;
	}

	async newSession(name?: string): Promise<{ id: string; name?: string }> {
		this.opts.onNewSession?.();
		return {
			id: `new-session-${Math.random().toString(36).slice(2, 8)}`,
			...(name ? { name } : {}),
		};
	}

	async listSessions(): Promise<QQSessionInfo[]> {
		return this.opts.sessions ?? [];
	}

	async resumeSession(path: string): Promise<{ id: string; name?: string }> {
		const target = (this.opts.sessions ?? []).find((s) => s.path === path);
		if (!target) throw new Error("目标 QQ 会话不存在或不属于当前对话");
		return { id: target.id, name: target.name };
	}

	setSessionName(name: string): string {
		return name.trim();
	}

	sessionId(): string {
		return "current-session-id";
	}

	sessionName(): string | undefined {
		return undefined;
	}

	async compact(): Promise<{ tokensBefore?: number }> {
		this.opts.onCompact?.();
		return { tokensBefore: 1000 };
	}

	async abort(): Promise<void> {
		this.opts.onAbort?.();
		this.opts.streaming = false;
	}

	async steer(prompt: string): Promise<void> {
		this.opts.onSteer?.(prompt);
	}

	clearPendingMessages(): void {
		this.opts.onClearPending?.();
	}
}

export class FakeRegistry implements ConversationRegistryLike {
	sessions = new Map<string, FakeSession>();
	created: string[] = [];
	currentWorkspace: { name: string; path: string } = {
		name: "default",
		path: process.cwd(),
	};

	async setWorkspace(name: string, path: string): Promise<void> {
		this.currentWorkspace = { name, path };
		this.sessions.clear();
	}
	private readonly sessionFactory: (key: string) => FakeSession;

	constructor(
		sessionOpts: FakeSessionOpts = {},
		sessionFactory?: (key: string) => FakeSession,
	) {
		this.sessionFactory =
			sessionFactory ?? (() => new FakeSession(sessionOpts));
	}

	async get(msg: QQInboundMessage): Promise<FakeSession> {
		const key =
			msg.type === "private"
				? `private:${msg.userOpenId}`
				: `group:${msg.groupOpenId}`;
		let session = this.sessions.get(key);
		if (!session) {
			session = this.sessionFactory(key);
			this.sessions.set(key, session);
			this.created.push(key);
		}
		return session;
	}

	peek(msg: QQInboundMessage): FakeSession | undefined {
		return this.sessions.get(
			msg.type === "private"
				? `private:${msg.userOpenId}`
				: `group:${msg.groupOpenId}`,
		);
	}

	async dispose(): Promise<void> {}
}

export function msg(
	overrides: Partial<QQInboundMessage> = {},
): QQInboundMessage {
	return {
		id: `m_${Math.random().toString(36).slice(2, 10)}`,
		type: "private",
		text: "hello",
		userOpenId: "user_allowed",
		attachments: [],
		receivedAt: Date.now(),
		...overrides,
	};
}
