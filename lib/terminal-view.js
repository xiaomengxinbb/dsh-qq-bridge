const MAX_LINES = 10;
export class TerminalView {
    lines = [];
    attached = false;
    options;
    constructor(options) {
        this.options = options;
    }
    /** 订阅 router 事件并渲染（session_start 时调用） */
    attach() {
        this.attached = true;
        this.render();
    }
    /** 解除订阅（session_shutdown 时调用） */
    detach() {
        this.attached = false;
        this.safeSetWidget([]);
    }
    /** router onEvent 回调 */
    onEvent = (event) => {
        if (!this.attached)
            return;
        switch (event.kind) {
            case "queued":
                this.push(`⏳ 入队：${truncate(event.messageId, 12)}（队列 ${event.queueSize}）`);
                break;
            case "run_start":
                this.push(`▶️ 开始处理：${truncate(event.messageId, 12)}`);
                break;
            case "run_end":
                this.push(event.ok ? "✅ 处理完成" : "❌ 处理失败");
                break;
            case "reply":
                this.push(`📤 回复(${event.msgSeq})：${truncate(event.content, 40)}`);
                break;
            case "access_request":
                this.push(`🔐 访问申请：${truncate(event.userOpenId, 16)} 码 ${event.code}`);
                break;
            case "command":
                this.push(`⚙️ 命令：/${event.name}`);
                break;
            case "error":
                this.push(`⚠️ ${truncate(event.message, 50)}`);
                break;
        }
        this.render();
    };
    push(line) {
        this.lines.push(line);
        if (this.lines.length > MAX_LINES)
            this.lines.shift();
    }
    render() {
        this.safeSetWidget([...this.lines]);
    }
    /** UI 调用容错：ctx 在 reload/会话替换后可能失效，观察者失败绝不影响主流程 */
    safeSetWidget(lines) {
        try {
            this.options.setWidget("pi-qq-bridge", lines);
        }
        catch {
            // reload 后旧 ctx 已 stale（pi 会抛 "extension ctx is stale"）——忽略
        }
    }
}
function truncate(value, max) {
    const oneLine = value.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
//# sourceMappingURL=terminal-view.js.map