/**
 * Access Token 管理（spec §6.1）
 *
 * - 启动即获取；expires_in 7200s，过期前 60s 预刷新
 * - 连续 3 次刷新失败 → 触发 fatal 回调（网关断开并通知用户）
 * - API 401 时 forceRefresh 后重试一次（调用方负责）
 * - 凭据仅内存，不落盘、不进日志
 */
export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
/** token 端点允许的主机（防 SSRF：tokenUrl 只能指向这些主机） */
const ALLOWED_TOKEN_HOSTS = new Set([
    "bots.qq.com",
    "api.bot.qq.com",
    "localhost",
    "127.0.0.1",
    "::1",
]);
export function validateTokenUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`token 端点不是合法 URL：${url}`);
    }
    if (parsed.protocol !== "https:" &&
        parsed.hostname !== "localhost" &&
        parsed.hostname !== "127.0.0.1" &&
        parsed.hostname !== "::1") {
        throw new Error(`token 端点必须使用 HTTPS：${url}`);
    }
    if (!ALLOWED_TOKEN_HOSTS.has(parsed.hostname)) {
        throw new Error(`token 端点主机不在白名单：${parsed.hostname}`);
    }
}
export class QQAuth {
    token;
    expiresAt = 0;
    refreshTimer;
    refreshPromise;
    failures = 0;
    tokenUrl;
    refreshAheadMs;
    maxFailures;
    timeoutMs;
    /** fatal 回调：连续刷新失败时通知（网关断开 + 用户提示） */
    onFatal;
    appId;
    clientSecret;
    constructor(appId, clientSecret, options = {}) {
        this.appId = appId;
        this.clientSecret = clientSecret;
        this.tokenUrl = options.tokenUrl ?? QQ_TOKEN_URL;
        validateTokenUrl(this.tokenUrl);
        this.refreshAheadMs = options.refreshAheadMs ?? 60_000;
        this.maxFailures = options.maxFailures ?? 3;
        this.timeoutMs = options.timeoutMs ?? 15_000;
    }
    /** 获取有效 token（未过期直接返回，否则刷新） */
    async getToken() {
        if (this.token && Date.now() < this.expiresAt - this.refreshAheadMs)
            return this.token;
        return this.forceRefresh();
    }
    /** 立即刷新（并发去抖：进行中的刷新共享同一 Promise） */
    forceRefresh() {
        this.refreshPromise ??= this.refresh();
        return this.refreshPromise.finally(() => {
            this.refreshPromise = undefined;
        });
    }
    async refresh() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(this.tokenUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    appId: this.appId,
                    clientSecret: this.clientSecret,
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`token 端点 HTTP ${res.status} ${res.statusText}`);
            }
            const body = (await res.json());
            if (typeof body.access_token !== "string" || body.access_token === "") {
                throw new Error("token 响应缺少 access_token");
            }
            const expiresIn = Number.isFinite(body.expires_in)
                ? body.expires_in
                : 7200;
            this.token = body.access_token;
            this.expiresAt = Date.now() + expiresIn * 1000;
            this.failures = 0;
            this.scheduleRefresh();
            return this.token;
        }
        catch (err) {
            this.failures += 1;
            this.scheduleRetry();
            const reason = `${err.message}（第 ${this.failures} 次失败）`;
            if (this.failures >= this.maxFailures) {
                this.onFatal?.(reason);
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    scheduleRefresh() {
        this.clearTimer();
        const delay = Math.max(1000, this.expiresAt - Date.now() - this.refreshAheadMs);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.forceRefresh().catch(() => {
                // 失败已计入 failures；定时器由 scheduleRetry 接管
            });
        }, delay);
        this.refreshTimer.unref?.();
    }
    /** 刷新失败后的重试：指数退避 5s → 30s */
    scheduleRetry() {
        this.clearTimer();
        const delay = Math.min(30_000, 5_000 * 2 ** (this.failures - 1));
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.forceRefresh().catch(() => {
                // 同上
            });
        }, delay);
        this.refreshTimer.unref?.();
    }
    clearTimer() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }
    /** 停止定时器（stop 时调用） */
    dispose() {
        this.clearTimer();
    }
}
//# sourceMappingURL=qq-auth.js.map