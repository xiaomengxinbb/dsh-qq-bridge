/**
 * 附件内容提取器（spec §6.4）
 * - TXT：UTF-8/UTF-16 有界提取（2MiB / 150k 字符）
 * - PDF：文本层提取（20MiB / 100 页 / 150k 字符），无文本层报 pdf_no_text（不 OCR）
 * - DOC：识别并提示不支持（不把二进制当文本）
 */
import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";

export class AttachmentExtractError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AttachmentExtractError";
		this.code = code;
	}
}

export interface ExtractedText {
	text: string;
	truncated: boolean;
	pages?: number;
}

export async function extractTxt(
	path: string,
	maxChars: number,
): Promise<ExtractedText> {
	const bytes = await readFile(path);
	let text: string;
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	) {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
	} else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		text = decodeUtf16(bytes.subarray(2), true);
	} else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		text = decodeUtf16(bytes.subarray(2), false);
	} else {
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new AttachmentExtractError(
				"invalid_encoding",
				"TXT 不是有效的 UTF-8/UTF-16 文本",
			);
		}
	}
	return truncateText(sanitizeExtractedText(text), maxChars);
}

export async function extractPdf(
	path: string,
	maxPages: number,
	maxChars: number,
): Promise<ExtractedText> {
	const bytes = await readFile(path);
	let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
	try {
		pdf = await getDocumentProxy(new Uint8Array(bytes));
		if (pdf.numPages > maxPages) {
			throw new AttachmentExtractError(
				"page_limit",
				`PDF 页数超过限制（最多 ${maxPages} 页）`,
			);
		}
		const result = await extractText(pdf, { mergePages: true });
		const text = sanitizeExtractedText(result.text);
		if (!text.trim())
			throw new AttachmentExtractError(
				"pdf_no_text",
				"PDF 没有可提取的文本层；当前版本不支持 OCR",
			);
		return { ...truncateText(text, maxChars), pages: result.totalPages };
	} catch (err) {
		if (err instanceof AttachmentExtractError) throw err;
		throw new AttachmentExtractError(
			"parse_failed",
			`PDF 解析失败：${safeError(err)}`,
		);
	} finally {
		const proxy = pdf as unknown as
			| { destroy?: () => Promise<void> }
			| undefined;
		if (proxy?.destroy) await proxy.destroy().catch(() => undefined);
	}
}

function truncateText(text: string, maxChars: number): ExtractedText {
	if (text.length <= maxChars) return { text, truncated: false };
	const marker = "\n\n[内容因长度限制已截断]\n\n";
	const remaining = Math.max(0, maxChars - marker.length);
	const headChars = Math.floor(remaining * 0.75);
	const tailChars = remaining - headChars;
	return {
		text: `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`,
		truncated: true,
	};
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
	const even = bytes.length - (bytes.length % 2);
	const swapped = Buffer.alloc(even);
	for (let i = 0; i < even; i += 2) {
		swapped[i] = littleEndian ? bytes[i] : bytes[i + 1];
		swapped[i + 1] = littleEndian ? bytes[i + 1] : bytes[i];
	}
	try {
		return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
	} catch {
		throw new AttachmentExtractError(
			"invalid_encoding",
			"TXT 不是有效的 UTF-8/UTF-16 文本",
		);
	}
}

function sanitizeExtractedText(text: string): string {
	return text
		.replace(/\u0000/g, "")
		.replace(/\r\n?/g, "\n")
		.trim();
}

function safeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 300);
}

/** 最小可用 PDF（含文本层），用于测试/无 unpdf 依赖时的兜底验证 */
export function makeMinimalPdf(text: string): Uint8Array {
	const escaped = text
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)");
	const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
	const objects = [
		"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
		"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
		`3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`,
		`4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
		"5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
	];
	const body =
		objects.join("\n") + "\ntrailer << /Root 1 0 R /Size 5 >>\n%%EOF";
	return new TextEncoder().encode(`%PDF-1.4\n${body}`);
}
