/**
 * 多实例守卫单测（spec §10.1 instance-guard.test.ts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	existsSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireInstanceLock,
	ensureLockDir,
	isLockHeldByMe,
} from "../src/instance-guard.ts";

function makeLockPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-qq-bridge-lock-test-"));
	return join(dir, "bridge.lock");
}

function cleanup(lockPath: string): void {
	try {
		rmSync(join(lockPath, ".."), { recursive: true, force: true });
	} catch {
		// 测试清理尽力而为
	}
}

test("首次获取锁成功，重复获取被拒（pid 存活）", () => {
	const lockPath = makeLockPath();
	ensureLockDir(lockPath);
	try {
		const first = acquireInstanceLock(lockPath);
		assert.equal(first.held, true);
		const second = acquireInstanceLock(lockPath);
		assert.equal(second.held, false);
		assert.match(second.reason, /另一 dsh 实例/);
	} finally {
		cleanup(lockPath);
	}
});

test("释放后（文件删除）可重新获取", () => {
	const lockPath = makeLockPath();
	ensureLockDir(lockPath);
	try {
		const first = acquireInstanceLock(lockPath);
		assert.equal(first.held, true);
		if (first.held) rmSync(first.lock.path);
		const again = acquireInstanceLock(lockPath);
		assert.equal(again.held, true);
		if (again.held) rmSync(again.lock.path);
	} finally {
		cleanup(lockPath);
	}
});

test("陈旧锁（pid 不存在）被回收后重试成功", () => {
	const lockPath = makeLockPath();
	ensureLockDir(lockPath);
	try {
		// 伪造一个必然不存在的 pid（Linux pid_max 上限内的大值；若恰好存在则跳过）
		const deadPid = 99999999;
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: deadPid, startedAt: Date.now() }),
			{ mode: 0o600 },
		);
		const result = acquireInstanceLock(lockPath);
		assert.equal(result.held, true, "陈旧锁应被回收");
	} finally {
		cleanup(lockPath);
	}
});

test("陈旧锁（mtime 超 5min 且内容不可解析）被回收", () => {
	const lockPath = makeLockPath();
	ensureLockDir(lockPath);
	try {
		writeFileSync(lockPath, "garbage-not-json", { mode: 0o600 });
		// 把 mtime 改到 6 分钟前
		const old = new Date(Date.now() - 6 * 60 * 1000);
		utimesSync(lockPath, old, old);
		const result = acquireInstanceLock(lockPath);
		assert.equal(result.held, true, "超时陈旧锁应被回收");
	} finally {
		cleanup(lockPath);
	}
});

test("锁文件不存在时 ensureLockDir 创建父目录", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-qq-bridge-lock-test-"));
	const nested = join(dir, "a", "b", "bridge.lock");
	try {
		ensureLockDir(nested);
		assert.equal(existsSync(join(dir, "a", "b")), true);
	} finally {
		cleanup(nested);
	}
});

test("isLockHeldByMe：本进程持有返回 true；他人持有/文件缺失返回 false", () => {
	const lockPath = makeLockPath();
	ensureLockDir(lockPath);
	try {
		// 写入本进程 pid
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
			{ mode: 0o600 },
		);
		assert.equal(isLockHeldByMe(lockPath), true);
		// 写入其他 pid
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 99999999, startedAt: Date.now() }),
			{ mode: 0o600 },
		);
		assert.equal(isLockHeldByMe(lockPath), false);
		// 文件不存在
		rmSync(lockPath, { force: true });
		assert.equal(isLockHeldByMe(lockPath), false);
		// 内容损坏
		writeFileSync(lockPath, "garbage", { mode: 0o600 });
		assert.equal(isLockHeldByMe(lockPath), false);
	} finally {
		cleanup(lockPath);
	}
});
