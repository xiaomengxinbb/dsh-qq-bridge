import { type QQApi } from "../gateway/qq-api.ts";
import type { PiQQBridgeConfig } from "../core/config.ts";
import type { QQInboundMessage, QQReplyTarget } from "../core/types.ts";
export type QQOutboundKind = "auto" | "image" | "file";
export interface QQOutboundDeliveryRecord {
    filename: string;
    kind: "image" | "file";
    bytes: number;
    status: "sent" | "failed" | "unknown";
    errorCode?: string;
    note?: string;
}
export interface QQOutboundDeliveryOptions {
    config: PiQQBridgeConfig;
    cwd: string;
    message: QQInboundMessage;
    target: QQReplyTarget;
    api?: QQApi;
    signal?: AbortSignal;
    /** 回复配额：返回 undefined = 已耗尽 */
    reserveMessageSequence(): number | undefined;
}
export declare class QQOutboundMediaError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** 单次 agent 运行的交付上下文；回合结束 close（防串目标） */
export declare class QQOutboundDeliveryContext {
    private readonly recordsValue;
    private sentFiles;
    private totalBytes;
    private closed;
    private readonly options;
    constructor(options: QQOutboundDeliveryOptions);
    get records(): readonly QQOutboundDeliveryRecord[];
    close(): void;
    sendLocalFile(inputPath: string, requestedKind?: QQOutboundKind): Promise<QQOutboundDeliveryRecord>;
    private assertAvailable;
    private assertAuthorized;
    private failureRecord;
}
/** 路径解析 + allowedRoots 校验（OS tmp + 显式配置；不信任 cwd） */
export declare function resolveAllowedLocalFile(input: string, cwd: string, configuredRoots: string[]): Promise<string>;
export declare function normalizeInputPath(input: string, cwd: string): string;
export declare function formatBytes(bytes: number): string;
//# sourceMappingURL=outbound-media.d.ts.map