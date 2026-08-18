export declare class AttachmentExtractError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface ExtractedText {
    text: string;
    truncated: boolean;
    pages?: number;
}
export declare function extractTxt(path: string, maxChars: number): Promise<ExtractedText>;
export declare function extractPdf(path: string, maxPages: number, maxChars: number): Promise<ExtractedText>;
/** 最小可用 PDF（含文本层），用于测试/无 unpdf 依赖时的兜底验证 */
export declare function makeMinimalPdf(text: string): Uint8Array;
//# sourceMappingURL=attachment-extractors.d.ts.map