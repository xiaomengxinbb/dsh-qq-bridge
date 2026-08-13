/**
 * QQAuth 单测（spec §10.1）：本地 mock token 端点（tokenUrl 白名单含 localhost）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { QQAuth, validateTokenUrl } from "../src/gateway/qq-auth.ts";

async function withTokenServer(
	handler: (
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
	) => void,
	fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const server: Server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	try {
		await fn(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("validateTokenUrl：官方域名与 localhost 放行，其他拒绝", () => {
	assert.doesNotThrow(() =>
		validateTokenUrl("https://bots.qq.com/app/getAppAccessToken"),
	);
	assert.doesNotThrow(() => validateTokenUrl("https://api.bot.qq.com/x"));
	assert.doesNotThrow(() => validateTokenUrl("http://127.0.0.1:8080/token"));
	assert.doesNotThrow(() => validateTokenUrl("http://localhost:8080/token"));
	assert.throws(
		() => validateTokenUrl("http://evil.example.com/token"),
		/HTTPS|白名单/,
	);
	assert.throws(
		() => validateTokenUrl("https://evil.example.com/token"),
		/白名单/,
	);
	assert.throws(() => validateTokenUrl("not-a-url"), /合法 URL/);
});

test("getToken：首次请求拿 token，后续命中缓存", async () => {
	let calls = 0;
	await withTokenServer(
		(_req, res) => {
			calls += 1;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ access_token: "TOKEN_1", expires_in: 7200 }));
		},
		async (baseUrl) => {
			const auth = new QQAuth("app1", "sec1", { tokenUrl: `${baseUrl}/token` });
			const t1 = await auth.getToken();
			const t2 = await auth.getToken();
			assert.equal(t1, "TOKEN_1");
			assert.equal(t2, "TOKEN_1");
			assert.equal(calls, 1, "缓存命中，不应重复请求");
			auth.dispose();
		},
	);
});

test("forceRefresh 并发去抖：多个调用共享一次请求", async () => {
	let calls = 0;
	await withTokenServer(
		(_req, res) => {
			calls += 1;
			setTimeout(() => {
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({ access_token: `T${calls}`, expires_in: 7200 }),
				);
			}, 50);
		},
		async (baseUrl) => {
			const auth = new QQAuth("app1", "sec1", { tokenUrl: `${baseUrl}/token` });
			const [a, b, c] = await Promise.all([
				auth.forceRefresh(),
				auth.forceRefresh(),
				auth.forceRefresh(),
			]);
			assert.equal(a, "T1");
			assert.equal(b, "T1");
			assert.equal(c, "T1");
			assert.equal(calls, 1, "并发刷新应共享同一请求");
			auth.dispose();
		},
	);
});

test("过期后（expires_in 极短）自动重新获取", async () => {
	let calls = 0;
	await withTokenServer(
		(_req, res) => {
			calls += 1;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ access_token: `T${calls}`, expires_in: 1 }));
		},
		async (baseUrl) => {
			const auth = new QQAuth("app1", "sec1", { tokenUrl: `${baseUrl}/token` });
			const t1 = await auth.getToken();
			assert.equal(t1, "T1");
			// expires_in=1s + refreshAheadMs 默认 60s → 缓存视为失效，应重新请求
			const t2 = await auth.getToken();
			assert.equal(t2, "T2");
			assert.equal(calls, 2);
			auth.dispose();
		},
	);
});

test("连续失败达到上限触发 onFatal", async () => {
	let calls = 0;
	let fatalReason: string | undefined;
	await withTokenServer(
		(_req, res) => {
			calls += 1;
			res.statusCode = 500;
			res.end("boom");
		},
		async (baseUrl) => {
			const auth = new QQAuth("app1", "sec1", {
				tokenUrl: `${baseUrl}/token`,
				maxFailures: 3,
				refreshAheadMs: 60_000,
			});
			auth.onFatal = (reason) => {
				fatalReason = reason;
			};
			// 第 1 次失败
			await assert.rejects(() => auth.getToken());
			assert.equal(fatalReason, undefined, "未达上限不应 fatal");
			// 第 2 次失败
			await assert.rejects(() => auth.getToken());
			assert.equal(fatalReason, undefined, "未达上限不应 fatal");
			// 第 3 次失败 → fatal
			await assert.rejects(() => auth.forceRefresh());
			assert.match(fatalReason ?? "", /第 3 次失败/);
			auth.dispose();
		},
	);
});

test("token 响应缺 access_token → 报错", async () => {
	await withTokenServer(
		(_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ expires_in: 7200 }));
		},
		async (baseUrl) => {
			const auth = new QQAuth("app1", "sec1", {
				tokenUrl: `${baseUrl}/token`,
				maxFailures: 5,
			});
			await assert.rejects(() => auth.getToken(), /缺少 access_token/);
			auth.dispose();
		},
	);
});
