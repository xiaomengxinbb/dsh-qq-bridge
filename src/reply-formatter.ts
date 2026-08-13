/**
 * 回复格式（spec §6.9）
 * - normalizeMarkdown：\r\n 归一、控制字符清理、宽表格转列表
 * - chunkMarkdown：语义边界（标题/段落/列表/代码围栏）切分，UTF-8 ≤3600B/块，最多 4 块
 * - 降级：QQ Markdown 拒绝 → 纯文本（同步切块保证 msg_seq 对齐）
 * - 排版：结论→关键点→注意事项；风险用引用块
 */
import { Buffer } from "node:buffer";

export const QQ_MARKDOWN_CHUNK_BYTES = 3600;
export const QQ_PLAIN_CHUNK_BYTES = 3600;
export const QQ_MAX_REPLY_CHUNKS = 4;
const MAX_SOURCE_BYTES = 14_000;
const PART_LABEL_RESERVE_BYTES = 80;

export interface FormattedQQReply {
	markdown: string[];
	plain: string[];
	truncated: boolean;
}

export function formatQQReply(
	text: string,
	mode: "auto" | "plain",
): FormattedQQReply {
	const normalized = normalizeMarkdown(text);
	const source = truncateUtf8(normalized, MAX_SOURCE_BYTES);
	const markdownChunks = chunkMarkdown(
		source.text,
		QQ_MARKDOWN_CHUNK_BYTES - PART_LABEL_RESERVE_BYTES,
		QQ_MAX_REPLY_CHUNKS,
	);
	const markdown = withPartLabels(markdownChunks, true);
	// 降级按 Markdown 分块逐块转换，保证 msg_seq 与分块编号对齐
	const plain = withPartLabels(markdownChunks.map(markdownToPlain), false);
	return {
		markdown: mode === "plain" ? plain : markdown,
		plain,
		truncated: source.truncated,
	};
}

export function normalizeMarkdown(value: string): string {
	let text = value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim();
	text = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
	text = convertMarkdownTables(text);
	return text || "（无文本回复）";
}

export function chunkMarkdown(
	text: string,
	maxBytes: number,
	maxChunks: number,
): string[] {
	if (utf8Bytes(text) <= maxBytes) return [text];
	const blocks = attachHeadings(parseMarkdownBlocks(text));
	const chunks: string[] = [];
	let current = "";

	const flush = (): void => {
		const value = current.trim();
		if (value) chunks.push(value);
		current = "";
	};

	for (const block of blocks) {
		if (chunks.length >= maxChunks) break;
		// 标题归属其后内容，绝不落在上一块尾部
		if (/^#{1,6}\s+/.test(block) && current) flush();
		const separator = current ? "\n\n" : "";
		if (utf8Bytes(`${current}${separator}${block}`) <= maxBytes) {
			current += `${separator}${block}`;
			continue;
		}
		flush();
		if (chunks.length >= maxChunks) break;
		if (utf8Bytes(block) <= maxBytes) {
			current = block;
			continue;
		}
		const pieces = block.startsWith("```")
			? splitFencedBlock(block, maxBytes)
			: splitSemantic(block, maxBytes);
		for (const piece of pieces) {
			if (chunks.length >= maxChunks) break;
			if (!current) current = piece;
			else if (utf8Bytes(`${current}\n\n${piece}`) <= maxBytes)
				current += `\n\n${piece}`;
			else {
				flush();
				if (chunks.length < maxChunks) current = piece;
			}
		}
	}
	if (chunks.length < maxChunks) flush();

	const representedBytes = chunks.reduce(
		(total, chunk) => total + utf8Bytes(chunk),
		0,
	);
	if (representedBytes < utf8Bytes(text) && chunks.length) {
		chunks[chunks.length - 1] = appendWithinBudget(
			chunks[chunks.length - 1]!,
			"\n\n> ⚠️ 回复过长，后续内容已省略。",
			maxBytes,
		);
	}
	return chunks.slice(0, maxChunks);
}

export function chunkPlainText(
	text: string,
	maxBytes: number,
	maxChunks: number,
): string[] {
	if (utf8Bytes(text) <= maxBytes) return [text];
	const pieces = splitSemantic(text, maxBytes);
	const chunks: string[] = [];
	for (const piece of pieces) {
		if (chunks.length >= maxChunks) break;
		const last = chunks[chunks.length - 1];
		if (last && utf8Bytes(`${last}\n\n${piece}`) <= maxBytes)
			chunks[chunks.length - 1] = `${last}\n\n${piece}`;
		else chunks.push(piece);
	}
	if (
		chunks.reduce((total, chunk) => total + utf8Bytes(chunk), 0) <
			utf8Bytes(text) &&
		chunks.length
	) {
		chunks[chunks.length - 1] = appendWithinBudget(
			chunks[chunks.length - 1]!,
			"\n\n⚠️ 回复过长，后续内容已省略。",
			maxBytes,
		);
	}
	return chunks;
}

export function markdownToPlain(markdown: string): string {
	return normalizeMarkdown(
		markdown
			.replace(/^```[^\n]*\n?/gm, "")
			.replace(/^```\s*$/gm, "")
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/^>\s?/gm, "注意：")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1（$2）")
			.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
			.replace(/___([^_]+)___/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/~~([^~]+)~~/g, "$1")
			.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
			.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
			.replace(/`([^`\n]+)`/g, "$1")
			.replace(/^\s*[*+-]\s+/gm, "• ")
			.replace(/^\s*\*{3,}\s*$/gm, "────────"),
	);
}

// ── 内部辅助 ──────────────────────────────────────────────────────

function convertMarkdownTables(text: string): string {
	const lines = text.split("\n");
	const output: string[] = [];
	let inFence = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (/^```/.test(line.trimStart())) {
			inFence = !inFence;
			output.push(line);
			continue;
		}
		if (
			!inFence &&
			index + 1 < lines.length &&
			isTableRow(line) &&
			isTableDelimiter(lines[index + 1]!)
		) {
			const headers = parseTableRow(line);
			const rows: string[][] = [];
			let rowIndex = index + 2;
			while (
				rowIndex < lines.length &&
				isTableRow(lines[rowIndex]!) &&
				lines[rowIndex]!.trim()
			) {
				rows.push(parseTableRow(lines[rowIndex]!));
				rowIndex++;
			}
			index = rowIndex - 1;
			if (headers.length >= 2 && rows.length) {
				for (const row of rows) {
					const first = row[0] ?? "";
					output.push(`- **${escapeMarkdownLabel(headers[0]!)}：**${first}`);
					for (let column = 1; column < headers.length; column++) {
						const value = row[column] ?? "";
						if (value)
							output.push(
								`  - **${escapeMarkdownLabel(headers[column]!)}：**${value}`,
							);
					}
				}
				continue;
			}
		}
		output.push(line);
	}
	return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function isTableRow(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.includes("|") && (trimmed.startsWith("|") || trimmed.endsWith("|"))
	);
}

function isTableDelimiter(line: string): boolean {
	const cells = parseTableRow(line);
	return (
		cells.length >= 2 &&
		cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")))
	);
}

function parseTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/[*_`]/g, "").trim() || "字段";
}

function attachHeadings(blocks: string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index]!;
		if (
			/^#{1,6}\s+/.test(block) &&
			index + 1 < blocks.length &&
			!blocks[index + 1]!.startsWith("```")
		) {
			result.push(`${block}\n\n${blocks[++index]}`);
		} else result.push(block);
	}
	return result;
}

function parseMarkdownBlocks(text: string): string[] {
	const lines = text.split("\n");
	const blocks: string[] = [];
	let current: string[] = [];
	let inFence = false;
	const flush = (): void => {
		const value = current.join("\n").trim();
		if (value) blocks.push(value);
		current = [];
	};
	for (const line of lines) {
		if (/^```/.test(line.trimStart())) {
			if (inFence && /^```\s*$/.test(line.trim())) {
				// 围栏闭合行：与内容一起 flush
				current.push(line);
				flush();
				inFence = false;
				continue;
			}
			flush();
			current.push(line);
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			current.push(line);
			if (/^```\s*$/.test(line.trim())) flush();
			continue;
		}
		if (/^\s*$/.test(line)) {
			flush();
			continue;
		}
		current.push(line);
	}
	flush();
	return blocks;
}

function splitFencedBlock(block: string, maxBytes: number): string[] {
	const lines = block.split("\n");
	const opening = lines[0] ?? "```";
	const closing = "```";
	const contentLines = lines.slice(1, -1);
	const pieces: string[] = [];
	let current = opening;
	let currentBytes = utf8Bytes(opening);
	for (const line of contentLines) {
		const candidate = `${current}\n${line}`;
		if (utf8Bytes(candidate) + utf8Bytes(closing) <= maxBytes) {
			current = candidate;
			currentBytes = utf8Bytes(current);
		} else {
			pieces.push(`${current}\n${closing}`);
			current = opening;
			currentBytes = utf8Bytes(opening);
			// 单行超限：硬切行内
			if (
				utf8Bytes(line) >
				maxBytes - utf8Bytes(opening) - utf8Bytes(closing)
			) {
				const chunks = splitLine(
					line,
					maxBytes - utf8Bytes(opening) - utf8Bytes(closing),
				);
				for (const chunk of chunks) {
					if (pieces.length >= QQ_MAX_REPLY_CHUNKS) break;
					pieces.push(`${opening}\n${chunk}\n${closing}`);
				}
				current = "";
				currentBytes = 0;
			} else {
				current = `${opening}\n${line}`;
				currentBytes = utf8Bytes(current);
			}
		}
	}
	if (current && currentBytes > 0) pieces.push(`${current}\n${closing}`);
	return pieces;
}

function splitSemantic(text: string, maxBytes: number): string[] {
	const lines = text.split("\n");
	const pieces: string[] = [];
	let current = "";
	for (const line of lines) {
		if (utf8Bytes(`${current}${current ? "\n" : ""}${line}`) <= maxBytes) {
			current += `${current ? "\n" : ""}${line}`;
			continue;
		}
		if (current) {
			pieces.push(current);
			current = "";
		}
		if (utf8Bytes(line) > maxBytes) {
			for (const chunk of splitLine(line, maxBytes)) pieces.push(chunk);
		} else current = line;
	}
	if (current) pieces.push(current);
	return pieces;
}

function splitLine(line: string, maxBytes: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const char of line) {
		if (utf8Bytes(`${current}${char}`) > maxBytes) {
			chunks.push(current);
			current = char;
		} else current += char;
	}
	if (current) chunks.push(current);
	return chunks;
}

function withPartLabels(chunks: string[], markdown: boolean): string[] {
	if (chunks.length <= 1) return chunks;
	const label = markdown ? "回答" : "回复";
	return chunks.map((chunk, index) => {
		const marker = markdown
			? `> 📄 ${label}（${index + 1}/${chunks.length}）\n\n`
			: `${label}（${index + 1}/${chunks.length}）\n\n`;
		return `${marker}${chunk}`;
	});
}

function appendWithinBudget(
	chunk: string,
	suffix: string,
	maxBytes: number,
): string {
	const remaining = maxBytes - utf8Bytes(chunk);
	if (remaining <= 0) return chunk;
	return (
		chunk +
		(utf8Bytes(suffix) <= remaining
			? suffix
			: suffix.slice(0, Math.max(0, remaining)))
	);
}

function truncateUtf8(
	value: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	if (utf8Bytes(value) <= maxBytes) return { text: value, truncated: false };
	let bytes = 0;
	let index = 0;
	for (; index < value.length; index++) {
		const charBytes = utf8Bytes(value[index]!);
		if (bytes + charBytes > maxBytes) break;
		bytes += charBytes;
	}
	return { text: value.slice(0, index), truncated: true };
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}
