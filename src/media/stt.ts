/**
 * 可选 STT（spec §6.4：OpenAI-compatible /audio/transcriptions）
 * 密钥只从环境变量读取（media.voice.stt.apiKeyEnv），绝不写配置
 */
import { readFile } from "node:fs/promises";
import type { QQMediaSttConfig } from "../core/types.ts";

export class SttError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SttError";
		this.code = code;
	}
}

export interface SttInput {
	path: string;
	filename: string;
	mimeType: string;
}

export async function transcribeOpenAI(
	input: SttInput,
	config: QQMediaSttConfig,
	outerSignal: AbortSignal,
): Promise<string> {
	const key = process.env[config.apiKeyEnv ?? "QQBOT_STT_API_KEY"];
	if (!key)
		throw new SttError(
			"stt_key_missing",
			`未设置 STT 密钥环境变量 ${config.apiKeyEnv ?? "QQBOT_STT_API_KEY"}`,
		);
	if (!config.baseUrl)
		throw new SttError("stt_not_configured", "STT baseUrl 未配置");

	const controller = new AbortController();
	const onAbort = () => controller.abort(outerSignal.reason);
	outerSignal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error("stt timeout")),
		config.timeoutMs ?? 60_000,
	);
	try {
		const bytes = await readFile(input.path);
		const form = new FormData();
		form.append("model", config.model ?? "whisper-1");
		form.append(
			"file",
			new Blob([bytes], { type: input.mimeType }),
			input.filename,
		);
		let response: Response;
		try {
			response = await fetch(
				`${config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${key}` },
					body: form,
					signal: controller.signal,
				},
			);
		} catch (err) {
			if (outerSignal.aborted) throw new SttError("aborted", "语音处理已取消");
			if (controller.signal.aborted)
				throw new SttError("stt_timeout", "语音转写超时");
			throw new SttError("stt_failed", `语音转写请求失败：${safeError(err)}`);
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new SttError(
				"stt_http_error",
				`语音转写服务返回 HTTP ${response.status}`,
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new SttError("stt_invalid_response", "语音转写服务返回了无效 JSON");
		}
		const text = (body as { text?: unknown })?.text;
		if (typeof text !== "string" || !text.trim())
			throw new SttError("stt_empty", "语音转写没有返回文本");
		return text.trim();
	} finally {
		clearTimeout(timer);
		outerSignal.removeEventListener("abort", onAbort);
	}
}

function safeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 200);
}
