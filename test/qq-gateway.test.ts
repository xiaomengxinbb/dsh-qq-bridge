/**
 * QQGateway 冒烟测试（M0 验收的自动化版本）：
 *   真实 WS 协议走通 mock QQ 平台（token → gateway url → Hello → Identify → READY → 心跳）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMockQQServer, c2cMessageEvent } from "./mock-qq-server.ts";
import { QQAuth } from "../src/gateway/qq-auth.ts";
import { QQGateway } from "../src/gateway/qq-gateway.ts";
import type { QQInboundMessage } from "../src/core/types.ts";

test("完整连接：token → gateway → Identify → READY → connected", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});

		const states: string[] = [];
		gateway.onStateChange((state) => states.push(state));

		const ok = await gateway.start();
		assert.equal(ok, true);
		assert.equal(gateway.getState().state, "connected");
		assert.ok(states.includes("connecting"));
		assert.ok(states.includes("connected"));

		// Identify 负载正确：intents 1<<25、shard [0,1]、token 前缀
		const id = mock.identify as {
			token?: string;
			intents?: number;
			shard?: number[];
		};
		assert.equal(id?.intents, (1 << 25) | (1 << 26)); // GROUP_AND_C2C_EVENT + INTERACTION(PR #3 审批桥)
		assert.deepEqual(id?.shard, [0, 1]);
		assert.match(id?.token ?? "", /^QQBot MOCK_TOKEN$/);

		await gateway.stop();
		assert.equal(gateway.getState().state, "disconnected");
	} finally {
		await mock.close();
	}
});

test("心跳：按 heartbeat_interval 发送 op1，stop 后停止", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		await gateway.start();
		// mock Hello 的 heartbeat_interval=500ms → 1.2s 内应至少 2 次心跳
		await new Promise((r) => setTimeout(r, 1200));
		assert.ok(
			mock.heartbeatCount >= 2,
			`期望至少 2 次心跳，实际 ${mock.heartbeatCount}`,
		);
		await gateway.stop();
		const after = mock.heartbeatCount;
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(mock.heartbeatCount, after, "stop 后不应再有心跳");
	} finally {
		await mock.close();
	}
});

test("入站事件归一化：C2C_MESSAGE_CREATE → QQInboundMessage", async () => {
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
		const evt = c2cMessageEvent({
			id: "msg_normalized_1",
			author: { user_openid: "openid_xyz" },
			content: "看下目录",
			attachments: [
				{
					url: "https://example.com/a.png",
					filename: "a.png",
					size: 100,
					content_type: "image/png",
				},
				{
					url: "https://example.com/v.silk",
					filename: "v.silk",
					size: 50,
					content_type: "voice",
					asr_refer_text: "语音转写文本",
				},
			],
		});
		mock.sendEvent(evt.t, evt.d);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(received.length, 1);
		const m = received[0]!;
		assert.equal(m.id, "msg_normalized_1");
		assert.equal(m.type, "private");
		assert.equal(m.userOpenId, "openid_xyz");
		assert.equal(m.text, "看下目录");
		assert.equal(m.attachments.length, 2);
		assert.equal(m.attachments[0]?.contentType, "image/png");
		assert.equal(m.attachments[1]?.asrReferText, "语音转写文本");
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("入站事件转发（C2C_MESSAGE_CREATE）不崩溃", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: mock.baseUrl,
		});
		const received: string[] = [];
		gateway.onInbound((msg) => received.push(msg.id));
		await gateway.start();
		const evt = c2cMessageEvent();
		mock.sendEvent(evt.t, evt.d);
		// M1 前 dispatchEvent 为空实现：验证状态机不被未知事件破坏
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(gateway.getState().state, "connected");
		await gateway.stop();
	} finally {
		await mock.close();
	}
});

test("gateway 端点失败 → start 返回 false 且状态 error", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		// apiBase 指向不存在的端口
		const gateway = new QQGateway(auth, {
			sandbox: false,
			apiBase: "http://127.0.0.1:1",
		});
		const ok = await gateway.start();
		assert.equal(ok, false);
		assert.equal(gateway.getState().state, "error");
	} finally {
		await mock.close();
	}
});
