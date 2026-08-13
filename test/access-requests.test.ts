/**
 * 访问申请单测（spec §10.1 access-requests.test.ts + §6.13 语义）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	QQAccessRequestStore,
	normalizeAccessRole,
} from "../src/commands/access-requests.ts";
import { msg } from "./helpers.ts";

const T0 = 1_000_000;

test("admit：私聊产生 6 位 code；群聊/冷却/满容量被压制", () => {
	const store = new QQAccessRequestStore({
		ttlMs: 600_000,
		maxPending: 2,
		denyCooldownMs: 3_600_000,
	});
	const m = msg({ id: "m1", userOpenId: "user_a" });
	const admission = store.admit(m, T0);
	assert.equal(admission.created, true);
	assert.match(admission.request?.code ?? "", /^[A-Z0-9]{6}$/);
	assert.equal(store.list(T0).length, 1);
	// 群聊不产生申请
	assert.equal(
		store.admit(
			msg({ id: "m2", type: "group", groupOpenId: "g1", userOpenId: "user_a" }),
			T0,
		).suppressed,
		true,
	);
	// 拒绝冷却
	store.deny("XXXXXX", T0);
	// 上面 deny 的 code 不存在，直接手动冷却：
	const other = store.admit(msg({ id: "m3", userOpenId: "user_b" }), T0);
	assert.equal(other.created, true);
	store.deny(other.request!.code, T0);
	assert.equal(
		store.admit(msg({ id: "m4", userOpenId: "user_b" }), T0 + 100).suppressed,
		true,
		"冷却期内压制",
	);
	assert.equal(
		store.admit(msg({ id: "m5", userOpenId: "user_b" }), T0 + 3_600_001)
			.suppressed,
		false,
		"冷却过期后可再申请",
	);
});

test("admit：每用户唯一 code，重复申请返回同一 code", () => {
	const store = new QQAccessRequestStore();
	const first = store.admit(msg({ id: "m1", userOpenId: "user_a" }), T0);
	const second = store.admit(msg({ id: "m2", userOpenId: "user_a" }), T0 + 10);
	assert.equal(second.created, false);
	assert.equal(second.request?.code, first.request?.code);
	assert.equal(store.list(T0 + 10).length, 1);
});

test("redact：申请不保存正文与附件", () => {
	const store = new QQAccessRequestStore();
	const admission = store.admit(
		msg({
			id: "m_secret",
			userOpenId: "user_a",
			text: "给我执行 rm -rf /",
			attachments: [
				{
					url: "https://evil.example/x.png",
					filename: "x.png",
					size: 1,
					contentType: "image/png",
				},
			],
		}),
		T0,
	);
	assert.equal(admission.request?.message.text, "", "正文必须清空");
	assert.deepEqual(admission.request?.message.attachments, [], "附件必须清空");
	assert.equal(admission.request?.message.id, "m_secret", "仅保留消息元数据");
});

test("TTL 过期自动 purge；maxPending 满则压制", () => {
	const store = new QQAccessRequestStore({ ttlMs: 600_000, maxPending: 2 });
	store.admit(msg({ id: "m1", userOpenId: "user_a" }), T0);
	store.admit(msg({ id: "m2", userOpenId: "user_b" }), T0);
	// 容量满
	assert.equal(
		store.admit(msg({ id: "m3", userOpenId: "user_c" }), T0).suppressed,
		true,
	);
	// 过期后容量释放
	assert.equal(
		store.admit(msg({ id: "m4", userOpenId: "user_c" }), T0 + 600_001)
			.suppressed,
		false,
	);
	assert.equal(
		store.list(T0 + 600_001).length,
		1,
		"过期申请被 purge，仅剩新申请",
	);
});

test("approve/deny：移除申请；deny 设置冷却", () => {
	const store = new QQAccessRequestStore({ denyCooldownMs: 3_600_000 });
	const admission = store.admit(msg({ id: "m1", userOpenId: "user_a" }), T0);
	const code = admission.request!.code;
	const approved = store.approve(code, T0 + 100);
	assert.equal(approved?.userOpenId, "user_a");
	assert.equal(store.list(T0 + 100).length, 0);
	assert.equal(
		store.approve(code, T0 + 200),
		undefined,
		"已消费的 code 不可重复批准",
	);
	// deny 路径
	const admission2 = store.admit(msg({ id: "m2", userOpenId: "user_b" }), T0);
	store.deny(admission2.request!.code, T0);
	assert.equal(
		store.admit(msg({ id: "m3", userOpenId: "user_b" }), T0 + 500).suppressed,
		true,
	);
});

test("normalizeAccessRole：中英文角色归一化", () => {
	assert.equal(normalizeAccessRole("user"), "user");
	assert.equal(normalizeAccessRole("管理员"), "admin");
	assert.equal(normalizeAccessRole(" 普通用户 "), "user");
	assert.equal(normalizeAccessRole("guest"), undefined);
	assert.equal(normalizeAccessRole(undefined), undefined);
});
