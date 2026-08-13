/**
 * 访问申请（spec §6.13，P0-4）
 *
 * - 仅私聊产生申请；申请只记录 OpenID + 消息元数据（redact 正文），附件批准前不下载
 * - code：6 位 base64url；每用户唯一（重复申请返回同一 code）
 * - TTL 10min；maxPending 20 满则压制；deny 后 1h 冷却
 * - 批准落地（原子持久化 + 热生效）由 index.ts 本地命令层负责
 */
import { randomBytes } from "node:crypto";
import type { QQInboundMessage } from "../core/types.ts";

export type QQAccessRole = "user" | "admin";

export interface QQAccessRequest {
	code: string;
	userOpenId: string;
	createdAt: number;
	expiresAt: number;
	/** 原消息元数据（redacted），用于审批后的被动回复 */
	message: QQInboundMessage;
}

export interface QQAccessRequestAdmission {
	request?: QQAccessRequest;
	created: boolean;
	suppressed: boolean;
}

export interface QQAccessRequestStoreOptions {
	ttlMs?: number;
	maxPending?: number;
	denyCooldownMs?: number;
}

export class QQAccessRequestStore {
	private readonly byCode = new Map<string, QQAccessRequest>();
	private readonly codeByUser = new Map<string, string>();
	private readonly deniedUntil = new Map<string, number>();
	private readonly ttlMs: number;
	private readonly maxPending: number;
	private readonly denyCooldownMs: number;

	constructor(options: QQAccessRequestStoreOptions = {}) {
		this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
		this.maxPending = options.maxPending ?? 20;
		this.denyCooldownMs = options.denyCooldownMs ?? 60 * 60 * 1000;
	}

	/** 登记申请。仅私聊；冷却期内/容量满 → suppressed。重复申请返回同一 code。 */
	admit(message: QQInboundMessage, now = Date.now()): QQAccessRequestAdmission {
		this.purge(now);
		if (message.type !== "private") return { created: false, suppressed: true };
		if ((this.deniedUntil.get(message.userOpenId) ?? 0) > now) {
			return { created: false, suppressed: true };
		}
		const existingCode = this.codeByUser.get(message.userOpenId);
		if (existingCode) {
			const existing = this.byCode.get(existingCode);
			if (existing)
				return { request: existing, created: false, suppressed: false };
		}
		if (this.byCode.size >= this.maxPending)
			return { created: false, suppressed: true };
		const request: QQAccessRequest = {
			code: this.createCode(),
			userOpenId: message.userOpenId,
			createdAt: now,
			expiresAt: now + this.ttlMs,
			message: redactRequestMessage(message),
		};
		this.byCode.set(request.code, request);
		this.codeByUser.set(request.userOpenId, request.code);
		return { request, created: true, suppressed: false };
	}

	list(now = Date.now()): QQAccessRequest[] {
		this.purge(now);
		return [...this.byCode.values()].sort(
			(left, right) => left.createdAt - right.createdAt,
		);
	}

	get(code: string, now = Date.now()): QQAccessRequest | undefined {
		this.purge(now);
		return this.byCode.get(normalizeCode(code));
	}

	/** 批准：移除申请并返回（调用方负责持久化配置 + 通知用户） */
	approve(code: string, now = Date.now()): QQAccessRequest | undefined {
		const request = this.get(code, now);
		if (request) this.remove(request);
		return request;
	}

	/** 拒绝：移除申请 + 冷却（冷却期内该用户申请被压制） */
	deny(code: string, now = Date.now()): QQAccessRequest | undefined {
		const request = this.get(code, now);
		if (!request) return undefined;
		this.remove(request);
		this.deniedUntil.set(request.userOpenId, now + this.denyCooldownMs);
		return request;
	}

	get size(): number {
		this.purge(Date.now());
		return this.byCode.size;
	}

	private purge(now: number): void {
		for (const request of this.byCode.values()) {
			if (request.expiresAt <= now) this.remove(request);
		}
		for (const [user, expiry] of this.deniedUntil) {
			if (expiry <= now) this.deniedUntil.delete(user);
		}
	}

	private remove(request: QQAccessRequest): void {
		this.byCode.delete(request.code);
		if (this.codeByUser.get(request.userOpenId) === request.code) {
			this.codeByUser.delete(request.userOpenId);
		}
	}

	private createCode(): string {
		for (;;) {
			const code = randomBytes(5)
				.toString("base64url")
				.toUpperCase()
				.replace(/[-_]/g, "")
				.slice(0, 6);
			if (code.length === 6 && !this.byCode.has(code)) return code;
		}
	}
}

export function normalizeAccessRole(
	value: string | undefined,
): QQAccessRole | undefined {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "user" ||
		normalized === "普通" ||
		normalized === "普通用户"
	)
		return "user";
	if (
		normalized === "admin" ||
		normalized === "管理员" ||
		normalized === "管理"
	)
		return "admin";
	return undefined;
}

function normalizeCode(value: string): string {
	return value.trim().toUpperCase();
}

/** 只保留消息元数据，正文与附件一律清空 */
function redactRequestMessage(message: QQInboundMessage): QQInboundMessage {
	return {
		id: message.id,
		type: "private",
		text: "",
		userOpenId: message.userOpenId,
		attachments: [],
		raw: undefined,
		receivedAt: message.receivedAt,
	};
}
