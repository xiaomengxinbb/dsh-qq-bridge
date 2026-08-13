/**
 * QQ REST 发送 API（spec §6.3，M1：纯文本被动回复）
 * - POST /v2/users/{openid}/messages，msg_type:0，携带 msg_id + msg_seq
 * - 401 → forceRefresh 后重试一次
 * - 错误分类：QQApiError{status, code, requestAccepted}
 */
import type { QQAuth } from "./qq-auth.ts";
import type { QQReplyTarget } from "../core/types.ts";

const PROD_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";

export interface QQApiOptions {
	sandbox: boolean;
	/** API 基础域名覆盖（测试用） */
	apiBase?: string;
}

export class QQApiError extends Error {
	readonly status: number;
	readonly code?: number;
	readonly requestAccepted: boolean;

	constructor(
		message: string,
		status: number,
		code?: number,
		requestAccepted = false,
	) {
		super(message);
		this.name = "QQApiError";
		this.status = status;
		this.code = code;
		this.requestAccepted = requestAccepted;
	}
}

export class QQApi {
	private readonly base: string;

	private readonly auth: QQAuth;

	constructor(auth: QQAuth, options: QQApiOptions) {
		this.auth = auth;
		this.base = options.apiBase ?? (options.sandbox ? SANDBOX_BASE : PROD_BASE);
	}

	/** 纯文本被动回复（msg_type:0，可选键盘） */
	async sendText(
		target: QQReplyTarget,
		content: string,
		msgSeq: number,
		keyboard?: unknown,
	): Promise<void> {
		await this.send(target, {
			content,
			msg_type: 0,
			msg_id: target.msgId,
			msg_seq: msgSeq,
			...(keyboard ? { keyboard } : {}),
		});
	}

	/** Markdown 被动回复（msg_type:2；群聊文档要求 content 非空） */
	async sendMarkdown(target: QQReplyTarget, content: string, msgSeq: number, keyboard?: unknown): Promise<void> {
		await this.send(
			target,
			{
				markdown: { content },
				msg_type: 2,
				msg_id: target.msgId,
				msg_seq: msgSeq,
				...(keyboard ? { keyboard } : {}),
				...(target.type === "group" ? { content: " " } : {}),
			},
		);
	}

	/** 上传本地字节（不主动发送；返回 file_info） */
	async uploadMedia(
		target: QQReplyTarget,
		fileType: 1 | 4,
		fileData: string,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ fileInfo: string; fileUuid?: string; ttl: number }> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/files`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/files`;
		const body = await this.postJson(
			path,
			{ file_type: fileType, file_data: fileData, srv_send_msg: false },
			timeoutMs,
			"media upload",
			signal,
		);
		if (typeof body.file_info !== "string" || !body.file_info) {
			throw new QQApiError("media upload response missing file_info", 502, undefined, true);
		}
		return {
			fileInfo: body.file_info,
			...(typeof body.file_uuid === "string" ? { fileUuid: body.file_uuid } : {}),
			ttl: typeof body.ttl === "number" && Number.isFinite(body.ttl) ? body.ttl : 0,
		};
	}

	/**
	 * 分片上传（spec §6.3 P0-1）：upload_prepare → 逐块 PUT 预签名 → upload_part_finish
	 * 用于超过 base64 阈值的大文件（file_data 有平台硬上限）
	 * 协议字段以 QQ 官方文档为准（spec §3.5 已存档），上线前需沙箱实测
	 */
	async uploadMediaChunked(
		target: QQReplyTarget,
		fileType: 1 | 4,
		filename: string,
		fileSize: number,
		readPart: (offset: number, length: number) => Promise<Uint8Array>,
		options: { maxParts?: number; partConcurrency?: number; prepareTimeoutMs?: number; partTimeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<{ fileInfo: string }> {
		const base =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/files`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/files`;
		const maxParts = options.maxParts ?? 128;
		const concurrency = options.partConcurrency ?? 2;
		const prepareTimeout = options.prepareTimeoutMs ?? 15_000;
		const partTimeout = options.partTimeoutMs ?? 60_000;
		const signal = options.signal;

		// 1. prepare：平台返回分块参数与预签名 URL
		const prepared = await this.postJson(
			`${base}/upload_prepare`,
			{ file_type: fileType, filename, file_size: fileSize },
			prepareTimeout,
			"media upload prepare",
			signal,
		);
		const urls = Array.isArray(prepared.urls) ? (prepared.urls as Array<{ url: string; part_number: number }>) : [];
		const blockSize = typeof prepared.block_size === "number" ? prepared.block_size : 1024 * 1024;
		if (!urls.length) throw new QQApiError("media upload prepare missing urls", 502, undefined, true);

		// 2. 逐块 PUT 预签名地址（并发受限；单块失败重试一次）
		const totalParts = Math.min(Math.ceil(fileSize / blockSize), maxParts);
		const uploadPart = async (partNumber: number): Promise<void> => {
			const offset = (partNumber - 1) * blockSize;
			const length = Math.min(blockSize, fileSize - offset);
			const data = await readPart(offset, length);
			const targetUrl = urls.find((u) => u.part_number === partNumber)?.url ?? urls[partNumber - 1]?.url;
			if (!targetUrl) throw new QQApiError(`media upload part ${partNumber} missing url`, 502, undefined, true);
			let lastErr: unknown;
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const putSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(partTimeout)]) : AbortSignal.timeout(partTimeout);
					const res = await fetch(targetUrl, { method: "PUT", body: data as BodyInit, signal: putSignal });
					if (!res.ok) throw new QQApiError(`media upload part ${partNumber} failed (HTTP ${res.status})`, res.status, undefined, true);
					return;
				} catch (err) {
					lastErr = err;
				}
			}
			throw lastErr instanceof QQApiError ? lastErr : new QQApiError(`media upload part ${partNumber} failed`, 0);
		};
		const parts = Array.from({ length: totalParts }, (_, i) => i + 1);
		for (let index = 0; index < parts.length; index += concurrency) {
			await Promise.all(parts.slice(index, index + concurrency).map(uploadPart));
		}

		// 3. 合并 → file_info
		const finished = await this.postJson(
			`${base}/upload_part_finish`,
			{ file_uuid: prepared.file_uuid, upload_id: prepared.upload_id },
			15_000,
			"media upload finish",
			signal,
		);
		if (typeof finished.file_info !== "string" || !finished.file_info) {
			throw new QQApiError("media upload finish missing file_info", 502, undefined, true);
		}
		return { fileInfo: finished.file_info };
	}

	/** 发送已上传媒体（msg_type:7 被动回复） */
	async sendMedia(target: QQReplyTarget, fileInfo: string, msgSeq: number, signal?: AbortSignal): Promise<void> {
		await this.send(
			target,
			{
				msg_type: 7,
				media: { file_info: fileInfo },
				msg_id: target.msgId,
				msg_seq: msgSeq,
				...(target.type === "group" ? { content: " " } : {}),
			},
			signal,
		);
	}

	private async send(
		target: QQReplyTarget,
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<void> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/messages`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/messages`;
		try {
			await this.postJson(path, payload, 10_000, "send", signal);
		} catch (err) {
			// 401：token 失效，刷新后重试一次
			if (err instanceof QQApiError && err.status === 401) {
				await this.auth.forceRefresh();
				await this.postJson(path, payload, 10_000, "send", signal);
				return;
			}
			throw err;
		}
	}

	private async postJson(
		path: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
		operation: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const token = await this.auth.getToken();
		const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `QQBot ${token}`,
				},
				body: JSON.stringify(payload),
				signal: requestSignal,
			});
		} catch (err) {
			throw new QQApiError(
				`${operation} request failed: ${err instanceof Error ? err.message : String(err)}`,
				0,
			);
		}
		let body: Record<string, unknown> = {};
		try {
			body = (await res.json()) as Record<string, unknown>;
		} catch {
			// 成功发送可能无 body；错误仍由 status 判定
		}
		if (res.ok) return body;
		const code = typeof body.code === "number" ? body.code : undefined;
		const message = typeof body.message === "string" ? body.message : "";
		throw new QQApiError(
			`${operation} failed (status ${res.status}${code != null ? `, code ${code}` : ""})${message ? `: ${message}` : ""}`,
			res.status,
			code,
			true,
		);
	}
}
