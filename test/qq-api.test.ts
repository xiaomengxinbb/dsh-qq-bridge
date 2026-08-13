/**
 * QQApi 单测：请求形状（path/header/body msg_id+msg_seq）、401 刷新重试、错误分类
 * 用本地 mock HTTP 服务器同时提供 token 端点与消息端点
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
	type Server,
} from "node:http";
import { QQApi, QQApiError } from "../src/gateway/qq-api.ts";
import { QQAuth } from "../src/gateway/qq-auth.ts";

interface CapturedRequest {
	path: string;
	authorization: string | undefined;
	body: Record<string, unknown>;
}

async function withApiServer(
	handleMessage: (
		req: IncomingMessage,
		res: ServerResponse,
		captured: CapturedRequest[],
	) => void,
	fn: (baseUrl: string, captured: CapturedRequest[]) => Promise<void>,
): Promise<void> {
	const captured: CapturedRequest[] = [];
	const server: Server = createServer((req, res) => {
		if (
			req.method === "POST" &&
			(req.url ?? "").includes("getAppAccessToken")
		) {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ access_token: "TOKEN_ABC", expires_in: 7200 }));
			return;
		}
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk.toString();
		});
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				// 保留空 body
			}
			captured.push({
				path: req.url ?? "",
				authorization: req.headers.authorization,
				body,
			});
			handleMessage(req, res, captured);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	try {
		await fn(`http://127.0.0.1:${port}`, captured);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

const target = {
	type: "private" as const,
	userOpenId: "openid_1",
	msgId: "msg_42",
};

test("sendText：路径/鉴权头/body（msg_type=0 + msg_id + msg_seq）", async () => {
	await withApiServer(
		(_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ id: "new_msg_id" }));
		},
		async (baseUrl, captured) => {
			const auth = new QQAuth("app1", "sec1", {
				tokenUrl: `${baseUrl}/app/getAppAccessToken`,
			});
			const api = new QQApi(auth, { sandbox: false, apiBase: baseUrl });
			await api.sendText(target, "你好", 3);
			assert.equal(captured.length, 1);
			assert.equal(captured[0]?.path, "/v2/users/openid_1/messages");
			assert.equal(captured[0]?.authorization, "QQBot TOKEN_ABC");
			assert.equal(captured[0]?.body.content, "你好");
			assert.equal(captured[0]?.body.msg_type, 0);
			assert.equal(captured[0]?.body.msg_id, "msg_42");
			assert.equal(captured[0]?.body.msg_seq, 3);
		},
	);
});

test("401：forceRefresh 后重试一次成功", async () => {
	let calls = 0;
	await withApiServer(
		(_req, res, captured) => {
			calls += 1;
			if (captured.length === 1) {
				res.statusCode = 401;
				res.end(JSON.stringify({ code: 401, message: "token invalid" }));
				return;
			}
			res.end(JSON.stringify({ id: "retry_ok" }));
		},
		async (baseUrl) => {
			const auth = new QQAuth("app1", "sec1", {
				tokenUrl: `${baseUrl}/app/getAppAccessToken`,
			});
			const api = new QQApi(auth, { sandbox: false, apiBase: baseUrl });
			await api.sendText(target, "hi", 1);
			assert.equal(calls, 2, "401 后应重试一次");
		},
	);
});

test("HTTP 500：抛 QQApiError（status/code/requestAccepted）", async () => {
	await withApiServer(
		(_req, res) => {
			res.statusCode = 500;
			res.end(JSON.stringify({ code: 50001, message: "rate limited" }));
		},
		async (baseUrl) => {
			const auth = new QQAuth("app1", "sec1", {
				tokenUrl: `${baseUrl}/app/getAppAccessToken`,
			});
			const api = new QQApi(auth, { sandbox: false, apiBase: baseUrl });
			await assert.rejects(
				() => api.sendText(target, "hi", 1),
				(err: unknown) =>
					err instanceof QQApiError &&
					err.status === 500 &&
					err.code === 50001 &&
					err.requestAccepted === true,
			);
		},
	);
});

test("网络失败：QQApiError status=0", async () => {
	// token 端点可用，消息端点指向死端口 → postJson fetch 失败
	await withApiServer(
		(_req, res) => {
			res.end(JSON.stringify({ id: "x" }));
		},
		async (baseUrl) => {
			const auth = new QQAuth("app1", "sec1", {
				tokenUrl: `${baseUrl}/app/getAppAccessToken`,
			});
			const api = new QQApi(auth, {
				sandbox: false,
				apiBase: "http://127.0.0.1:1",
			});
			await assert.rejects(
				() => api.sendText(target, "hi", 1),
				(err: unknown) => err instanceof QQApiError && err.status === 0,
			);
		},
	);
});
