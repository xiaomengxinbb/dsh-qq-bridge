/**
 * 会话注册表（spec §6.5 + M5 workspace 维度）
 * - key = 私聊 user_openid / 群 group_openid
 * - 懒创建 + idleDisposeMs 回收 + maxResident 上限
 * - sessionDir = sha256("pi-qq-bridge\0"+key+"\0"+workspaceName) 前 32 位（P1-10 裁决：
 *   会话历史按 (conversationKey, workspace) 隔离，永不跨 workspace 恢复）
 * - setWorkspace：切换后旧会话 dispose，新 runtime 以新 cwd 创建
 */
import { QQAgentSession, sessionIdBase, type QQSessionLike } from "./qq-session.ts";
import type { PiQQBridgeConfig } from "../core/config.ts";
import type { QQInboundMessage } from "../core/types.ts";

export function conversationKey(msg: QQInboundMessage): string {
	return msg.type === "private"
		? `private:${msg.userOpenId}`
		: `group:${msg.groupOpenId ?? ""}`;
}

export interface QQSessionFactory {
	create(): QQSessionLike;
}

export interface ConversationEntry {
	key: string;
	session: QQSessionLike;
	lastUsedAt: number;
	initializing?: Promise<void>;
}

export class ConversationRegistry {
	private readonly entries = new Map<string, ConversationEntry>();
	private disposed = false;

	/** 由 DSH session id 反查 QQ 用户 openid(审批转发用) */
	sessionIdToUserOpenId(sessionId: string): string | undefined {
		for (const [key, entry] of this.entries) {
			if (entry.session.sessionId() !== sessionId) continue;
			// key = private:{user_openid} / group:{group_openid}
			if (key.startsWith("private:")) return key.slice("private:".length);
			if (key.startsWith("group:")) return key.slice("group:".length);
		}
		return undefined;
	}

	private readonly config: PiQQBridgeConfig;
	private readonly agentDir: string;
	private readonly sessionFactory: QQSessionFactory;
	/** 当前 workspace（M5）：name + 绝对路径 */
	private workspace: { name: string; path: string };

	constructor(
		config: PiQQBridgeConfig,
		agentDir: string,
		cwd: string,
		sessionFactory: QQSessionFactory = { create: () => new QQAgentSession() },
		workspace: { name: string; path: string } = { name: "default", path: cwd },
	) {
		this.config = config;
		this.agentDir = agentDir;
		this.sessionFactory = sessionFactory;
		this.workspace = workspace;
	}

	/** 当前 workspace 信息（/workspace 展示用） */
	get currentWorkspace(): { name: string; path: string } {
		return this.workspace;
	}

	/**
	 * 切换 workspace（spec §7.3）：旧会话全部 dispose（含初始化中的），
	 * 新会话以新 cwd 懒创建；模型等配置由 QQAgentSession 重建时继承
	 */
	async setWorkspace(name: string, path: string): Promise<void> {
		if (this.workspace.name === name) return;
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const entry of entries) {
			await entry.initializing?.catch(() => undefined);
			await entry.session.dispose();
		}
		this.workspace = { name, path };
	}

	/** 移除某个对话的驻留会话（workspace 切换后旧会话已随 setWorkspace 清理；此方法供未来按需剔除） */
	async drop(msg: QQInboundMessage): Promise<void> {
		const key = conversationKey(msg);
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		await entry.initializing?.catch(() => undefined);
		await entry.session.dispose();
	}

	async get(msg: QQInboundMessage): Promise<QQSessionLike> {
		if (this.disposed) throw new Error("QQ 会话注册表已释放");
		await this.evictExpired();
		const key = conversationKey(msg);
		let entry = this.entries.get(key);
		if (!entry) {
			await this.evictIfNeeded();
			entry = {
				key,
				session: this.sessionFactory.create(),
				lastUsedAt: Date.now(),
			};
			this.entries.set(key, entry);
			const sessionId =
				this.config.sessions.mode === "persistent"
					? this.sessionIdFor(key)
					: undefined;
			entry.initializing = (async () => {
				await entry?.session.init(this.workspace.path, {
					sessionId,
					persistent: this.config.sessions.mode === "persistent",
					restore: this.config.sessions.restore,
				});
			})();
		}
		try {
			await entry.initializing;
		} catch (err) {
			if (this.entries.get(key) === entry) this.entries.delete(key);
			await entry.session.dispose();
			throw err;
		}
		entry.initializing = undefined;
		entry.lastUsedAt = Date.now();
		return entry.session;
	}

	peek(msg: QQInboundMessage): QQSessionLike | undefined {
		return this.entries.get(conversationKey(msg))?.session;
	}

	get residentCount(): number {
		return this.entries.size;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const entry of entries) {
			await entry.initializing?.catch(() => undefined);
			await entry.session.dispose();
		}
	}

	private async evictExpired(): Promise<void> {
		const cutoff = Date.now() - this.config.sessions.idleDisposeMs;
		const expired = [...this.entries.values()].filter(
			(entry) =>
				entry.lastUsedAt < cutoff &&
				!entry.session.isStreaming() &&
				!entry.initializing,
		);
		for (const entry of expired) {
			if (this.entries.get(entry.key) !== entry) continue;
			this.entries.delete(entry.key);
			await entry.session.dispose();
		}
	}

	private async evictIfNeeded(): Promise<void> {
		const maxResident = this.config.sessions.maxResident;
		if (this.entries.size < maxResident) return;
		const idle = [...this.entries.values()]
			.filter((entry) => !entry.session.isStreaming())
			.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
		if (!idle) throw new Error("QQ 会话资源已满且全部在运行，请稍后重试");
		this.entries.delete(idle.key);
		await idle.session.dispose();
	}

	/** DSH 版：会话 id 基座 = sha256("dsh-qq-bridge\0"+key+"\0"+workspacePath) 前 12 位（路径稳定 → id 稳定） */
	private sessionIdFor(key: string): string {
		return sessionIdBase(key, this.workspace.path);
	}
}
