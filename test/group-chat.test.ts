/**
 * M4：群聊支持（GROUP_AT_MESSAGE_CREATE + allowGroups）
 * - 网关归一化：group_openid 解析
 * - router：群授权 / 群会话作用域 / 群回复路径
 * - 端到端：群 @ 消息 → 被动回复到 /v2/groups/{openid}/messages
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	startMockQQServer,
	groupAtMessageEvent,
	c2cMessageEvent,
} from "./mock-qq-server.ts";
import { QQAuth } from "../src/gateway/qq-auth.ts";
import { QQGateway } from "../src/gateway/qq-gateway.ts";
import { QQApi } from "../src/gateway/qq-api.ts";
import { QQRouter } from "../src/router.ts";
import { makeTestConfig, FakeRegistry } from "./helpers.ts";
import type { QQInboundMessage } from "../src/core/types.ts";

test("网关：GROUP_AT_MESSAGE_CREATE → QQInboundMessage(type=group, groupOpenId)", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const received: QQInboundMessage[] = [];
		gateway.onInbound((msg) => received.push(msg));
		await gateway.start();
		mock.sendEvent(
			...(Object.entries(
				groupAtMessageEvent({
					id: "g1",
					group_openid: "group_openid_x",
					content: "@机器人 看下这个",
				}),
			).map(([, v]) => v) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(received.length, 1);
		const m = received[0]!;
		assert.equal(m.type, "group");
		assert.equal(m.groupOpenId, "group_openid_x");
		assert.equal(m.userOpenId, "group_user_1");
		assert.equal(m.text, "@机器人 看下这个");
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("router：allowGroups 授权的群消息 → 群会话 → 群回复路径", async () => {
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
		const registry = new FakeRegistry({ text: "群回复内容" });
		const cfg = makeTestConfig({
			allowGroups: ["group_openid_1"],
			replyFormat: "plain",
		});
		const router = new QQRouter(cfg, registry, api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();
		mock.sendEvent(
			...(Object.entries(groupAtMessageEvent({ id: "g_reply" })).map(
				([, v]) => v,
			) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(mock.messages.length, 1);
		const reply = mock.messages[0]!;
		assert.equal(reply.path, "/v2/groups/group_openid_1/messages");
		assert.equal(reply.body.msg_id, "g_reply");
		assert.match(String(reply.body.content), /群回复内容/);
		assert.deepEqual(
			registry.created,
			["group:group_openid_1"],
			"群会话作用域 = group_openid",
		);
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("router：未授权群 → 拒绝回复（不产生访问申请）", async () => {
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
		let runs = 0;
		const registry = new FakeRegistry({
			onPrompt: () => {
				runs += 1;
			},
		});
		const router = new QQRouter(
			makeTestConfig({ allowGroups: [], replyFormat: "plain" }),
			registry,
			api,
		);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();
		mock.sendEvent(
			...(Object.entries(groupAtMessageEvent({ id: "g_evil" })).map(
				([, v]) => v,
			) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(runs, 0);
		assert.equal(mock.messages.length, 1);
		assert.match(
			String(mock.messages[0]?.body.content ?? ""),
			/没有权限/,
			"群聊不产生申请码，直接拒绝",
		);
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("router：私聊与群聊会话隔离（不同作用域）", async () => {
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
		const registry = new FakeRegistry({ text: "ok" });
		const cfg = makeTestConfig({
			allowGroups: ["group_openid_1"],
			replyFormat: "plain",
		});
		const router = new QQRouter(cfg, registry, api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();
		mock.sendEvent(
			...(Object.entries(groupAtMessageEvent({ id: "g1" })).map(
				([, v]) => v,
			) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 200));
		mock.sendEvent(
			...(Object.entries(
				c2cMessageEvent({ id: "c1", author: { user_openid: "user_allowed" } }),
			).map(([, v]) => v) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual(
			registry.created.sort(),
			["group:group_openid_1", "private:user_allowed"].sort(),
		);
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("群聊命令：allowInGroups=false 时管理员也无法在群内执行 mutation", async () => {
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
		const registry = new FakeRegistry();
		const cfg = makeTestConfig({
			allowGroups: ["group_openid_1"],
			replyFormat: "plain",
			commands: {
				...makeTestConfig({ replyFormat: "plain" }).commands,
				admins: ["group_user_1"],
				allowInGroups: false,
			},
		});
		const router = new QQRouter(cfg, registry, api);
		gateway.onInbound((msg) => router.handleInbound(msg));
		await gateway.start();
		// 群内管理员发 /new（mutation）
		mock.sendEvent(
			...(Object.entries(
				groupAtMessageEvent({ id: "g_cmd", content: "/new" }),
			).map(([, v]) => v) as [string, unknown]),
		);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(mock.messages.length, 1);
		assert.match(
			String(mock.messages[0]?.body.content ?? ""),
			/群聊管理命令默认关闭/,
		);
		await gateway.stop();
	} finally {
		await mock.close();
	}
});
