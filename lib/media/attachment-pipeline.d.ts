import { type DownloadedAttachment } from "./attachment-downloader.ts";
import type { PiQQBridgeConfig } from "../core/config.ts";
import type { PreparedAttachment, PreparedQQMessage, QQAttachmentKind, QQInboundMessage } from "../core/types.ts";
/** 下载器结构接口（测试注入 fake） */
export interface AttachmentDownloaderLike {
    download(url: string, maxBytes: number, remainingTotalBytes: number): Promise<DownloadedAttachment>;
    readonly downloadedBytes: number;
    cleanup(): Promise<void>;
}
export interface AttachmentPipelineOptions {
    /** 下载器工厂（测试注入；默认安全下载器） */
    downloaderFactory?: (opts: {
        runtimeId: string;
        messageId: string;
        timeoutMs: number;
        signal: AbortSignal;
        onProgress?: (bytes: number) => void;
    }) => AttachmentDownloaderLike;
}
export interface AttachmentPipelineCallbacks {
    onStart?(index: number, total: number, kind: QQAttachmentKind, filename: string): void;
    onProgress?(index: number, total: number, kind: QQAttachmentKind, filename: string, bytes: number): void;
    onEnd?(index: number, total: number, resource: PreparedAttachment, bytes?: number): void;
}
export declare class AttachmentPipeline {
    private readonly config;
    private readonly runtimeId;
    private readonly downloaderFactory;
    constructor(config: PiQQBridgeConfig, runtimeId: string, options?: AttachmentPipelineOptions);
    prepare(msg: QQInboundMessage, signal: AbortSignal, callbacks?: AttachmentPipelineCallbacks): Promise<PreparedQQMessage>;
    private prepareOne;
    private prepareImage;
    private prepareAudio;
}
/** 检查是否全部失败（无可用的 agent 输入） */
export declare function hasUsableAgentInput(msg: QQInboundMessage, resources: PreparedAttachment[]): boolean;
export declare function formatAttachmentFailures(resources: PreparedAttachment[]): string;
//# sourceMappingURL=attachment-pipeline.d.ts.map