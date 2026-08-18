export declare const CONFIG_SCHEMA_VERSION = 4;
export declare const DEFAULT_CONFIG_PATH = "~/.dsh/qq-bridge/config.json";
/** 配置错误：携带用户可读信息，index.ts 捕获后提示重新生成配置 */
export declare class ConfigError extends Error {
    constructor(message: string);
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
    workspaces: {
        name: string;
        path: string;
        description?: string;
    }[];
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
    progress: {
        enabled: boolean;
        ackAfterMs: number;
    };
    maxQueueSize: number;
    media: {
        enabled: boolean;
        maxAttachments: number;
        maxTotalBytes: number;
        downloadTimeoutMs: number;
        image: {
            maxBytes: number;
        };
        voice: {
            enabled: boolean;
            preferQQAsr: boolean;
            maxBytes: number;
            stt?: {
                baseUrl?: string;
                apiKeyEnv?: string;
                model?: string;
                timeoutMs?: number;
            };
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
    logging: {
        level: "error" | "info" | "debug";
    };
    debug: boolean;
}
export declare const DEFAULT_CONFIG: PiQQBridgeConfig;
/** 加载并校验配置。任何错误抛 ConfigError（用户可读）。 */
export declare function loadConfig(filePath: string): PiQQBridgeConfig;
/** 原子持久化（spec §6.13：tmp + rename，0600）。返回写出的路径。 */
export declare function saveConfig(filePath: string, config: PiQQBridgeConfig): void;
/** 展开 ~ 为 HOME（配置路径用） */
export declare function expandHome(p: string): string;
//# sourceMappingURL=config.d.ts.map