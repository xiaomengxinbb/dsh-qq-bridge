/**
 * router 单测（spec §10.1）：FIFO / 去重 / 白名单 / 预算 / 错误回复 / 命令体系
 * 注入 fake registry + fake api（不触真 SDK/网络）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { QQRouter } from "../src/router.ts";
import { QQAccessRequestStore } from "../src/commands/access-requests.ts";
import { CommandStateMachine } from "../src/commands/command-controller.ts";
import {
	makeTestConfig,
	makeApi,
	FakeRegistry,
	msg,
	type SentMessage,
} from "./helpers.ts";

const cfg = makeTestConfig();

test("授权用户：消息 → 会话 run → 文本被动回复（引用原 msg_id + msg_seq=1）", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({ text: "你好，这是回复" });
	const router = new QQRouter(cfg, registry, makeApi(sent));
	router.handleInbound(msg());
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.content, "你好，这是回复");
	assert.equal(sent[0]?.msgSeq, 1);
	assert.equal(sent[0]?.target.userOpenId, "user_allowed");
	assert.deepEqual(registry.created, ["private:user_allowed"]);
});

test("未授权用户（无申请流程）：拒绝回复，不创建会话", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const router = new QQRouter(
		makeTestConfig({ commands: { ...cfg.commands, accessRequests: false } }),
		registry,
		makeApi(sent),
	);
	router.handleInbound(msg({ userOpenId: "user_evil" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /没有权限/);
	assert.equal(registry.created.length, 0);
});

test("未授权私聊（accessRequests 开）：生成申请码并回复，不触发 agent", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const requests = new QQAccessRequestStore();
	const router = new QQRouter(cfg, registry, makeApi(sent), {
		accessRequests: requests,
	});
	router.handleInbound(msg({ userOpenId: "user_newbie" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /审批码：\*\*[A-Z0-9]{6}\*\*/);
	assert.equal(registry.created.length, 0, "申请不创建会话");
	assert.equal(requests.size, 1);
	// 重复申请返回同一 code，不重复创建
	router.handleInbound(msg({ id: "m_again", userOpenId: "user_newbie" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(requests.size, 1, "每用户唯一申请");
});

test("msg_id 去重：重复推送只处理一次", async () => {
	const sent: SentMessage[] = [];
	let prompts = 0;
	const registry = new FakeRegistry({
		text: "ok",
		onPrompt: () => {
			prompts += 1;
		},
	});
	const router = new QQRouter(cfg, registry, makeApi(sent));
	const m = msg({ id: "dup_msg_id" });
	router.handleInbound(m);
	router.handleInbound(m);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(prompts, 1);
	assert.equal(sent.length, 1);
});

test("FIFO：多条消息串行处理，不并发", async () => {
	const sent: SentMessage[] = [];
	let active = 0;
	let maxActive = 0;
	const origRun = FakeRegistry.prototype.get;
	// 用带延迟的 session 验证串行
	const registry = new FakeRegistry({ text: "ok", delayMs: 30 });
	registry.get = async function (
		this: FakeRegistry,
		m: Parameters<typeof origRun>[0],
	) {
		active += 1;
		maxActive = Math.max(maxActive, active);
		const session = await origRun.call(this, m);
		return new Proxy(session, {
			get(target, prop) {
				if (prop === "run") {
					return async () => {
						await new Promise((r) => setTimeout(r, 30));
						active -= 1;
						return { text: "ok", tools: [] };
					};
				}
				return Reflect.get(target, prop);
			},
		});
	};
	try {
		const router = new QQRouter(cfg, registry, makeApi(sent));
		router.handleInbound(msg());
		router.handleInbound(msg());
		router.handleInbound(msg());
		await new Promise((r) => setTimeout(r, 250));
		assert.equal(maxActive, 1, "不允许并发 agent 运行");
		assert.equal(sent.length, 3);
	} finally {
		active = 0;
	}
});

test("agent 运行失败：用户可读错误回复（占 1 次配额）", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({
		error: new Error("ENOTFOUND getaddrinfo host"),
	});
	const router = new QQRouter(cfg, registry, makeApi(sent));
	router.handleInbound(msg());
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /NETWORK_UNAVAILABLE/);
});

test("空消息（无文本）忽略，不创建会话", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const router = new QQRouter(cfg, registry, makeApi(sent));
	router.handleInbound(msg({ text: "   " }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 0);
	assert.equal(registry.created.length, 0);
});

// ── 命令体系（M2） ────────────────────────────────────────────────

test("未知 / 命令：回复未知命令，不转发给模型", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const router = new QQRouter(cfg, registry, makeApi(sent));
	router.handleInbound(msg({ text: "/frobnicate" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /未知命令/);
	assert.equal(registry.created.length, 0, "未知命令不创建会话");
});

test("危险命令（/login /quit）：显式阻塞", async () => {
	for (const cmd of ["/login", "/quit", "/tree", "/fork", "/clone"]) {
		const sent: SentMessage[] = [];
		const router = new QQRouter(cfg, new FakeRegistry(), makeApi(sent));
		router.handleInbound(msg({ text: cmd }));
		await new Promise((r) => setTimeout(r, 30));
		assert.match(
			sent[0]?.content ?? "",
			/只能在受信任的主机终端/,
			`/${cmd} 应被阻塞`,
		);
	}
});

test("管理命令权限：普通用户执行 /new 被拒", async () => {
	const sent: SentMessage[] = [];
	const router = new QQRouter(cfg, new FakeRegistry(), makeApi(sent));
	// user_allowed 不在 admins（cfg 默认 admins 为空）→ 拒绝
	router.handleInbound(msg({ text: "/new" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[0]?.content ?? "", /没有 QQ 会话管理权限/);
});

test("管理员 /new：创建会话并回复", async () => {
	const sent: SentMessage[] = [];
	let newCount = 0;
	const registry = new FakeRegistry({
		onNewSession: () => {
			newCount += 1;
		},
	});
	const adminCfg = makeTestConfig({
		commands: { ...cfg.commands, admins: ["user_allowed"] },
	});
	const router = new QQRouter(adminCfg, registry, makeApi(sent));
	router.handleInbound(msg({ text: "/new 测试会话" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(newCount, 1);
	assert.match(sent[0]?.content ?? "", /已新建 QQ 会话/);
	assert.match(sent[0]?.content ?? "", /测试会话/);
});

test("/help：列出命令", async () => {
	const sent: SentMessage[] = [];
	const router = new QQRouter(cfg, new FakeRegistry(), makeApi(sent));
	router.handleInbound(msg({ text: "/help" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[0]?.content ?? "", /QQ 命令/);
	assert.match(sent[0]?.content ?? "", /\/stop/);
});

test("/stop：清队列 + 中止运行中任务", async () => {
	const sent: SentMessage[] = [];
	let aborted = 0;
	const registry = new FakeRegistry({
		text: "ok",
		delayMs: 100,
		streaming: true,
		onAbort: () => {
			aborted += 1;
		},
	});
	const adminCfg = makeTestConfig({
		commands: { ...cfg.commands, admins: ["user_allowed"] },
	});
	const router = new QQRouter(adminCfg, registry, makeApi(sent));
	// 先入队两条普通消息（第一条运行中，第二条排队）
	router.handleInbound(msg({ id: "m1" }));
	router.handleInbound(msg({ id: "m2" }));
	// 等第一条进入运行
	await new Promise((r) => setTimeout(r, 30));
	router.handleInbound(msg({ id: "m_stop", text: "/stop" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(aborted, 1, "运行中任务应被中止");
	assert.equal(router.queueSize, 0, "队列应被清空");
	// stop 回复到达
	assert.ok(sent.some((s) => /已停止/.test(s.content)));
});

test("progress ack：慢任务先发回执（占 1 次配额）", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({ text: "done", delayMs: 200 });
	const progressCfg = makeTestConfig({
		progress: { enabled: true, ackAfterMs: 30 },
	});
	const router = new QQRouter(progressCfg, registry, makeApi(sent));
	router.handleInbound(msg());
	await new Promise((r) => setTimeout(r, 350));
	assert.equal(sent.length, 2, "ack + 最终回复");
	assert.equal(sent[0]?.content, "已收到，正在处理…");
	assert.equal(sent[0]?.msgSeq, 1);
	assert.equal(sent[1]?.msgSeq, 2, "ack 与最终回复共享同一消息的配额");
});

test("showProcess：最终答案后附加执行摘要", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({
		text: "完成",
		tools: [
			{
				toolCallId: "t1",
				name: "bash",
				args: { command: "ls" },
				isError: false,
			},
			{ toolCallId: "t2", name: "read", args: {}, isError: true },
		],
	});
	const showCfg = makeTestConfig({ showProcess: true });
	const router = new QQRouter(showCfg, registry, makeApi(sent));
	router.handleInbound(msg());
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[0]?.content ?? "", /执行摘要/);
	assert.match(sent[0]?.content ?? "", /✅ \*\*bash\*\*/);
	assert.match(sent[0]?.content ?? "", /❌ \*\*read\*\*/);
});

test("命令不能与附件同时发送", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const router = new QQRouter(cfg, registry, makeApi(sent));
	router.handleInbound(
		msg({
			text: "/stop",
			attachments: [
				{
					url: "https://example.com/a.png",
					filename: "a.png",
					size: 1,
					contentType: "image/png",
				},
			],
		}),
	);
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[0]?.content ?? "", /不能与附件同时发送/);
	assert.equal(registry.created.length, 0);
});

test("/model：精确匹配直接切换", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({
		models: [
			{
				provider: "p1",
				id: "fast",
				name: "Fast",
				input: ["text"],
				reasoning: false,
			},
			{
				provider: "p2",
				id: "vision",
				name: "Vision",
				input: ["text", "image"],
				reasoning: true,
			},
		],
	});
	const adminCfg = makeTestConfig({
		commands: { ...cfg.commands, admins: ["user_allowed"] },
	});
	const router = new QQRouter(adminCfg, registry, makeApi(sent));
	router.handleInbound(msg({ text: "/model p2/vision" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[0]?.content ?? "", /已切换 QQ 会话模型/);
	assert.match(sent[0]?.content ?? "", /p2\/vision/);
});

test("/model：多匹配进入选择态，序号选择生效（状态机）", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({
		models: [
			{
				provider: "p1",
				id: "deep-a",
				name: "Deep A",
				input: ["text"],
				reasoning: true,
			},
			{
				provider: "p2",
				id: "deep-b",
				name: "Deep B",
				input: ["text"],
				reasoning: true,
			},
			{
				provider: "p3",
				id: "other",
				name: "Other",
				input: ["text"],
				reasoning: false,
			},
		],
	});
	const adminCfg = makeTestConfig({
		commands: {
			...cfg.commands,
			admins: ["user_allowed"],
			selectionTtlMs: 5000,
		},
	});
	const stateMachine = new CommandStateMachine(adminCfg.commands);
	const router = new QQRouter(adminCfg, registry, makeApi(sent), {
		stateMachine,
	});
	router.handleInbound(msg({ id: "m_q", text: "/model deep" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[0]?.content ?? "", /找到 2 个匹配项/);
	// 序号选择
	router.handleInbound(msg({ id: "m_sel", text: "/model 2" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[1]?.content ?? "", /已切换 QQ 会话模型/);
	assert.match(sent[1]?.content ?? "", /p2\/deep-b/);
});

test("选择态 TTL 过期：序号选择失效", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({
		models: [
			{
				provider: "p1",
				id: "deep-a",
				name: "Deep A",
				input: ["text"],
				reasoning: true,
			},
			{
				provider: "p2",
				id: "deep-b",
				name: "Deep B",
				input: ["text"],
				reasoning: true,
			},
		],
	});
	const adminCfg = makeTestConfig({
		commands: {
			...cfg.commands,
			admins: ["user_allowed"],
			selectionTtlMs: 1000,
		},
	});
	const stateMachine = new CommandStateMachine(adminCfg.commands);
	const router = new QQRouter(adminCfg, registry, makeApi(sent), {
		stateMachine,
	});
	router.handleInbound(msg({ id: "m_q", text: "/model deep" }));
	await new Promise((r) => setTimeout(r, 30));
	// 直接操纵状态机让 pending 过期
	stateMachine.set(
		"private:user_allowed",
		"selection",
		"model",
		{ candidates: [] },
		Date.now() - 5000,
	);
	router.handleInbound(msg({ id: "m_sel", text: "/model 1" }));
	await new Promise((r) => setTimeout(r, 30));
	assert.match(
		sent[1]?.content ?? "",
		/请先发送 \/model <关键词>/,
		"过期选择应失效（无选择上下文时序号参数直接报错）",
	);
});

test("/sessions 列表 + /resume 唯一匹配恢复", async () => {
	const sent: SentMessage[] = [];
	const sessions = [
		{
			path: "/tmp/s1.jsonl",
			id: "sess-aaaa-1111",
			name: "项目A",
			created: new Date(),
			modified: new Date(),
			messageCount: 5,
			firstMessage: "hi",
			allMessagesText: "",
		},
		{
			path: "/tmp/s2.jsonl",
			id: "sess-bbbb-2222",
			name: "项目B",
			created: new Date(),
			modified: new Date(),
			messageCount: 3,
			firstMessage: "yo",
			allMessagesText: "",
		},
	];
	const registry = new FakeRegistry({ sessions });
	const adminCfg = makeTestConfig({
		commands: { ...cfg.commands, admins: ["user_allowed"] },
	});
	const router = new QQRouter(adminCfg, registry, makeApi(sent));
	router.handleInbound(msg({ id: "m_list", text: "/sessions" }));
	await new Promise((r) => setTimeout(r, 30));
	assert.match(sent[0]?.content ?? "", /QQ 会话/);
	router.handleInbound(msg({ id: "m_resume", text: "/resume aaaa" }));
	await new Promise((r) => setTimeout(r, 30));
	assert.match(sent[1]?.content ?? "", /已恢复 QQ 会话/);
	assert.match(sent[1]?.content ?? "", /项目A/);
});

test("/last：最近活动摘要", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({ text: "回答完毕" });
	const router = new QQRouter(cfg, registry, makeApi(sent));
	router.handleInbound(msg({ id: "m1", text: "第一个问题" }));
	await new Promise((r) => setTimeout(r, 50));
	router.handleInbound(msg({ id: "m2", text: "/last" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[1]?.content ?? "", /最近活动/);
	assert.match(sent[1]?.content ?? "", /入站/);
	assert.match(sent[1]?.content ?? "", /出站/);
});

test("/status：会话/模型/队列/网关状态", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry({
		models: [
			{
				provider: "p1",
				id: "m1",
				name: "M1",
				input: ["text"],
				reasoning: false,
			},
		],
	});
	const router = new QQRouter(cfg, registry, makeApi(sent), {
		statusProvider: () => "**connected**（已连接）",
	});
	router.handleInbound(msg({ text: "/status" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[0]?.content ?? "", /QQ 会话状态/);
	assert.match(sent[0]?.content ?? "", /p1\/m1/);
	assert.match(sent[0]?.content ?? "", /connected/);
});
