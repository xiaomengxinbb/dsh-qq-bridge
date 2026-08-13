/**
 * steering 插嘴单测（spec §6.7 P1-6）：
 * 同对话运行中消息 → session.steer；跨对话 FIFO；/stop 清 steering 队列；聚合回复
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { QQRouter } from "../src/router.ts";
import {
	makeTestConfig,
	makeApi,
	FakeRegistry,
	msg,
	type SentMessage,
} from "./helpers.ts";

test("同对话运行中：新消息走 steer 插嘴（不排队）", async () => {
	const sent: SentMessage[] = [];
	const steers: string[] = [];
	const registry = new FakeRegistry({
		text: "最终聚合回复",
		delayMs: 150, // 模拟长任务
		onSteer: (prompt) => steers.push(prompt),
	});
	const router = new QQRouter(makeTestConfig(), registry, makeApi(sent));
	router.handleInbound(msg({ id: "m1", text: "第一个任务" }));
	// 等 m1 进入运行（activeConversation 就绪）
	await new Promise((r) => setTimeout(r, 50));
	router.handleInbound(msg({ id: "m2", text: "等一下，先看这个" }));
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(steers.length, 1, "同对话新消息应 steering 插嘴");
	assert.equal(steers[0], "等一下，先看这个");
	// 聚合回复：只发一条最终答案
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.content, "最终聚合回复");
});

test("跨对话：运行中不插嘴，FIFO 排队", async () => {
	const sent: SentMessage[] = [];
	const steers: string[] = [];
	const registry = new FakeRegistry({
		text: "ok",
		delayMs: 100,
		onSteer: (prompt) => steers.push(prompt),
	});
	const router = new QQRouter(makeTestConfig(), registry, makeApi(sent));
	router.handleInbound(msg({ id: "m1", text: "任务A" }));
	await new Promise((r) => setTimeout(r, 30));
	// 不同用户（不同会话作用域）
	router.handleInbound(msg({ id: "m2", text: "任务B", userOpenId: "user_b" }));
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(steers.length, 0, "跨对话绝不 steering");
	assert.equal(sent.length, 2, "两个对话都完成");
});

test("/stop：清 steering 队列并中止运行", async () => {
	const sent: SentMessage[] = [];
	let cleared = 0;
	let aborted = 0;
	const registry = new FakeRegistry({
		text: "ok",
		delayMs: 200,
		streaming: true,
		onClearPending: () => {
			cleared += 1;
		},
		onAbort: () => {
			aborted += 1;
		},
	});
	const adminCfg = makeTestConfig({
		commands: { ...makeTestConfig().commands, admins: ["user_allowed"] },
	});
	const router = new QQRouter(adminCfg, registry, makeApi(sent));
	router.handleInbound(msg({ id: "m1", text: "长任务" }));
	await new Promise((r) => setTimeout(r, 50));
	router.handleInbound(msg({ id: "m2", text: "插嘴消息" }));
	router.handleInbound(msg({ id: "m_stop", text: "/stop" }));
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(cleared, 1, "steering 队列应被清理");
	assert.equal(aborted, 1, "运行中任务应被中止");
});

test("steering 目标已结束：失败后重新入队处理", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({
		text: "ok",
		delayMs: 60,
		onSteer: () => {
			throw new Error("session ended");
		},
	});
	const router = new QQRouter(makeTestConfig(), registry, makeApi(sent));
	router.handleInbound(msg({ id: "m1", text: "任务A" }));
	await new Promise((r) => setTimeout(r, 30));
	router.handleInbound(msg({ id: "m2", text: "插嘴B" }));
	await new Promise((r) => setTimeout(r, 200));
	// steer 失败 → m2 重新入队 → 被正常处理（同一会话第二次 run）
	assert.equal(sent.length, 2, "两条消息都应有回复");
});
