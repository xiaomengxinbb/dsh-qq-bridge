/**
 * /model 分页（差距分析 P1-2，对齐 @xsqm model-pages.ts）
 * 键盘 5 行中保留 2 行给翻页/返回帮助 → 每页 (5-2)*2 = 6 个模型
 */
import type { QQCommandButton } from "./qq-keyboard.ts";
export interface QQModelInfo {
    provider: string;
    id: string;
    name: string;
    input: string[];
    reasoning: boolean;
}
export declare const QQ_KEYBOARD_MAX_ROWS = 5;
export declare const QQ_KEYBOARD_BUTTONS_PER_ROW = 2;
export declare const MAX_MODEL_PAGE_SIZE: number;
export interface ModelPage {
    models: QQModelInfo[];
    page: number;
    total: number;
    totalPages: number;
    offset: number;
    pageSize: number;
    keyboardRows: QQCommandButton[][];
    fallbackCommands: string[];
}
export declare function normalizeModelPageSize(value: number): number;
export declare function buildModelPage(models: QQModelInfo[], page: number, pageSize: number): ModelPage;
export declare function formatModelPageFallback(page: ModelPage): string;
//# sourceMappingURL=model-pages.d.ts.map