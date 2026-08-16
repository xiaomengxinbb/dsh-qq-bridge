/**
 * 配置加载（spec §6.11，schemaVersion 4）— 移植自 pi-qq-bridge，宿主无关
 *
 * 迁移策略（spec §6.11 P1-9 裁决）：
 *   - schemaVersion 缺失或 !== 4 → 拒绝加载并抛错（不静默迁移）
 *   - 未来升级：写显式逐级迁移函数（old→new），必须可单测
 * DSH 适配：配置文件路径从 ~/.pi/agent 改为 ~/.dsh/qq-bridge（DSH home 体系）。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const CONFIG_SCHEMA_VERSION = 4;
export const DEFAULT_CONFIG_PATH = "~/.dsh/qq-bridge/config.json";

/** 配置错误：携带用户可读信息，index.ts 捕获后提示重新生成配置 */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export interface PiQQBridgeConfig {
	schemaVersion: 4;
	enabled: boolean;
	startup: {
		mode: "auto" | "manual";
		keepAcrossLocalSessions: boolean;
		handoffGraceMs: number;
	};
	appId: string;
	clientSecret: string;
	sandbox: boolean;
	gateway: {
		/** 自动重连最大次数，0 = 无限重连（默认 0，避免静默掉线后 bot 永久失联） */
		maxReconnectAttempts: number;
		/** 重连退避基数 ms，默认 1000 */
		reconnectBaseMs: number;
		/** 重连退避上限 ms，默认 30000 */
		reconnectMaxMs: number;
	};
	allowUsers: string[];
	allowGroups: string[];
	workspaces: { name: string; path: string; description?: string }[];
	commands: {
		enabled: boolean;
		accessRequests: boolean;
		allowInGroups: boolean;
		admins: string[];
		buttons: boolean;
		maxListItems: number;
		modelPageSize: number;
		selectionTtlMs: number;
		confirmationTtlMs: number;
	};
	sessions: {
		mode: "persistent" | "memory";
		restore: "recent" | "new";
		maxResident: number;
		idleDisposeMs: number;
	};
	replyFormat: "auto" | "plain";
	showProcess: boolean;
	progress: { enabled: boolean; ackAfterMs: number };
	maxQueueSize: number;
	media: {
		enabled: boolean;
		maxAttachments: number;
		maxTotalBytes: number;
		downloadTimeoutMs: number;
		image: { maxBytes: number };
		voice: {
			enabled: boolean;
			preferQQAsr: boolean;
			maxBytes: number;
			stt?: { baseUrl?: string; apiKeyEnv?: string; model?: string; timeoutMs?: number };
		};
		documents: {
			allowExtensions: string[];
			maxTxtBytes: number;
			maxPdfBytes: number;
			maxDocBytes: number;
			maxPdfPages: number;
			maxExtractedChars: number;
		};
	};
	outboundMedia: {
		enabled: boolean;
		adminsOnly: boolean;
		allowPrivate: boolean;
		allowGroups: boolean;
		allowedRoots: string[];
		images: boolean;
		files: boolean;
		maxFilesPerTurn: number;
		maxImageBytes: number;
		maxFileBytes: number;
		maxTotalBytes: number;
		uploadTimeoutMs: number;
		uploadMode: "auto" | "base64" | "chunked";
		base64UploadMaxBytes: number;
		chunked: {
			maxParts: number;
			partConcurrency: number;
			prepareTimeoutMs: number;
			partTimeoutMs: number;
		};
	};
	logging: { level: "error" | "info" | "debug" };
	debug: boolean;
}

export const DEFAULT_CONFIG: PiQQBridgeConfig = {
	schemaVersion: 4,
	enabled: true,
	startup: {
		mode: "auto",
		keepAcrossLocalSessions: true,
		handoffGraceMs: 10000,
	},
	// appId / clientSecret 无默认值，校验时拒绝空串（mergeDefaults 只迭代默认键，
	// 必须放在这里占位，否则用户提供的值会被丢弃）
	appId: "",
	clientSecret: "",
	sandbox: true,
	gateway: {
		maxReconnectAttempts: 0,
		reconnectBaseMs: 1000,
		reconnectMaxMs: 30000,
	},
	allowUsers: [],
	allowGroups: [],
	workspaces: [{ name: "default", path: "" }],
	commands: {
		enabled: true,
		accessRequests: true,
		allowInGroups: false,
		admins: [],
		buttons: true,
		maxListItems: 5,
		modelPageSize: 6,
		selectionTtlMs: 300000,
		confirmationTtlMs: 120000,
	},
	sessions: {
		mode: "persistent",
		restore: "recent",
		maxResident: 8,
		idleDisposeMs: 1800000,
	},
	replyFormat: "auto",
	showProcess: false,
	// ackAfterMs 3000→8000：首条授权消息需现场创建隔离会话（约 3.5s），
	// 3s 回执会与真实回复几乎同时发出造成顺序错乱；8s 只对真正慢任务发回执
	progress: { enabled: true, ackAfterMs: 8000 },
	maxQueueSize: 20,
	media: {
		enabled: true,
		maxAttachments: 4,
		maxTotalBytes: 31457280,
		downloadTimeoutMs: 120000,
		image: { maxBytes: 10485760 },
		voice: {
			enabled: true,
			preferQQAsr: true,
			maxBytes: 26214400,
			stt: { apiKeyEnv: "QQBOT_STT_API_KEY", model: "whisper-1", timeoutMs: 60000 },
		},
		documents: {
			allowExtensions: [".txt", ".pdf", ".doc"],
			maxTxtBytes: 2097152,
			maxPdfBytes: 20971520,
			maxDocBytes: 10485760,
			maxPdfPages: 100,
			maxExtractedChars: 150000,
		},
	},
	outboundMedia: {
		enabled: false,
		adminsOnly: true,
		allowPrivate: true,
		allowGroups: false,
		allowedRoots: [],
		images: true,
		files: true,
		maxFilesPerTurn: 2,
		maxImageBytes: 10485760,
		maxFileBytes: 20971520,
		maxTotalBytes: 31457280,
		uploadTimeoutMs: 30000,
		uploadMode: "auto",
		base64UploadMaxBytes: 5242880,
		chunked: {
			maxParts: 128,
			partConcurrency: 2,
			prepareTimeoutMs: 15000,
			partTimeoutMs: 60000,
		},
	},
	logging: { level: "info" },
	debug: false,
};

/** 逐层深合并默认值（只覆盖用户提供的键，不信任用户传入未知 schema） */
function mergeDefaults<T extends Record<string, unknown>>(
	defaults: T,
	user: unknown,
): T {
	if (user === undefined || user === null) return { ...defaults };
	if (typeof user !== "object" || Array.isArray(user)) return { ...defaults };
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(defaults)) {
		const dv = defaults[key];
		const uv = (user as Record<string, unknown>)[key];
		if (uv === undefined) {
			out[key] = Array.isArray(dv) ? [...(dv as unknown[])] : dv;
		} else if (
			typeof dv === "object" &&
			dv !== null &&
			!Array.isArray(dv) &&
			typeof uv === "object" &&
			uv !== null &&
			!Array.isArray(uv)
		) {
			out[key] = mergeDefaults(dv as Record<string, unknown>, uv);
		} else {
			out[key] = uv;
		}
	}
	return out as T;
}

/** 加载并校验配置。任何错误抛 ConfigError（用户可读）。 */
export function loadConfig(filePath: string): PiQQBridgeConfig {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		throw new ConfigError(
			`无法读取配置文件 ${filePath}：${(err as Error).message}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ConfigError(`配置文件 ${filePath} 不是合法 JSON，请检查格式`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConfigError(`配置文件 ${filePath} 顶层必须是 JSON 对象`);
	}
	const schemaVersion = (parsed as Record<string, unknown>).schemaVersion;
	// P1-9 裁决：不静默迁移，版本不匹配直接拒绝
	if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
		throw new ConfigError(
			`配置版本不兼容：期望 schemaVersion=${CONFIG_SCHEMA_VERSION}，实际为 ${JSON.stringify(schemaVersion)}。` +
				`请重新生成配置文件（${DEFAULT_CONFIG_PATH}）`,
		);
	}
	const merged = mergeDefaults(
		DEFAULT_CONFIG as unknown as Record<string, unknown>,
		parsed,
	) as unknown as PiQQBridgeConfig;

	// 关键字段类型校验（M0 最小集；M2 补全量校验）
	if (typeof merged.appId !== "string" || merged.appId.trim() === "") {
		throw new ConfigError("缺少 appId（QQ 开放平台机器人 AppID）");
	}
	if (
		typeof merged.clientSecret !== "string" ||
		merged.clientSecret.trim() === ""
	) {
		throw new ConfigError("缺少 clientSecret（QQ 开放平台机器人密钥）");
	}
	if (typeof merged.sandbox !== "boolean")
		throw new ConfigError("sandbox 必须是布尔值");
	if (!["auto", "manual"].includes(merged.startup.mode))
		throw new ConfigError("startup.mode 必须是 auto 或 manual");
	if (!["persistent", "memory"].includes(merged.sessions.mode))
		throw new ConfigError("sessions.mode 必须是 persistent 或 memory");

	return merged;
}

/** 原子持久化（spec §6.13：tmp + rename，0600）。返回写出的路径。 */
export function saveConfig(filePath: string, config: PiQQBridgeConfig): void {
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	renameSync(tmp, filePath);
}

/** 展开 ~ 为 HOME（配置路径用） */
export function expandHome(p: string): string {
	if (p === "~") return process.env.HOME ?? process.cwd();
	if (p.startsWith("~/"))
		return `${process.env.HOME ?? process.cwd()}/${p.slice(2)}`;
	return p;
}
