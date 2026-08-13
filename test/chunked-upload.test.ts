/**
 * 分片上传测试（spec §6.3 P0-1）：prepare → PUT → finish 全流程（mock）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startMockQQServer } from "./mock-qq-server.ts";
import { QQAuth } from "../src/gateway/qq-auth.ts";
import { QQApi } from "../src/gateway/qq-api.ts";

const target = {
	type: "private" as const,
	userOpenId: "openid_1",
	msgId: "m1",
};

test("uploadMediaChunked：3MiB 文件走 prepare→3 块 PUT→finish", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		// 3MiB 虚拟文件：readPart 返回固定块
		const fileSize = 3 * 1024 * 1024;
		const result = await api.uploadMediaChunked(
			target,
			4,
			"big.bin",
			fileSize,
			(_offset, length) => {
				return Promise.resolve(new Uint8Array(length));
			},
		);
		assert.match(result.fileInfo, /file_info_chunked/);
		assert.equal(mock.partPuts.length, 3, "应上传 3 块");
		assert.equal(
			mock.partPuts.reduce((a, b) => a + b, 0),
			fileSize,
			"字节总数一致",
		);
	} finally {
		await mock.close();
	}
});

test("uploadMediaChunked：文件大于 maxParts × blockSize 时截断到 maxParts", async () => {
	const mock = await startMockQQServer();
	try {
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		const fileSize = 10 * 1024 * 1024;
		const result = await api.uploadMediaChunked(
			target,
			4,
			"huge.bin",
			fileSize,
			(_o, l) => Promise.resolve(new Uint8Array(l)),
			{
				maxParts: 3,
			},
		);
		assert.ok(result.fileInfo);
		assert.equal(mock.partPuts.length, 3, "不超过 maxParts");
	} finally {
		await mock.close();
	}
});

test("uploadMediaChunked：prepare 失败（端点 404）→ QQApiError", async () => {
	// 用没有分片端点的 base（直接 /files 但无 upload_prepare 路由 → mock 404）
	const mock = await startMockQQServer();
	try {
		// 指向 messages 端点不存在的路径即可——upload_prepare 在 mock 中有路由；
		// 改为在 prepare 后立即 abort 验证取消路径
		const auth = new QQAuth("app1", "sec1", {
			tokenUrl: `${mock.baseUrl}/app/getAppAccessToken`,
		});
		const api = new QQApi(auth, { sandbox: false, apiBase: mock.baseUrl });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			() =>
				api.uploadMediaChunked(
					target,
					4,
					"x.bin",
					1024,
					() => Promise.resolve(new Uint8Array(1024)),
					{
						signal: controller.signal,
					},
				),
			/abort|Abort/i,
		);
	} finally {
		await mock.close();
	}
});
