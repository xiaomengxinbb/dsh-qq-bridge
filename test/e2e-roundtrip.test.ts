/**
 * M1/M2 全链路集成冒烟：mock QQ 平台 → 网关归一化 → router（FakeSession）→ 被动回复
 * 验证文本私聊闭环 + 命令体系的每一环（真实 WS + HTTP，仅 agent 会话为 fake）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMockQQServer, c2cMessageEvent } from "./mock-qq-server.ts";
import { QQAuth } from "../src/gateway/qq-auth.ts";
import { QQGateway } from "../src/gateway/qq-gateway.ts";
import { QQApi } from "../src/gateway/qq-api.ts";
import { QQRouter, type ConversationRegistryLike } from "../src/router.ts";
import { QQAccessRequestStore } from "../src/commands/access-requests.ts";
import { makeTestConfig, FakeRegistry } from "./helpers.ts";
import type { QQInboundMessage } from "../src/core/types.ts";

test("端到端：C2C 消息 → 隔离会话 → 被动回复（msg_id 引用 + msg_seq=1）", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		const registry = new FakeRegistry({
			text: "处理完成（收到：帮我看看当前目录）",
		});
		const router = new QQRouter(makeTestConfig({ replyFormat: "plain" }), registry, api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();

		const evt = c2cMessageEvent({
			id: "msg_e2e_1",
			author: { user_openid: "user_allowed" },
			content: "帮我看看当前目录",
		});
		mock.sendEvent(evt.t, evt.d);

		await new Promise((r) => setTimeout(r, 300));
		assert.equal(mock.messages.length, 1, "应收到一条被动回复");
		const reply = mock.messages[0]!;
		assert.equal(reply.path, "/v2/users/user_allowed/messages");
		assert.equal(reply.body.msg_type, 0);
		assert.equal(
			reply.body.msg_id,
			"msg_e2e_1",
			"被动回复必须引用原消息 msg_id",
		);
		assert.equal(reply.body.msg_seq, 1);
		assert.match(String(reply.body.content), /处理完成/);

		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("端到端：未授权用户 → 申请码回复，不触发 agent", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		let agentRuns = 0;
		const registry: ConversationRegistryLike = {
			async get(): Promise<never> {
				agentRuns += 1;
				throw new Error("不应触发");
			},
			peek(): undefined {
				return undefined;
			},
			async dispose(): Promise<void> {},
		};
		const router = new QQRouter(makeTestConfig({ replyFormat: "plain" }), registry, api, {
			accessRequests: new QQAccessRequestStore(),
		});
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();

		const evt = c2cMessageEvent({
			id: "msg_e2e_evil",
			author: { user_openid: "openid_hacker" },
			content: "rm -rf /",
		});
		mock.sendEvent(evt.t, evt.d);

		await new Promise((r) => setTimeout(r, 300));
		assert.equal(agentRuns, 0, "未授权用户绝不能触发 agent");
		assert.equal(mock.messages.length, 1);
		assert.match(String(mock.messages[0]?.body.content ?? ""), /审批码/);

		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("端到端：重复推送同 msg_id → 只处理一次", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		let agentRuns = 0;
		// 用 run 计数验证只跑一次：包一层正常 fake
		const normal = new FakeRegistry({ text: "ok" });
		const counting: ConversationRegistryLike = {
			async get(msg: QQInboundMessage) {
				agentRuns += 1;
				return normal.get(msg);
			},
			peek(msg: QQInboundMessage) {
				return normal.peek(msg);
			},
			async dispose() {
				return normal.dispose();
			},
		};
		const router = new QQRouter(makeTestConfig({ replyFormat: "plain" }), counting, api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();

		const evt = c2cMessageEvent({
			id: "msg_e2e_dup",
			author: { user_openid: "user_allowed" },
			content: "hello",
		});
		mock.sendEvent(evt.t, evt.d);
		mock.sendEvent(evt.t, evt.d); // 平台重复推送

		await new Promise((r) => setTimeout(r, 300));
		assert.equal(agentRuns, 1, "重复推送只处理一次");
		assert.equal(mock.messages.length, 1);

		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("端到端：QQ 命令 /help 走通", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		const router = new QQRouter(makeTestConfig({ replyFormat: "plain" }), new FakeRegistry(), api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();

		const evt = c2cMessageEvent({
			id: "msg_e2e_help",
			author: { user_openid: "user_allowed" },
			content: "/help",
		});
		mock.sendEvent(evt.t, evt.d);

		await new Promise((r) => setTimeout(r, 300));
		assert.equal(mock.messages.length, 1);
		assert.match(String(mock.messages[0]?.body.content ?? ""), /QQ 命令/);

		await gateway.stop();
	} finally {
		await mock.close();
	}
});
