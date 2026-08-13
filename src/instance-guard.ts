/**
 * 多实例守卫（spec §6.12，P0-2：M8 前单实例策略）
 *
 * - O_EXCL 创建锁文件；抢锁失败且 pid 存活 → 拒绝启动
 * - 陈旧锁（pid 不存在 或 mtime 超 5min）→ 删除后重试一次
 * - 进程退出路径（exit/SIGINT/SIGTERM/uncaughtException/unhandledRejection）统一释放
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_LOCK_PATH = "~/.dsh/qq-bridge/qq-bridge.lock";
const STALE_MTIME_MS = 5 * 60 * 1000;

export interface InstanceLock {
	pid: number;
	startedAt: number;
	/** 锁文件路径（release 时删除） */
	path: string;
}

/** 抢锁结果：持有锁（含 release）或失败原因 */
export type AcquireResult =
	| { held: true; lock: InstanceLock }
	| { held: false; reason: string };

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = 进程不存在；EPERM = 存在但无权限（视为存活）；EINVAL = 平台不支持
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isStale(path: string): boolean {
	try {
		const raw = readFileSync(path, "utf8");
		const data = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
		if (typeof data.pid === "number" && !isPidAlive(data.pid)) return true;
	} catch {
		// 内容不可解析：退回 mtime 判断
	}
	try {
		const mtime = statSync(path).mtimeMs;
		if (Date.now() - mtime > STALE_MTIME_MS) return true;
	} catch {
		return false; // 文件已不存在
	}
	return false;
}

/**
 * 尝试获取单实例锁。
 * - 成功：返回 held:true，调用方必须持有 release（进程退出时自动兜底释放）
 * - 失败：返回 held:false + 人类可读原因（/qqbot-status 直接展示）
 */
export function acquireInstanceLock(lockPath: string): AcquireResult {
	try {
		const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
		writeFileSync(lockPath, payload, { flag: "wx", mode: 0o600 });
		const lock: InstanceLock = {
			pid: process.pid,
			startedAt: Date.now(),
			path: lockPath,
		};
		registerExitCleanup(lock);
		return { held: true, lock };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
			return {
				held: false,
				reason: `无法创建锁文件 ${lockPath}：${(err as Error).message}`,
			};
		}
		if (isStale(lockPath)) {
			try {
				rmSync(lockPath);
				// 重试一次
				return acquireInstanceLock(lockPath);
			} catch {
				return {
					held: false,
					reason: `锁文件 ${lockPath} 已陈旧但无法删除，请手动清理`,
				};
			}
		}
		// 锁被存活实例持有
		let owner = "";
		try {
			const data = JSON.parse(readFileSync(lockPath, "utf8")) as {
				pid?: unknown;
			};
			if (typeof data.pid === "number") owner = `（pid ${data.pid}）`;
		} catch {
			// 忽略解析失败
		}
		return {
			held: false,
			reason: `另一 dsh 实例 ${owner} 已持有 QQ 网关（锁文件 ${lockPath}）`,
		};
	}
}

function registerExitCleanup(lock: InstanceLock): void {
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			if (existsSync(lock.path)) rmSync(lock.path);
		} catch {
			// 尽力而为
		}
	};
	process.once("exit", release);
	process.once("SIGINT", release);
	process.once("SIGTERM", release);
	process.once("uncaughtException", release);
	process.once("unhandledRejection", release);
}

/** 锁是否仍归当前进程所有（定期校验用：锁丢失/被转移 → 调用方应断开网关） */
export function isLockHeldByMe(lockPath: string): boolean {
	try {
		const data = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
		return data.pid === process.pid;
	} catch {
		return false;
	}
}

/** 目录存在性辅助（锁文件父目录） */
export function ensureLockDir(lockPath: string): void {
	const dir = dirname(lockPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
