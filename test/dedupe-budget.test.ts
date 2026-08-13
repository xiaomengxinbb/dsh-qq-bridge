/**
 * message-dedupe / reply-budget 单测
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageDedupe } from "../src/session/message-dedupe.ts";
import { ReplyBudget } from "../src/session/reply-budget.ts";

test("MessageDedupe：首次放行，重复拒绝", () => {
	const d = new MessageDedupe(60_000, 10);
	assert.equal(d.admit("a"), true);
	assert.equal(d.admit("a"), false);
	assert.equal(d.admit("b"), true);
	assert.equal(d.size, 2);
});

test("MessageDedupe：TTL 过期后重新放行", () => {
	const d = new MessageDedupe(60_000, 10);
	const now = 1_000_000;
	assert.equal(d.admit("a", now), true);
	assert.equal(d.admit("a", now + 59_000), false);
	assert.equal(d.admit("a", now + 61_000), true, "TTL 过期后可重新登记");
});

test("MessageDedupe：空 id 拒绝", () => {
	const d = new MessageDedupe();
	assert.equal(d.admit(""), false);
});

test("MessageDedupe：超过 maxEntries 逐出最旧", () => {
	const d = new MessageDedupe(3_600_000, 3);
	assert.equal(d.admit("1", 100), true);
	assert.equal(d.admit("2", 200), true);
	assert.equal(d.admit("3", 300), true);
	assert.equal(d.admit("4", 400), true, "超出上限仍登记");
	assert.equal(d.has("1", 500), false, "最旧的被逐出");
	assert.equal(d.has("4", 500), true);
	assert.equal(d.size, 3);
});

test("ReplyBudget：msg_seq 从 1 递增，超限返回 undefined", () => {
	const b = new ReplyBudget("msg_1", 4);
	assert.equal(b.nextSeq(), 1);
	assert.equal(b.nextSeq(), 2);
	assert.equal(b.remaining, 2);
	assert.equal(b.nextSeq(), 3);
	assert.equal(b.nextSeq(), 4);
	assert.equal(b.isExhausted, true);
	assert.equal(b.nextSeq(), undefined);
});

test("ReplyBudget：默认上限 4", () => {
	const b = new ReplyBudget("msg_2");
	for (let i = 1; i <= 4; i++) assert.equal(b.nextSeq(), i);
	assert.equal(b.nextSeq(), undefined);
});
