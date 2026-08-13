/**
 * 用户侧文案辅助（与 Pi SDK 解耦，便于 strip-types 单测）
 */

const SUMMARY_MAX = 120;

/**
 * 从 agent_end 的消息列表中提取最终 assistant 文本。
 * Pi 把 provider 失败记录为 assistant 消息（stopReason=error），这里显式抛错。
 */
export function extractFinalAssistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as
			| {
					role?: string;
					content?: unknown;
					stopReason?: unknown;
					errorMessage?: unknown;
			  }
			| undefined;
		if (!message || message.role !== "assistant") continue;
		if (message.stopReason === "error") {
			const detail =
				typeof message.errorMessage === "string" && message.errorMessage.trim()
					? message.errorMessage.trim()
					: "Agent 未返回可用的错误详情";
			throw new Error(detail);
		}
		return extractText(message.content);
	}
	return "";
}

/** 把原始 agent/runtime 错误映射为短小、用户可读的中文文案（稳定错误码见 spec §6.14） */
export function formatUserFacingAgentError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const msg = raw
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!msg) return "处理失败。错误码：AGENT_RUN_FAILED\n\n请稍后重试。";
	if (/aborted|abort|cancel/i.test(msg))
		return "任务已中止。错误码：TASK_ABORTED";
	if (/401|403|authentication|unauthorized|api key|invalid.*key/i.test(msg)) {
		return "模型服务认证失败。错误码：MODEL_AUTH_FAILED\n\n请检查主机上的模型/API 配置后重试。";
	}
	if (/502|503|504|timeout|ETIMEDOUT|ECONNRESET|upstream|temporar/i.test(msg)) {
		return "模型服务暂时不可用或超时。错误码：MODEL_SERVICE_UNAVAILABLE\n\n请稍后重试。";
	}
	if (/network|ENOTFOUND|fetch failed|socket/i.test(msg)) {
		return "网络异常，暂时无法完成处理。错误码：NETWORK_UNAVAILABLE\n\n请稍后重试。";
	}
	return "处理失败。错误码：AGENT_RUN_FAILED\n\n请稍后重试。";
}

/** 会话预览：剥离 QQ 技术头与附件 XML，压缩为单行摘要 */
export function humanizeSessionPreview(text: string): string {
	if (!text) return "";
	let value = text.replace(/\r\n?/g, "\n");
	value = value.replace(
		/<qq-reply-guidance>[\s\S]*?<\/qq-reply-guidance>/gi,
		"",
	);
	value = value.replace(/<qq-attachments[\s\S]*?<\/qq-attachments>/gi, "");
	value = value.replace(/<qq-voice[\s\S]*?<\/qq-voice>/gi, "");
	value = value.replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi, "");
	const lines = value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^\[QQ\s+(?:private|group)\b/i.test(line))
		.filter((line) => !line.startsWith("<"));
	const joined = lines.join(" ").replace(/\s+/g, " ").trim();
	return truncatePreview(joined);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: string; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: string }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function truncatePreview(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > SUMMARY_MAX
		? `${oneLine.slice(0, SUMMARY_MAX)}…`
		: oneLine;
}
