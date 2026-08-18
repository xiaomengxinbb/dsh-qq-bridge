export declare const QQ_MARKDOWN_CHUNK_BYTES = 3600;
export declare const QQ_PLAIN_CHUNK_BYTES = 3600;
export declare const QQ_MAX_REPLY_CHUNKS = 4;
export interface FormattedQQReply {
    markdown: string[];
    plain: string[];
    truncated: boolean;
}
export declare function formatQQReply(text: string, mode: "auto" | "plain"): FormattedQQReply;
export declare function normalizeMarkdown(value: string): string;
export declare function chunkMarkdown(text: string, maxBytes: number, maxChunks: number): string[];
export declare function chunkPlainText(text: string, maxBytes: number, maxChunks: number): string[];
export declare function markdownToPlain(markdown: string): string;
//# sourceMappingURL=reply-formatter.d.ts.map