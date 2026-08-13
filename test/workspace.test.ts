/**
 * M5：workspace 注册表 + /workspace 命令 + 会话切换隔离
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	WorkspaceRegistry,
	WorkspaceError,
	isValidWorkspaceName,
} from "../src/session/workspace-registry.ts";
import { ConversationRegistry } from "../src/session/conversation-registry.ts";
import { QQRouter } from "../src/router.ts";
import {
	makeTestConfig,
	makeApi,
	FakeRegistry,
	FakeSession,
	msg,
	type SentMessage,
} from "./helpers.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pi-qq-bridge-${prefix}-`));
}

// ── WorkspaceRegistry ────────────────────────────────────────────

test("注册表：default 恒存在；配置 workspace 解析为 realpath", () => {
	const dir = tempDir("ws");
	try {
		const registry = new WorkspaceRegistry(
			[{ name: "research", path: dir }],
			"/tmp",
		);
		assert.equal(registry.has("default"), true);
		assert.equal(registry.has("research"), true);
		const resolved = registry.resolve("research");
		assert.equal(resolved.path, dir);
		assert.equal(registry.resolve("default").path, "/tmp");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("注册表：非法名称 / 相对路径 / 不存在路径拒绝", () => {
	const dir = tempDir("ws");
	try {
		assert.throws(
			() => new WorkspaceRegistry([{ name: "bad name!", path: dir }], "/tmp"),
			WorkspaceError,
		);
		assert.throws(
			() =>
				new WorkspaceRegistry([{ name: "ok", path: "relative/path" }], "/tmp"),
			/绝对路径/,
		);
		assert.throws(
			() =>
				new WorkspaceRegistry(
					[{ name: "ok", path: "/nonexistent/xyz" }],
					"/tmp",
				),
			/不存在/,
		);
		assert.equal(isValidWorkspaceName("a-b_1"), true);
		assert.equal(isValidWorkspaceName("a b"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("注册表：add/remove（default 不可移除）", () => {
	const dir = tempDir("ws");
	try {
		const registry = new WorkspaceRegistry([], "/tmp");
		const added = registry.add("proj", dir, "项目目录");
		assert.equal(added.path, dir);
		assert.equal(registry.resolve("proj").name, "proj");
		// 重复 add 拒绝
		assert.throws(() => registry.add("proj", dir), /已存在/);
		registry.remove("proj");
		assert.equal(registry.has("proj"), false);
		assert.throws(() => registry.remove("default"), /不可移除/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── ConversationRegistry × workspace ─────────────────────────────

test("registry：切换 workspace 后旧会话 dispose、新会话用新 cwd", async () => {
	const dirA = tempDir("wsA");
	const dirB = tempDir("wsB");
	try {
		const cfg = makeTestConfig();
		// fake session：init 记录 cwd，dispose 计数（避免真调 SDK）
		const initCwds: string[] = [];
		let disposed = 0;
		const factory = {
			create: (): import("../src/session/qq-session.ts").QQSessionLike => {
				const session = new FakeSession({});
				// 包装 init 记录 cwd、dispose 计数（dispose 需保存原引用防递归）
				const originalDispose = session.dispose.bind(session);
				return Object.assign(session, {
					async init(cwd: string): Promise<void> {
						initCwds.push(cwd);
					},
					async dispose(): Promise<void> {
						disposed += 1;
						await originalDispose();
					},
				});
			},
		};
		const registry = new ConversationRegistry(cfg, "/tmp/agent", dirA, factory);
		const m = msg({ id: "m1" });
		// 第一次 get：workspace=default(dirA)
		await registry.get(m);
		assert.equal(registry.residentCount, 1);
		assert.equal(registry.currentWorkspace.path, dirA);
		assert.deepEqual(initCwds, [dirA]);
		// 切换
		await registry.setWorkspace("proj", dirB);
		assert.equal(registry.residentCount, 0, "切换后旧会话全部释放");
		assert.equal(disposed, 1, "旧会话应被 dispose");
		assert.equal(registry.currentWorkspace.name, "proj");
		// 新 get：以 dirB 为 cwd
		await registry.get(m);
		assert.equal(registry.residentCount, 1);
		assert.deepEqual(
			initCwds,
			[dirA, dirB],
			"新会话应以新 workspace 路径为 cwd",
		);
		// 幂等：同 workspace 重复 set 不清理
		await registry.setWorkspace("proj", dirB);
		assert.equal(registry.residentCount, 1, "同 workspace 切换应幂等");
		await registry.dispose();
	} finally {
		rmSync(dirA, { recursive: true, force: true });
		rmSync(dirB, { recursive: true, force: true });
	}
});

// ── router /workspace 命令 ───────────────────────────────────────

test("/workspace：无参数列出 + 切换（admin）", async () => {
	const dirB = tempDir("wsB");
	try {
		const sent: SentMessage[] = [];
		const registry = new FakeRegistry();
		const ws = new WorkspaceRegistry(
			[{ name: "research", path: dirB }],
			"/tmp",
		);
		const cfg = makeTestConfig({
			commands: { ...makeTestConfig().commands, admins: ["user_allowed"] },
		});
		const router = new QQRouter(cfg, registry, makeApi(sent), {
			workspaceRegistry: ws,
		});
		// 列出
		router.handleInbound(msg({ id: "m_list", text: "/workspace" }));
		await new Promise((r) => setTimeout(r, 50));
		assert.match(sent[0]?.content ?? "", /工作区/);
		assert.match(sent[0]?.content ?? "", /research/);
		// 切换
		router.handleInbound(msg({ id: "m_sw", text: "/workspace research" }));
		await new Promise((r) => setTimeout(r, 50));
		assert.match(sent[1]?.content ?? "", /已切换工作区/);
		assert.match(sent[1]?.content ?? "", /research/);
		// 不存在的 workspace
		router.handleInbound(msg({ id: "m_bad", text: "/workspace nope" }));
		await new Promise((r) => setTimeout(r, 50));
		assert.match(sent[2]?.content ?? "", /不存在/);
	} finally {
		rmSync(dirB, { recursive: true, force: true });
	}
});

test("/workspace：非 admin 无法切换（授权矩阵）", async () => {
	const dirB = tempDir("wsB");
	try {
		const sent: SentMessage[] = [];
		const registry = new FakeRegistry();
		const ws = new WorkspaceRegistry(
			[{ name: "research", path: dirB }],
			"/tmp",
		);
		const cfg = makeTestConfig({
			commands: { ...makeTestConfig().commands, admins: [] },
		});
		const router = new QQRouter(cfg, registry, makeApi(sent), {
			workspaceRegistry: ws,
		});
		router.handleInbound(msg({ id: "m_sw", text: "/workspace research" }));
		await new Promise((r) => setTimeout(r, 50));
		assert.match(sent[0]?.content ?? "", /没有 QQ 会话管理权限/);
		assert.equal(
			registry.currentWorkspace?.name ?? "default",
			"default",
			"不应切换",
		);
	} finally {
		rmSync(dirB, { recursive: true, force: true });
	}
});

test("/workspace add/remove：QQ 侧提示到本地执行", async () => {
	const sent: SentMessage[] = [];
	const registry = new FakeRegistry();
	const ws = new WorkspaceRegistry([], "/tmp");
	const cfg = makeTestConfig({
		commands: { ...makeTestConfig().commands, admins: ["user_allowed"] },
	});
	const router = new QQRouter(cfg, registry, makeApi(sent), {
		workspaceRegistry: ws,
	});
	router.handleInbound(msg({ id: "m_add", text: "/workspace add x /tmp" }));
	await new Promise((r) => setTimeout(r, 50));
	assert.match(sent[0]?.content ?? "", /主机终端/);
});
