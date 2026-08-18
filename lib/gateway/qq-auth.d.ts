/**
 * Access Token 管理（spec §6.1）
 *
 * - 启动即获取；expires_in 7200s，过期前 60s 预刷新
 * - 连续 3 次刷新失败 → 触发 fatal 回调（网关断开并通知用户）
 * - API 401 时 forceRefresh 后重试一次（调用方负责）
 * - 凭据仅内存，不落盘、不进日志
 */
export declare const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export declare function validateTokenUrl(url: string): void;
export interface QQAuthOptions {
    /** 覆盖 token 端点（测试/代理用） */
    tokenUrl?: string;
    /** 预刷新窗口（ms），默认 60s */
    refreshAheadMs?: number;
    /** 连续失败上限，默认 3 */
    maxFailures?: number;
    /** token 端点请求超时，默认 15s */
    timeoutMs?: number;
}
export declare class QQAuth {
    private token;
    private expiresAt;
    private refreshTimer;
    private refreshPromise;
    private failures;
    private readonly tokenUrl;
    private readonly refreshAheadMs;
    private readonly maxFailures;
    private readonly timeoutMs;
    /** fatal 回调：连续刷新失败时通知（网关断开 + 用户提示） */
    onFatal: ((reason: string) => void) | undefined;
    private readonly appId;
    private readonly clientSecret;
    constructor(appId: string, clientSecret: string, options?: QQAuthOptions);
    /** 获取有效 token（未过期直接返回，否则刷新） */
    getToken(): Promise<string>;
    /** 立即刷新（并发去抖：进行中的刷新共享同一 Promise） */
    forceRefresh(): Promise<string>;
    private refresh;
    private scheduleRefresh;
    /** 刷新失败后的重试：指数退避 5s → 30s */
    private scheduleRetry;
    private clearTimer;
    /** 停止定时器（stop 时调用） */
    dispose(): void;
}
//# sourceMappingURL=qq-auth.d.ts.map