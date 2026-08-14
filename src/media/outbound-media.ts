/**
 * 出站媒体（spec §6.3 + §6.14，M6）
 *
 * qq_send_local_file 工具：agent 把本地文件发回当前 QQ 对话
 * - 校验链：realpath → allowedRoots（OS tmp + 显式配置，不信任 cwd）→ 普通文件 →
 *   硬链接拒绝 → 大小限制 → 读取前后 stat 复检（rename-race）→ base64 上传 → 发送
 * - 目标绑定当前回合（模型不能改 openid/msg_id/msg_seq）；媒体与文字共用回复预算
 * - 错误码见 spec §6.14（outbound_disabled / path_outside_allowed_roots 等）
 */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { type QQApi, QQApiError } from "../gateway/qq-api.ts";
import type { PiQQBridgeConfig } from "../core/config.ts";
import type { QQInboundMessage, QQReplyTarget } from "../core/types.ts";

export type QQOutboundKind = "auto" | "image" | "file";

export interface QQOutboundDeliveryRecord {
	filename: string;
	kind: "image" | "file";
	bytes: number;
	status: "sent" | "failed" | "unknown";
	errorCode?: string;
	note?: string;
}

export interface QQOutboundDeliveryOptions {
	config: PiQQBridgeConfig;
	cwd: string;
	message: QQInboundMessage;
	target: QQReplyTarget;
	api?: QQApi;
	signal?: AbortSignal;
	/** 回复配额：返回 undefined = 已耗尽 */
	reserveMessageSequence(): number | undefined;
}

export class QQOutboundMediaError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "QQOutboundMediaError";
		this.code = code;
	}
}

/** 单次 agent 运行的交付上下文；回合结束 close（防串目标） */
export class QQOutboundDeliveryContext {
	private readonly recordsValue: QQOutboundDeliveryRecord[] = [];
	private sentFiles = 0;
	private totalBytes = 0;
	private closed = false;

	private readonly options: QQOutboundDeliveryOptions;

	constructor(options: QQOutboundDeliveryOptions) {
		this.options = options;
	}

	get records(): readonly QQOutboundDeliveryRecord[] {
		return this.recordsValue;
	}

	close(): void {
		this.closed = true;
	}

	async sendLocalFile(
		inputPath: string,
		requestedKind: QQOutboundKind = "auto",
	): Promise<QQOutboundDeliveryRecord> {
		let opened: Awaited<ReturnType<typeof open>> | undefined;
		let filename = "file";
		let bytes = 0;
		let mediaKind: "image" | "file" =
			requestedKind === "image" ? "image" : "file";
		let phase: "validation" | "upload" | "send" = "validation";
		try {
			this.assertAvailable();
			this.assertAuthorized();
			if (this.sentFiles >= this.options.config.outboundMedia.maxFilesPerTurn) {
				throw new QQOutboundMediaError(
					"turn_file_limit",
					"本回合可发送的文件数量已达到上限",
				);
			}
			if (!this.options.reserveMessageSequence()) {
				throw new QQOutboundMediaError(
					"reply_budget_exhausted",
					"QQ 被动回复配额不足，无法发送媒体",
				);
			}

			const path = await resolveAllowedLocalFile(
				inputPath,
				this.options.cwd,
				this.options.config.outboundMedia.allowedRoots,
			);
			filename = safeFilename(path);
			opened = await open(path, constants.O_RDONLY | noFollowFlag());
			const pinnedPath = await realpath(`/proc/self/fd/${opened.fd}`).catch(
				() => realpath(path),
			);
			if (pinnedPath !== path)
				throw new QQOutboundMediaError(
					"file_changed",
					"文件路径在打开过程中发生变化，请重试",
				);
			const before = await opened.stat();
			if (!before.isFile())
				throw new QQOutboundMediaError("not_regular_file", "目标不是普通文件");
			if (before.nlink > 1)
				throw new QQOutboundMediaError(
					"hardlink_not_allowed",
					"为避免越权读取，不允许发送硬链接文件",
				);
			bytes = before.size;
			if (bytes <= 0)
				throw new QQOutboundMediaError("empty_file", "QQ 富媒体不支持空文件");

			const header = Buffer.alloc(Math.min(16, bytes));
			await opened.read(header, 0, header.length, 0);
			const detectedImage = detectImage(header);
			if (requestedKind === "image" && !detectedImage) {
				throw new QQOutboundMediaError(
					"unsupported_media_type",
					"图片必须是有效的 PNG 或 JPEG 文件",
				);
			}
			mediaKind =
				requestedKind === "file" ? "file" : detectedImage ? "image" : "file";
			if (mediaKind === "image" && !this.options.config.outboundMedia.images) {
				throw new QQOutboundMediaError(
					"outbound_images_disabled",
					"本地图片发送已关闭",
				);
			}
			if (mediaKind === "file" && !this.options.config.outboundMedia.files) {
				throw new QQOutboundMediaError(
					"outbound_files_disabled",
					"本地文件发送已关闭",
				);
			}
			const maxBytes =
				mediaKind === "image"
					? this.options.config.outboundMedia.maxImageBytes
					: this.options.config.outboundMedia.maxFileBytes;
			if (bytes > maxBytes)
				throw new QQOutboundMediaError("file_too_large", `文件超过大小限制`);
			if (
				this.totalBytes + bytes >
				this.options.config.outboundMedia.maxTotalBytes
			) {
				throw new QQOutboundMediaError(
					"turn_total_limit",
					"本回合发送文件的累计大小超过限制",
				);
			}

			if (!this.options.api)
				throw new QQOutboundMediaError("qq_api_unavailable", "QQ API 尚未就绪");
			const fileData = (await opened.readFile()).toString("base64");
			const after = await opened.stat();
			if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
				throw new QQOutboundMediaError(
					"file_changed",
					"文件在读取过程中发生变化，请重试",
				);
			}
			this.assertAvailable();
			phase = "upload";
			const uploaded = await this.options.api.uploadMedia(
				this.options.target,
				mediaKind === "image" ? 1 : 4,
				fileData,
				this.options.signal,
				this.options.config.outboundMedia.uploadTimeoutMs,
			);

			const msgSeq = this.options.reserveMessageSequence();
			if (msgSeq === undefined)
				throw new QQOutboundMediaError(
					"reply_budget_exhausted",
					"QQ 被动回复配额不足，已取消媒体发送",
				);
			phase = "send";
			try {
				await this.options.api.sendMedia(
					this.options.target,
					uploaded.fileInfo,
					msgSeq,
					this.options.signal,
				);
			} catch (err) {
				if (err instanceof QQApiError && !err.requestAccepted) {
					const record = this.failureRecord(
						filename,
						mediaKind,
						bytes,
						"media_send_unknown",
						"网络中断，无法确认 QQ 是否收到文件",
						"unknown",
					);
					throw new QQOutboundMediaError(
						record.errorCode ?? "media_send_unknown",
						record.note ?? "发送结果未知",
					);
				}
				throw err;
			}

			const record: QQOutboundDeliveryRecord = {
				filename,
				kind: mediaKind,
				bytes,
				status: "sent",
			};
			this.recordsValue.push(record);
			this.sentFiles += 1;
			this.totalBytes += bytes;
			return record;
		} catch (err) {
			if (err instanceof QQOutboundMediaError) {
				if (
					!this.recordsValue.some(
						(record) =>
							record.filename === filename && record.errorCode === err.code,
					)
				) {
					this.recordsValue.push(
						this.failureRecord(
							filename,
							mediaKind,
							bytes,
							err.code,
							err.message,
						),
					);
				}
				throw err;
			}
			const normalized = normalizeQQError(err, phase);
			this.failureRecord(filename, mediaKind, bytes, normalized.code, normalized.message);
			throw new QQOutboundMediaError(normalized.code, normalized.message);
		} finally {
			await opened?.close().catch(() => undefined);
		}
	}

	private assertAvailable(): void {
		if (this.closed)
			throw new QQOutboundMediaError(
				"delivery_context_closed",
				"当前 QQ 回合已经结束或被停止",
			);
		if (this.options.signal?.aborted)
			throw new QQOutboundMediaError(
				"delivery_context_closed",
				"当前 QQ 回合已经被停止",
			);
	}

	private assertAuthorized(): void {
		const policy = this.options.config.outboundMedia;
		if (!policy.enabled)
			throw new QQOutboundMediaError(
				"outbound_disabled",
				"电脑文件发送功能尚未启用",
			);
		if (this.options.message.type === "private" && !policy.allowPrivate) {
			throw new QQOutboundMediaError(
				"outbound_private_disabled",
				"私聊文件发送已关闭",
			);
		}
		if (this.options.message.type === "group" && !policy.allowGroups) {
			throw new QQOutboundMediaError(
				"outbound_group_disabled",
				"群聊文件发送已关闭",
			);
		}
		if (
			policy.adminsOnly &&
			!this.options.config.commands.admins.includes(
				this.options.message.userOpenId,
			)
		) {
			throw new QQOutboundMediaError(
				"outbound_not_authorized",
				"只有显式配置的 QQ 管理员可以发送电脑文件",
			);
		}
	}

	private failureRecord(
		filename: string,
		kind: "image" | "file",
		bytes: number,
		errorCode: string,
		note: string,
		status: "failed" | "unknown" = "failed",
	): QQOutboundDeliveryRecord {
		const existing = this.recordsValue.find(
			(record) =>
				record.filename === filename && record.errorCode === errorCode,
		);
		if (existing) return existing;
		const record: QQOutboundDeliveryRecord = {
			filename,
			kind,
			bytes,
			status,
			errorCode,
			note,
		};
		this.recordsValue.push(record);
		return record;
	}
}

/** 路径解析 + allowedRoots 校验（OS tmp + 显式配置；不信任 cwd） */
export async function resolveAllowedLocalFile(
	input: string,
	cwd: string,
	configuredRoots: string[],
): Promise<string> {
	const normalized = normalizeInputPath(input, cwd);
	let candidate: string;
	try {
		candidate = await realpath(normalized);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT")
			throw new QQOutboundMediaError("file_not_found", "本地文件不存在");
		throw new QQOutboundMediaError("path_invalid", "无法解析本地文件路径");
	}
	const rootInputs = [tmpdir(), ...configuredRoots];
	const roots: string[] = [];
	for (const rootInput of rootInputs) {
		try {
			roots.push(await realpath(normalizeInputPath(rootInput, cwd)));
		} catch {
			// 配置的 roots 不存在不扩大权限，忽略
		}
	}
	if (!roots.some((root) => isWithinRoot(candidate, root))) {
		throw new QQOutboundMediaError(
			"path_outside_allowed_roots",
			"文件不在允许发送的目录中",
		);
	}
	return candidate;
}

export function normalizeInputPath(input: string, cwd: string): string {
	let value = input.trim();
	if (value.startsWith("@") && value.length > 1) value = value.slice(1);
	if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new QQOutboundMediaError("path_invalid", "本地文件路径无效");
	}
	// Windows 路径 → WSL 路径（/mnt/c/...）：仅 WSL/Linux 部署需要；
	// Windows 原生 node 下保留盘符路径（realpath 需要原生格式）
	const windows = value.match(/^([a-zA-Z]):[\\/](.*)$/s);
	if (windows && process.platform === "linux")
		value = `/mnt/${windows[1]!.toLowerCase()}/${windows[2]!.replaceAll("\\", "/")}`;
	return resolve(isAbsolute(value) ? value : resolve(cwd, value));
}

function isWithinRoot(candidate: string, root: string): boolean {
	const rel = relative(root, candidate);
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
	);
}

function detectImage(header: Buffer): "png" | "jpeg" | undefined {
	if (
		header.length >= 8 &&
		header
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	)
		return "png";
	if (
		header.length >= 3 &&
		header[0] === 0xff &&
		header[1] === 0xd8 &&
		header[2] === 0xff
	)
		return "jpeg";
	return undefined;
}

function noFollowFlag(): number {
	return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function safeFilename(path: string): string {
	return (
		basename(path.replaceAll("\\", "/"))
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.slice(0, 120) || "file"
	);
}

function normalizeQQError(
	err: unknown,
	phase: "validation" | "upload" | "send",
): { code: string; message: string } {
	if (err instanceof QQApiError) {
		if (err.code === 850019)
			return {
				code: "unsupported_media_type",
				message: "QQ 不支持该富媒体文件格式",
			};
		if (err.status === 429 || err.code === 22009)
			return {
				code: "reply_budget_exhausted",
				message: "QQ 回复频率或配额已达上限",
			};
		return {
			code: phase === "send" ? "media_send_failed" : "media_upload_failed",
			message: sanitizeError(err.message),
		};
	}
	return {
		code: phase === "send" ? "media_send_failed" : "media_upload_failed",
		message: sanitizeError(err instanceof Error ? err.message : String(err)),
	};
}

function sanitizeError(value: string): string {
	return (
		value
			.replace(/[\u0000-\u001f\u007f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 300) || "QQ 富媒体处理失败"
	);
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}
