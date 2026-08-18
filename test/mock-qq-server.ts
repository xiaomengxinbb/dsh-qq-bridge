/**
 * 本地 mock QQ 平台（测试用）：
 *   - HTTP: POST /app/getAppAccessToken → token；GET /gateway → {url: ws://...}
 *   - WS:   握手 → op10 Hello → 等 Identify(op2) → READY → 周期心跳校验
 * 复用：M1 的 C2C_MESSAGE_CREATE 事件注入也走 sendEvent()。
 */
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { Socket } from "node:net";

export interface MockQQServer {
	baseUrl: string;
	/** 收到的事件（op0 dispatch 的 t 列表） */
	events: string[];
	/** 收到的 Identify 负载（op2.d） */
	identify?: unknown;
	/** 收到的心跳 op1 次数 */
	heartbeatCount: number;
	/** 收到的被动回复消息（POST /v2/users|groups/{openid}/messages） */
	messages: Array<{ path: string; body: Record<string, unknown> }>;
	/** 收到的文件上传（POST /v2/users|groups/{openid}/files） */
	uploads: string[];
	/** 收到的分片 PUT（body 字节数） */
	partPuts: number[];
	sendEvent(t: string, d: unknown): void;
	close(): Promise<void>;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsFrame(payload: string): Buffer {
	const buf = Buffer.from(payload, "utf8");
	const len = buf.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([0x81, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, buf]);
}

/** 解析客户端文本帧（客户端帧必须 masked） */
function decodeClientFrame(data: Buffer): string {
	if (data.length < 2) return "";
	const len7 = data[1] & 0x7f;
	let offset = 2;
	let len = len7;
	if (len7 === 126) {
		len = data.readUInt16BE(2);
		offset = 4;
	} else if (len7 === 127) {
		len = Number(data.readBigUInt64BE(2));
		offset = 10;
	}
	if (data.length < offset + 4 + len) return "";
	const mask = data.subarray(offset, offset + 4);
	const payload = data.subarray(offset + 4, offset + 4 + len);
	const out = Buffer.alloc(len);
	for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i % 4]!;
	return out.toString("utf8");
}

export async function startMockQQServer(port = 0): Promise<MockQQServer> {
	const events: string[] = [];
	const messages: MockQQServer["messages"] = [];
	const uploads: string[] = [];
	const partPuts: number[] = [];
	let identify: unknown;
	let heartbeatCount = 0;
	let wsSockets: Socket[] = [];
	const sessionId = randomUUID();

	const httpServer = createServer(
		(req: IncomingMessage, res: ServerResponse) => {
			const url = req.url ?? "";
			if (req.method === "POST" && url.includes("getAppAccessToken")) {
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({ access_token: "MOCK_TOKEN", expires_in: 7200 }),
				);
				return;
			}
			if (req.method === "GET" && url.endsWith("/gateway")) {
				const host = req.headers.host ?? "127.0.0.1:1";
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ url: `ws://${host}/ws` }));
				return;
			}
			res.statusCode = 404;
			res.end("not found");
		},
	);

	const wss = createServer((_req: IncomingMessage, res: ServerResponse) => {
		res.statusCode = 400;
		res.end("websocket only");
	});

	wss.on("upgrade", (req: IncomingMessage, socket: Socket) => {
		const key = req.headers["sec-websocket-key"] as string;
		if (!key) {
			socket.destroy();
			return;
		}
		const accept = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		wsSockets.push(socket);
		// 先发 op10 Hello（客户端收到后才发 Identify）
		socket.write(
			wsFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 500 } })),
		);
		socket.on("data", (chunk: Buffer) => {
			const text = decodeClientFrame(chunk);
			if (!text) return;
			let frame: { op?: number; d?: unknown };
			try {
				frame = JSON.parse(text) as { op?: number; d?: unknown };
			} catch {
				return;
			}
			if (frame.op === 2) {
				identify = frame.d;
				// 回复 READY（op0 dispatch, t=READY, s=1）
				socket.write(
					wsFrame(
						JSON.stringify({
							op: 0,
							s: 1,
							t: "READY",
							d: { session_id: sessionId },
						}),
					),
				);
			} else if (frame.op === 1) {
				heartbeatCount += 1;
				// Heartbeat ACK
				socket.write(wsFrame(JSON.stringify({ op: 11, d: frame.d ?? 0 })));
			} else if (frame.op === 6) {
				// Resume → RESUMED
				socket.write(
					wsFrame(JSON.stringify({ op: 0, s: 999, t: "RESUMED", d: {} })),
				);
			}
		});
		socket.on("close", () => {
			wsSockets = wsSockets.filter((s) => s !== socket);
		});
	});

	await new Promise<void>((resolve) =>
		httpServer.listen(port, "127.0.0.1", resolve),
	);
	await new Promise<void>((resolve) =>
		wss.listen(port === 0 ? 0 : port + 1, "127.0.0.1", resolve),
	);
	const httpPort = (httpServer.address() as { port: number }).port;
	const wsPort = (wss.address() as { port: number }).port;

	// gateway 响应必须指向 WS 端口（此前误用了 http 端口导致客户端连不上）
	httpServer.removeAllListeners("request");
	httpServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
		const url = req.url ?? "";
		if (req.method === "POST" && url.includes("getAppAccessToken")) {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ access_token: "MOCK_TOKEN", expires_in: 7200 }));
			return;
		}
		if (req.method === "GET" && url.endsWith("/gateway")) {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ url: `ws://127.0.0.1:${wsPort}/ws` }));
			return;
		}
		if (
			req.method === "POST" &&
			/\/v2\/(users|groups)\/[^/]+\/messages$/.test(url)
		) {
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
				// 打字指示器（msg_type:6）不是真实回复，不计入 messages
				if (body.msg_type === 6) return;
				messages.push({ path: url, body });
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ id: `sent_${messages.length}` }));
			});
			return;
		}
		if (req.method === "PUT") {
			let size = 0;
			req.on("data", (chunk) => {
				size += chunk.length;
			});
			req.on("end", () => {
				partPuts.push(size);
				res.statusCode = 200;
				res.end("ok");
			});
			return;
		}
		if (
			req.method === "POST" &&
			/\/v2\/(users|groups)\/[^/]+\/files\/upload_prepare$/.test(url)
		) {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk.toString();
			});
			req.on("end", () => {
				const body = JSON.parse(raw || "{}") as { file_size?: number };
				const fileSize = body.file_size ?? 0;
				const blockSize = 1024 * 1024;
				const totalParts = Math.max(1, Math.ceil(fileSize / blockSize));
				const urls = Array.from({ length: totalParts }, (_, i) => ({
					url: `http://127.0.0.1:${httpPort}/parts/${i + 1}`,
					part_number: i + 1,
				}));
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						file_uuid: "uuid_1",
						upload_id: "up_1",
						block_size: blockSize,
						max_parts: totalParts,
						urls,
					}),
				);
			});
			return;
		}
		if (
			req.method === "POST" &&
			/\/v2\/(users|groups)\/[^/]+\/files\/upload_part_finish$/.test(url)
		) {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk.toString();
			});
			req.on("end", () => {
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({ file_info: `file_info_chunked_${partPuts.length}` }),
				);
			});
			return;
		}
		if (
			req.method === "POST" &&
			/\/v2\/(users|groups)\/[^/]+\/files$/.test(url)
		) {
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
				if (typeof body.file_data !== "string" || body.file_data === "") {
					res.statusCode = 400;
					res.end(JSON.stringify({ code: 400, message: "missing file_data" }));
					return;
				}
				uploads.push(url);
				res.setHeader("Content-Type", "application/json");
				res.end(
					JSON.stringify({
						file_info: `file_info_${uploads.length}`,
						ttl: 600,
					}),
				);
			});
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});

	return {
		baseUrl: `http://127.0.0.1:${httpPort}`,
		events,
		get identify() {
			return identify;
		},
		get heartbeatCount() {
			return heartbeatCount;
		},
		messages,
		uploads,
		partPuts,
		sendEvent(t: string, d: unknown) {
			events.push(t);
			const payload = JSON.stringify({ op: 0, s: Date.now(), t, d });
			for (const socket of wsSockets) socket.write(wsFrame(payload));
		},
		async close() {
			for (const socket of wsSockets) socket.destroy();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

/** 构造一条 C2C 消息事件（M1 测试可复用） */
export function c2cMessageEvent(overrides: Record<string, unknown> = {}): {
	t: string;
	d: unknown;
} {
	return {
		t: "C2C_MESSAGE_CREATE",
		d: {
			id: `msg_${randomUUID().slice(0, 8)}`,
			author: { user_openid: "user_openid_test" },
			content: "hello",
			timestamp: String(Math.floor(Date.now() / 1000)),
			message_type: 0,
			attachments: [],
			...overrides,
		},
	};
}

/** 构造一条群 @ 消息事件（M4 测试用） */
export function groupAtMessageEvent(overrides: Record<string, unknown> = {}): {
	t: string;
	d: unknown;
} {
	return {
		t: "GROUP_AT_MESSAGE_CREATE",
		d: {
			id: `group_msg_${randomUUID().slice(0, 8)}`,
			author: { user_openid: "group_user_1" },
			content: "群消息内容",
			timestamp: String(Math.floor(Date.now() / 1000)),
			group_openid: "group_openid_1",
			message_type: 0,
			attachments: [],
			...overrides,
		},
	};
}
