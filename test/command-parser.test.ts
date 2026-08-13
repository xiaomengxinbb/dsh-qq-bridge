/**
 * 命令解析与权限矩阵单测（spec §10.1）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCommandText, parseQQCommand } from "../src/commands/command-parser.ts";
import {
	QQ_COMMAND_NAMES,
	QQ_REMOTE_BLOCKED_COMMANDS,
	authorizeQQCommand,
	isMutatingQQCommand,
	CommandStateMachine,
} from "../src/commands/command-controller.ts";
import { makeTestConfig, msg } from "./helpers.ts";

// ── parser ────────────────────────────────────────────────────────

test("parseQQCommand：基本解析", () => {
	const cmd = parseQQCommand("/model page 2");
	assert.deepEqual(cmd, {
		name: "model",
		args: ["page", "2"],
		rawArgs: "page 2",
	});
});

test("parseQQCommand：非命令返回 undefined", () => {
	assert.equal(parseQQCommand("hello world"), undefined);
	assert.equal(parseQQCommand(""), undefined);
});

test("parseQQCommand：全角斜杠与 BOM/零宽字符归一化", () => {
	assert.equal(normalizeCommandText("\uFEFF／help"), "/help");
	assert.equal(normalizeCommandText("　/help\u200B"), "/help");
	assert.equal(parseQQCommand("／status")?.name, "status");
});

test("parseQQCommand：别名（qqbot-help → help，cancel → stop）", () => {
	assert.equal(parseQQCommand("/qqbot-help")?.name, "help");
	assert.equal(parseQQCommand("/cancel")?.name, "stop");
});

test("parseQQCommand：引号与转义参数", () => {
	const cmd = parseQQCommand(`/name "我的 会话"`);
	assert.deepEqual(cmd?.args, ["我的 会话"]);
});

test("parseQQCommand：非法命令名 / 超长 / 未闭合引号报错", () => {
	assert.throws(() => parseQQCommand("/bad!name"), /命令名称无效/);
	assert.throws(() => parseQQCommand(`/name "未闭合`), /引号没有闭合/);
	assert.throws(() => parseQQCommand(`/x ${"a".repeat(3000)}`), /命令过长/);
});

// ── 授权矩阵 ─────────────────────────────────────────────────────

test("命令集合：白名单与阻塞集合互不重叠", () => {
	for (const name of QQ_COMMAND_NAMES) {
		assert.equal(
			QQ_REMOTE_BLOCKED_COMMANDS.has(name),
			false,
			`${name} 不应同时出现在白名单与阻塞集合`,
		);
	}
});

test("mutating 命令列表", () => {
	for (const name of [
		"model",
		"thinking",
		"new",
		"resume",
		"name",
		"compact",
		"stop",
		"workspace",
	]) {
		assert.equal(isMutatingQQCommand(name), true, `${name} 应为 mutation`);
	}
	assert.equal(isMutatingQQCommand("help"), false);
	assert.equal(isMutatingQQCommand("status"), false);
});

test("授权：未知命令拒绝", () => {
	const result = authorizeQQCommand(makeTestConfig(), msg(), {
		name: "frobnicate",
		args: [],
		rawArgs: "",
	});
	assert.equal(result.allowed, false);
	assert.match(result.reason, /未知命令/);
});

test("授权：危险命令显式阻塞", () => {
	const result = authorizeQQCommand(makeTestConfig(), msg(), {
		name: "login",
		args: [],
		rawArgs: "",
	});
	assert.equal(result.allowed, false);
	assert.match(result.reason, /受信任的主机终端/);
});

test("授权：commands.enabled=false 时只放行 help/status/last", () => {
	const cfg = makeTestConfig({
		commands: { ...makeTestConfig().commands, enabled: false },
	});
	assert.equal(
		authorizeQQCommand(cfg, msg(), { name: "help", args: [], rawArgs: "" })
			.allowed,
		true,
	);
	assert.equal(
		authorizeQQCommand(cfg, msg(), { name: "status", args: [], rawArgs: "" })
			.allowed,
		true,
	);
	assert.equal(
		authorizeQQCommand(cfg, msg(), { name: "model", args: [], rawArgs: "" })
			.allowed,
		false,
	);
});

test("授权：mutating 命令需要 admin；help/status 不需要", () => {
	const cfg = makeTestConfig(); // admins 为空
	const m = msg({ userOpenId: "user_allowed" });
	assert.equal(
		authorizeQQCommand(cfg, m, { name: "help", args: [], rawArgs: "" }).allowed,
		true,
	);
	assert.equal(
		authorizeQQCommand(cfg, m, { name: "new", args: [], rawArgs: "" }).allowed,
		false,
	);
	assert.equal(
		authorizeQQCommand(cfg, m, { name: "model", args: [], rawArgs: "" })
			.allowed,
		false,
	);
	const adminCfg = makeTestConfig({
		commands: { ...cfg.commands, admins: ["user_allowed"] },
	});
	assert.equal(
		authorizeQQCommand(adminCfg, m, { name: "new", args: [], rawArgs: "" })
			.allowed,
		true,
	);
});

test("授权：群聊 mutation 需 allowInGroups + admin", () => {
	const cfg = makeTestConfig({
		commands: {
			...makeTestConfig().commands,
			admins: ["admin_openid"],
			allowInGroups: false,
		},
	});
	const groupMsg = msg({
		type: "group",
		userOpenId: "admin_openid",
		groupOpenId: "group_1",
	});
	assert.equal(
		authorizeQQCommand(cfg, groupMsg, { name: "new", args: [], rawArgs: "" })
			.allowed,
		false,
	);
	const cfg2 = makeTestConfig({
		commands: { ...cfg.commands, allowInGroups: true },
	});
	assert.equal(
		authorizeQQCommand(cfg2, groupMsg, { name: "new", args: [], rawArgs: "" })
			.allowed,
		true,
	);
});

// ── 命令状态机 ────────────────────────────────────────────────────

test("状态机：set/get 同键，TTL 过期清除，新命令覆盖旧", () => {
	const sm = new CommandStateMachine({
		selectionTtlMs: 1000,
		confirmationTtlMs: 500,
	});
	const now = 1_000_000;
	sm.set("key1", "selection", "model", { candidates: [] }, now);
	assert.equal(sm.get("key1", now)?.command, "model");
	assert.equal(sm.get("key1", now + 1001), undefined, "TTL 过期清除");
	sm.set("key1", "selection", "model", { candidates: [] }, now);
	sm.set("key1", "confirmation", "workspace", {}, now + 10);
	assert.equal(
		sm.get("key1", now + 10)?.kind,
		"confirmation",
		"新命令覆盖旧 pending",
	);
	assert.equal(sm.get("key1", now + 600), undefined, "confirmation TTL 更短");
});

test("状态机：take 消费一次；clear 清空", () => {
	const sm = new CommandStateMachine();
	sm.set("k", "selection", "model", { x: 1 });
	const taken = sm.take("k");
	assert.equal(taken?.command, "model");
	assert.equal(sm.get("k"), undefined, "take 后不再有 pending");
	sm.set("k", "selection", "model", { x: 2 });
	sm.clear("k");
	assert.equal(sm.get("k"), undefined);
});
