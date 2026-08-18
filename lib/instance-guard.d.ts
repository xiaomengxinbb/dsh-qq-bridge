export declare const DEFAULT_LOCK_PATH = "~/.dsh/qq-bridge/qq-bridge.lock";
export interface InstanceLock {
    pid: number;
    startedAt: number;
    /** 锁文件路径（release 时删除） */
    path: string;
}
/** 抢锁结果：持有锁（含 release）或失败原因 */
export type AcquireResult = {
    held: true;
    lock: InstanceLock;
} | {
    held: false;
    reason: string;
};
/**
 * 尝试获取单实例锁。
 * - 成功：返回 held:true，调用方必须持有 release（进程退出时自动兜底释放）
 * - 失败：返回 held:false + 人类可读原因（/qqbot-status 直接展示）
 */
export declare function acquireInstanceLock(lockPath: string): AcquireResult;
/** 锁是否仍归当前进程所有（定期校验用：锁丢失/被转移 → 调用方应断开网关） */
export declare function isLockHeldByMe(lockPath: string): boolean;
/** 目录存在性辅助（锁文件父目录） */
export declare function ensureLockDir(lockPath: string): void;
//# sourceMappingURL=instance-guard.d.ts.map