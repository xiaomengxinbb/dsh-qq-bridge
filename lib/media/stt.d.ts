import type { QQMediaSttConfig } from "../core/types.ts";
export declare class SttError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface SttInput {
    path: string;
    filename: string;
    mimeType: string;
}
export declare function transcribeOpenAI(input: SttInput, config: QQMediaSttConfig, outerSignal: AbortSignal): Promise<string>;
//# sourceMappingURL=stt.d.ts.map