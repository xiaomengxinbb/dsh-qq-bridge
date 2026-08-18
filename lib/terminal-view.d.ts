/**
 * TUI 尾部视图（spec §6.10）
 * - ctx.ui.setWidget（≤10 行）：授权入站文本、队列/运行状态、assistant 文本流、
 *   工具调用起止、回复结果
 * - 只读观察者：不写本地会话 JSONL、不进模型上下文、不显示隐藏 thinking
 */
import type { QQRouterEvent } from "./router.ts";
export interface TerminalViewOptions {
    /** 更新 widget（注入 ctx.ui.setWidget） */
    setWidget: (id: string, lines: string[]) => void;
}
export declare class TerminalView {
    private readonly lines;
    private attached;
    private readonly options;
    constructor(options: TerminalViewOptions);
    /** 订阅 router 事件并渲染（session_start 时调用） */
    attach(): void;
    /** 解除订阅（session_shutdown 时调用） */
    detach(): void;
    /** router onEvent 回调 */
    onEvent: (event: QQRouterEvent) => void;
    private push;
    private render;
    /** UI 调用容错：ctx 在 reload/会话替换后可能失效，观察者失败绝不影响主流程 */
    private safeSetWidget;
}
//# sourceMappingURL=terminal-view.d.ts.map