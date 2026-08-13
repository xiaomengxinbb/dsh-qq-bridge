/**
 * 模型分页 / 键盘单测（spec §10.1）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildModelPage,
	normalizeModelPageSize,
	MAX_MODEL_PAGE_SIZE,
} from "../src/commands/model-pages.ts";
import { buildCommandKeyboard } from "../src/commands/qq-keyboard.ts";
import { msg } from "./helpers.ts";
import type { QQModelInfo } from "../src/commands/model-pages.ts";

function models(n: number): QQModelInfo[] {
	return Array.from({ length: n }, (_, i) => ({
		provider: "p",
		id: `m${i + 1}`,
		name: `模型${i + 1}`,
		input: ["text"],
		reasoning: false,
	}));
}

test("model-pages：每页 6 个（键盘 5 行 - 2 保留行 × 2 列）", () => {
	const page = buildModelPage(models(13), 1, MAX_MODEL_PAGE_SIZE);
	assert.equal(page.pageSize, 6);
	assert.equal(page.models.length, 6);
	assert.equal(page.total, 13);
	assert.equal(page.totalPages, 3);
	assert.equal(page.offset, 0);
	// 键盘行：3 行模型 + 1 行翻页 + 1 行返回帮助 = 5 行
	assert.equal(page.keyboardRows.length, 5);
	assert.deepEqual(page.keyboardRows[4], [
		{ label: "返回帮助", command: "/help" },
	]);
	assert.deepEqual(page.fallbackCommands, ["/model page 2"]);
});

test("model-pages：末页与翻页边界", () => {
	const page3 = buildModelPage(models(13), 3, MAX_MODEL_PAGE_SIZE);
	assert.equal(page3.models.length, 1);
	assert.equal(page3.offset, 12);
	assert.deepEqual(page3.fallbackCommands, ["/model page 2"]);
	const page1 = buildModelPage(models(4), 1, MAX_MODEL_PAGE_SIZE);
	assert.equal(page1.totalPages, 1);
	assert.deepEqual(page1.fallbackCommands, []);
	assert.equal(
		page1.keyboardRows.length,
		3,
		"单页时无翻页行：2 行模型 + 1 行帮助",
	);
});

test("model-pages：页码越界抛错；pageSize clamp", () => {
	assert.throws(() => buildModelPage(models(10), 0, 6), /页码无效/);
	assert.throws(() => buildModelPage(models(10), 3, 6), /页码无效/);
	assert.equal(normalizeModelPageSize(999), MAX_MODEL_PAGE_SIZE);
	assert.equal(normalizeModelPageSize(0), 1);
	assert.equal(normalizeModelPageSize(Number.NaN), MAX_MODEL_PAGE_SIZE);
});

test("qq-keyboard：两列按钮 + permission.type=2 + unsupport_tips", () => {
	const m = msg({ type: "private" });
	const kb = buildCommandKeyboard(m, [
		[
			{ label: "状态", command: "/status" },
			{ label: "新会话", command: "/new" },
		],
	]);
	assert.ok(kb);
	assert.equal(kb.content.rows.length, 1);
	const button = kb.content.rows[0]!.buttons[0]!;
	assert.equal(button.id, "cmd-0-0");
	assert.equal(button.action.type, 2);
	assert.deepEqual(
		button.action.permission,
		{ type: 2 },
		"不能使用 openid 作为 specify_user_ids",
	);
	assert.equal(button.action.enter, true, "私聊按钮自动发送");
	assert.match(button.action.unsupport_tips, /请手动发送：\/status/);
	assert.equal(button.render_data.label, "状态");
	assert.equal(button.render_data.style, 0);
});

test("qq-keyboard：行/列/标签长度裁剪 + 空输入返回 undefined", () => {
	const m = msg({ type: "group" });
	// 6 行 → 只取 5 行
	const kb = buildCommandKeyboard(
		m,
		Array.from({ length: 6 }, (_, i) => [
			{ label: `B${i}`, command: `/x${i}` },
		]),
	);
	assert.equal(kb?.content.rows.length, 5);
	// 标签超长裁剪
	const long = buildCommandKeyboard(m, [
		[{ label: "超长标签".repeat(10), command: "/status" }],
	]);
	assert.equal(long?.content.rows[0]?.buttons[0]?.render_data.label.length, 20);
	// 空行
	assert.equal(buildCommandKeyboard(m, []), undefined);
	assert.equal(
		buildCommandKeyboard({ ...m, userOpenId: "" }, [
			[{ label: "x", command: "/x" }],
		]),
		undefined,
	);
});
