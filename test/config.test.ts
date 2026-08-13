/**
 * config 加载/校验单测（spec §10.1，node:test + node:assert）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	writeFileSync,
	statSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadConfig,
	saveConfig,
	CONFIG_SCHEMA_VERSION,
	ConfigError,
	expandHome,
} from "../src/core/config.ts";

function writeTempConfig(partial: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-qq-bridge-test-"));
	const file = join(dir, "config.json");
	writeFileSync(file, JSON.stringify(partial), "utf8");
	return file;
}

function cleanup(file: string): void {
	try {
		rmSync(join(file, ".."), { recursive: true, force: true });
	} catch {
		// 测试清理尽力而为：临时目录残留不影响断言结果
	}
}

test("默认值合并：最小合法配置产出全量字段", () => {
	const file = writeTempConfig({
		schemaVersion: 4,
		appId: "123",
		clientSecret: "abc",
	});
	try {
		const cfg = loadConfig(file);
		assert.equal(cfg.schemaVersion, 4);
		assert.equal(cfg.appId, "123");
		assert.equal(cfg.clientSecret, "abc");
		// 默认值
		assert.equal(cfg.sandbox, true);
		assert.equal(cfg.startup.mode, "auto");
		assert.equal(cfg.sessions.idleDisposeMs, 1800000);
		assert.equal(cfg.outboundMedia.uploadMode, "auto");
		assert.equal(cfg.outboundMedia.base64UploadMaxBytes, 5242880);
		assert.deepEqual(cfg.media.documents.allowExtensions, [
			".txt",
			".pdf",
			".doc",
		]);
		assert.equal(cfg.workspaces.length, 1);
		assert.equal(cfg.workspaces[0]?.name, "default");
	} finally {
		cleanup(file);
	}
});

test("用户配置覆盖默认值（嵌套）", () => {
	const file = writeTempConfig({
		schemaVersion: 4,
		appId: "123",
		clientSecret: "abc",
		sandbox: false,
		outboundMedia: { enabled: true, uploadMode: "chunked" },
	});
	try {
		const cfg = loadConfig(file);
		assert.equal(cfg.sandbox, false);
		assert.equal(cfg.outboundMedia.enabled, true);
		assert.equal(cfg.outboundMedia.uploadMode, "chunked");
		// 未提供的兄弟字段保留默认
		assert.equal(cfg.outboundMedia.maxFileBytes, 20971520);
	} finally {
		cleanup(file);
	}
});

test("P1-9 裁决：schemaVersion 缺失 → 拒绝", () => {
	const file = writeTempConfig({ appId: "123", clientSecret: "abc" });
	try {
		assert.throws(() => loadConfig(file), ConfigError);
	} finally {
		cleanup(file);
	}
});

test("P1-9 裁决：schemaVersion=3（旧版本）→ 拒绝，不静默迁移", () => {
	const file = writeTempConfig({
		schemaVersion: 3,
		appId: "123",
		clientSecret: "abc",
	});
	try {
		assert.throws(
			() => loadConfig(file),
			(err: unknown) =>
				err instanceof ConfigError && /版本不兼容/.test(err.message),
		);
	} finally {
		cleanup(file);
	}
});

test("schemaVersion=5（未来版本）→ 拒绝", () => {
	const file = writeTempConfig({
		schemaVersion: 5,
		appId: "123",
		clientSecret: "abc",
	});
	try {
		assert.throws(() => loadConfig(file), ConfigError);
	} finally {
		cleanup(file);
	}
});

test("缺少 appId / clientSecret → 拒绝", () => {
	const file1 = writeTempConfig({ schemaVersion: 4, clientSecret: "abc" });
	const file2 = writeTempConfig({ schemaVersion: 4, appId: "123" });
	try {
		assert.throws(() => loadConfig(file1), /appId/);
		assert.throws(() => loadConfig(file2), /clientSecret/);
	} finally {
		cleanup(file1);
		cleanup(file2);
	}
});

test("非法 JSON → 拒绝并给出可读信息", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-qq-bridge-test-"));
	const file = join(dir, "config.json");
	writeFileSync(file, "{ not json", "utf8");
	try {
		assert.throws(() => loadConfig(file), /不是合法 JSON/);
	} finally {
		cleanup(file);
	}
});

test("saveConfig：原子写入 + 0600 权限 + roundtrip", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-qq-bridge-test-"));
	const file = join(dir, "config.json");
	try {
		const src = writeTempConfig({
			schemaVersion: 4,
			appId: "123",
			clientSecret: "abc",
		});
		const cfg = loadConfig(src);
		rmSync(join(src, ".."), { recursive: true, force: true });
		saveConfig(file, cfg);
		const mode = statSync(file).mode & 0o777;
		assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`);
		const roundtrip = loadConfig(file);
		assert.equal(roundtrip.appId, "123");
		assert.equal(roundtrip.sessions.maxResident, 8);
		assert.equal(existsSync(`${file}.tmp`), false, "tmp 文件不应残留");
	} finally {
		cleanup(file);
	}
});

test("expandHome：~/ 展开为 HOME", () => {
	assert.equal(expandHome("~/x"), `${process.env.HOME}/x`);
	assert.equal(expandHome("/abs/path"), "/abs/path");
	assert.equal(expandHome("rel/path"), "rel/path");
});

test("CONFIG_SCHEMA_VERSION 与 spec §6.11 一致", () => {
	assert.equal(CONFIG_SCHEMA_VERSION, 4);
});
