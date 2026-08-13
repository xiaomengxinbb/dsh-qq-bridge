/**
 * 稳定错误码（spec §6.14，P1-3）
 *
 * 规则：错误码是稳定契约——回复文本可本地化，code 必须原样暴露
 * （status/日志/测试断言）。不允许自由字符串；新错误先加枚举再使用。
 */

/** 入站附件错误码（/qqbot-status 的 lastError 与附件拒绝回复共用） */
export const INBOUND_ERROR_CODES = [
	"invalid_url",
	"ssrf_blocked",
	"dns_failed",
	"download_timeout",
	"size_limit",
	"mime_mismatch",
	"parse_failed",
	"pdf_no_text",
	"page_limit",
	"invalid_encoding",
	"stt_not_configured",
	"stt_key_missing",
	"stt_failed",
	"media_disabled",
	"attachment_count_limit",
	"aborted",
] as const;

export type InboundErrorCode = (typeof INBOUND_ERROR_CODES)[number];

/** 出站媒体错误码（qq_send_local_file 工具，M6 使用） */
export const OUTBOUND_ERROR_CODES = [
	"outbound_disabled",
	"outbound_not_authorized",
	"path_outside_allowed_roots",
	"file_too_large",
	"reply_budget_exhausted",
	"media_upload_failed",
	"media_send_unknown",
] as const;

export type OutboundErrorCode = (typeof OUTBOUND_ERROR_CODES)[number];
