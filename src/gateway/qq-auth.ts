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

export function validateTokenUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`token 端点不是合法 URL：${url}`);
	}
	if (
		parsed.protocol !== "https:" &&
		parsed.hostname !== "localhost" &&
		parsed.hostname !== "127.0.0.1" &&
		parsed.hostname !== "::1"
	) {
		throw new Error(`token 端点必须使用 HTTPS：${url}`);
	}
	if (!ALLOWED_TOKEN_HOSTS.has(parsed.hostname)) {
		throw new Error(`token 端点主机不在白名单：${parsed.hostname}`);
	}
}

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

interface TokenResponse {
	access_token: string;
	expires_in: number;
}

export class QQAuth {
	private token: string | undefined;
	private expiresAt = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshPromise: Promise<string> | undefined;
	private failures = 0;
	private readonly tokenUrl: string;
	private readonly refreshAheadMs: number;
	private readonly maxFailures: number;
	private readonly timeoutMs: number;

	/** fatal 回调：连续刷新失败时通知（网关断开 + 用户提示） */
	onFatal: ((reason: string) => void) | undefined;

	private readonly appId: string;
	private readonly clientSecret: string;

	constructor(
		appId: string,
		clientSecret: string,
		options: QQAuthOptions = {},
	) {
		this.appId = appId;
		this.clientSecret = clientSecret;
		this.tokenUrl = options.tokenUrl ?? QQ_TOKEN_URL;
		validateTokenUrl(this.tokenUrl);
		this.refreshAheadMs = options.refreshAheadMs ?? 60_000;
		this.maxFailures = options.maxFailures ?? 3;
		this.timeoutMs = options.timeoutMs ?? 15_000;
	}

	/** 获取有效 token（未过期直接返回，否则刷新） */
	async getToken(): Promise<string> {
		if (this.token && Date.now() < this.expiresAt - this.refreshAheadMs)
			return this.token;
		return this.forceRefresh();
	}

	/** 立即刷新（并发去抖：进行中的刷新共享同一 Promise） */
	forceRefresh(): Promise<string> {
		this.refreshPromise ??= this.refresh();
		return this.refreshPromise.finally(() => {
			this.refreshPromise = undefined;
		});
	}

	private async refresh(): Promise<string> {
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
			const body = (await res.json()) as TokenResponse;
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
		} catch (err) {
			this.failures += 1;
			this.scheduleRetry();
			const reason = `${(err as Error).message}（第 ${this.failures} 次失败）`;
			if (this.failures >= this.maxFailures) {
				this.onFatal?.(reason);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	private scheduleRefresh(): void {
		this.clearTimer();
		const delay = Math.max(
			1000,
			this.expiresAt - Date.now() - this.refreshAheadMs,
		);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.forceRefresh().catch(() => {
				// 失败已计入 failures；定时器由 scheduleRetry 接管
			});
		}, delay);
		this.refreshTimer.unref?.();
	}

	/** 刷新失败后的重试：指数退避 5s → 30s */
	private scheduleRetry(): void {
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

	private clearTimer(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	/** 停止定时器（stop 时调用） */
	dispose(): void {
		this.clearTimer();
	}
}
