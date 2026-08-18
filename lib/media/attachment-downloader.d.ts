import type { QQAttachmentKind } from "../core/types.ts";
export type SniffedMedia = {
    kind: "image";
    mimeType: "image/jpeg" | "image/png" | "image/gif";
    extension: string;
} | {
    kind: "audio";
    mimeType: string;
    extension: string;
} | {
    kind: "pdf";
    mimeType: "application/pdf";
    extension: ".pdf";
} | {
    kind: "doc";
    mimeType: "application/msword";
    extension: ".doc";
} | {
    kind: "text";
    mimeType: "text/plain";
    extension: ".txt";
} | {
    kind: "archive";
    mimeType: string;
    extension: string;
} | {
    kind: "unknown";
    mimeType: "application/octet-stream";
    extension: string;
};
export interface DownloadedAttachment {
    path: string;
    bytes: number;
    media: SniffedMedia;
    responseContentType?: string;
}
export interface AttachmentDownloaderOptions {
    runtimeId: string;
    messageId: string;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress?: (bytes: number) => void;
}
export declare class AttachmentDownloadError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class AttachmentDownloader {
    private readonly workspace;
    private readonly timeoutMs;
    private readonly signal;
    private readonly onProgress?;
    private totalBytes;
    constructor(options: AttachmentDownloaderOptions);
    download(url: string, maxBytes: number, remainingTotalBytes: number): Promise<DownloadedAttachment>;
    get downloadedBytes(): number;
    cleanup(): Promise<void>;
    private downloadWithRetries;
    private downloadAttempt;
}
export declare function parseAndValidateUrl(value: string): URL;
export declare function validatePublicHost(hostname: string): Promise<void>;
export declare function isPublicAddress(address: string): boolean;
export declare function sniffMedia(head: Uint8Array, contentType?: string | null, sourceName?: string): SniffedMedia;
export declare function safeOriginalFilename(value: string): string;
export declare function safeUrlForLog(value: string): string;
export declare function classifyAttachment(attachment: {
    filename: string;
    contentType: string;
}): QQAttachmentKind;
//# sourceMappingURL=attachment-downloader.d.ts.map