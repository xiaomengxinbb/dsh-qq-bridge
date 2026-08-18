/**
 * QQ REST 发送 API（spec §6.3，M1：纯文本被动回复）
 * - POST /v2/users/{openid}/messages，msg_type:0，携带 msg_id + msg_seq
 * - 401 → forceRefresh 后重试一次
 * - 错误分类：QQApiError{status, code, requestAccepted}
 */
import type { QQAuth } from "./qq-auth.ts";
import type { QQReplyTarget } from "../core/types.ts";
export interface QQApiOptions {
    sandbox: boolean;
    /** API 基础域名覆盖（测试用） */
    apiBase?: string;
}
export declare class QQApiError extends Error {
    readonly status: number;
    readonly code?: number;
    readonly requestAccepted: boolean;
    constructor(message: string, status: number, code?: number, requestAccepted?: boolean);
}
export declare class QQApi {
    private readonly base;
    private readonly auth;
    constructor(auth: QQAuth, options: QQApiOptions);
    /** 纯文本被动回复（msg_type:0，可选键盘） */
    sendText(target: QQReplyTarget, content: string, msgSeq: number, keyboard?: unknown): Promise<void>;
    /** Markdown 被动回复（msg_type:2；群聊文档要求 content 非空） */
    sendMarkdown(target: QQReplyTarget, content: string, msgSeq: number, keyboard?: unknown): Promise<void>;
    /** 上传本地字节（不主动发送；返回 file_info） */
    uploadMedia(target: QQReplyTarget, fileType: 1 | 4, fileData: string, signal?: AbortSignal, timeoutMs?: number): Promise<{
        fileInfo: string;
        fileUuid?: string;
        ttl: number;
    }>;
    /**
     * 分片上传（spec §6.3 P0-1）：upload_prepare → 逐块 PUT 预签名 → upload_part_finish
     * 用于超过 base64 阈值的大文件（file_data 有平台硬上限）
     * 协议字段以 QQ 官方文档为准（spec §3.5 已存档），上线前需沙箱实测
     */
    uploadMediaChunked(target: QQReplyTarget, fileType: 1 | 4, filename: string, fileSize: number, readPart: (offset: number, length: number) => Promise<Uint8Array>, options?: {
        maxParts?: number;
        partConcurrency?: number;
        prepareTimeoutMs?: number;
        partTimeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<{
        fileInfo: string;
    }>;
    /** 发送已上传媒体（msg_type:7 被动回复） */
    sendMedia(target: QQReplyTarget, fileInfo: string, msgSeq: number, signal?: AbortSignal): Promise<void>;
    private send;
    /** ACK 按钮交互(INTERACTION_CREATE 后必须快速 ACK,否则客户端显示错误图标;仿 Hermes _acknowledge_interaction) */
    ackInteraction(interactionId: string, code?: number): Promise<void>;
    /** 发送"对方正在输入"状态(msg_type:6, C2C 专用;仿 Hermes send_typing) */
    sendTyping(userOpenId: string, msgId: string, msgSeq: number): Promise<void>;
    private postJson;
}
//# sourceMappingURL=qq-api.d.ts.map