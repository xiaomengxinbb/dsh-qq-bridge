/**
 * 回复格式单测（spec §10.1 reply-formatter.test.ts）
 * 分块字节边界（CJK）、代码围栏完整性、表格转列表、Markdown→纯文本降级、对齐
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	formatQQReply,
	normalizeMarkdown,
	chunkMarkdown,
	markdownToPlain,
	QQ_MAX_REPLY_CHUNKS,
	QQ_MARKDOWN_CHUNK_BYTES,
} from "../src/reply-formatter.ts";

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

test("formatQQReply：短回复单块无编号", () => {
	const formatted = formatQQReply("你好，这是回复", "auto");
	assert.equal(formatted.markdown.length, 1);
	assert.equal(formatted.markdown[0], "你好，这是回复");
	assert.equal(formatted.truncated, false);
});

test("formatQQReply：长回复 ≤4 块 + 编号 + UTF-8 字节预算", () => {
	const long = "段落内容。".repeat(2000); // ~10KB
	const formatted = formatQQReply(long, "auto");
	assert.ok(formatted.markdown.length <= QQ_MAX_REPLY_CHUNKS);
	assert.ok(formatted.markdown.length > 1, "应被分块");
	for (const chunk of formatted.markdown) {
		assert.ok(
			bytes(chunk) <= QQ_MARKDOWN_CHUNK_BYTES,
			`块超限：${bytes(chunk)}`,
		);
	}
	assert.match(formatted.markdown[0] ?? "", /回答（1\/\d+）/);
});

test("formatQQReply：降级 plain 与 markdown 块数一致（msg_seq 对齐）", () => {
	const long = "## 标题\n\n" + "内容段落。".repeat(1500);
	const formatted = formatQQReply(long, "auto");
	assert.equal(
		formatted.markdown.length,
		formatted.plain.length,
		"降级必须逐块对齐",
	);
	assert.equal(formatted.plain.length, formatted.markdown.length);
	// plain 模式直接返回 plain
	const plainOnly = formatQQReply(long, "plain");
	assert.deepEqual(plainOnly.markdown, plainOnly.plain);
});

test("chunkMarkdown：代码围栏不从中截断", () => {
	const text = [
		"```python",
		"print('hello')",
		"print('world')",
		"```",
		"后续段落。".repeat(100),
	].join("\n");
	const chunks = chunkMarkdown(text, 200, 4);
	for (const chunk of chunks) {
		const open = (chunk.match(/```/g) ?? []).length;
		assert.equal(open % 2, 0, `围栏必须成对：${chunk.slice(0, 40)}`);
	}
});

test("normalizeMarkdown：CRLF 归一、控制字符清理、宽表格转列表", () => {
	const text = "a\r\nb\r\n\u0007c";
	assert.equal(normalizeMarkdown(text), "a\nb\nc");
	const table = "| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
	const converted = normalizeMarkdown(table);
	assert.ok(!converted.includes("| 列A |"), "表格应转列表");
	assert.ok(converted.includes("**列A：**1"), "列表形式保留表头");
});

test("markdownToPlain：标题/粗体/代码/引用/链接/列表降级", () => {
	const md =
		"## 标题\n\n**粗体** 和 `code`\n\n> 引用内容\n\n[链接](https://example.com)\n\n- 项1\n- 项2";
	const plain = markdownToPlain(md);
	assert.ok(!plain.includes("##"), "标题标记剥离");
	assert.ok(!plain.includes("**"), "粗体剥离");
	assert.ok(!plain.includes("```"), "代码围栏剥离");
	assert.match(plain, /注意：引用内容/, "引用转注意：");
	assert.match(plain, /链接（https:\/\/example.com）/, "链接保留可读形式");
	assert.match(plain, /• 项1/, "列表转圆点");
});

test("chunkMarkdown：超长单行硬切受块数限制且内容不丢", () => {
	const text = "A".repeat(5000);
	const chunks = chunkMarkdown(text, 1000, 4);
	assert.ok(chunks.length <= QQ_MAX_REPLY_CHUNKS);
	const total = chunks.reduce((sum, c) => sum + bytes(c), 0);
	assert.ok(total >= 4000, "内容不丢失");
});

test("formatQQReply：空文本兜底", () => {
	const formatted = formatQQReply("   \n ", "auto");
	assert.equal(formatted.markdown[0], "（无文本回复）");
});
