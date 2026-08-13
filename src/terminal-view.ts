/**
 * TUI 尾部视图（spec §6.10）
 * - ctx.ui.setWidget（≤10 行）：授权入站文本、队列/运行状态、assistant 文本流、
 *   工具调用起止、回复结果
 * - 只读观察者：不写本地会话 JSONL、不进模型上下文、不显示隐藏 thinking
 */
import type { QQRouterEvent } from "./router.ts";

const MAX_LINES = 10;

export interface TerminalViewOptions {
	/** 更新 widget（注入 ctx.ui.setWidget） */
	setWidget: (id: string, lines: string[]) => void;
}

export class TerminalView {
	private readonly lines: string[] = [];
	private attached = false;

	private readonly options: TerminalViewOptions;

	constructor(options: TerminalViewOptions) {
		this.options = options;
	}

	/** 订阅 router 事件并渲染（session_start 时调用） */
	attach(): void {
		this.attached = true;
		this.render();
	}

	/** 解除订阅（session_shutdown 时调用） */
	detach(): void {
		this.attached = false;
		this.safeSetWidget([]);
	}

	/** router onEvent 回调 */
	onEvent = (event: QQRouterEvent): void => {
		if (!this.attached) return;
		switch (event.kind) {
			case "queued":
				this.push(
					`⏳ 入队：${truncate(event.messageId, 12)}（队列 ${event.queueSize}）`,
				);
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
				this.push(
					`🔐 访问申请：${truncate(event.userOpenId, 16)} 码 ${event.code}`,
				);
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

	private push(line: string): void {
		this.lines.push(line);
		if (this.lines.length > MAX_LINES) this.lines.shift();
	}

	private render(): void {
		this.safeSetWidget([...this.lines]);
	}

	/** UI 调用容错：ctx 在 reload/会话替换后可能失效，观察者失败绝不影响主流程 */
	private safeSetWidget(lines: string[]): void {
		try {
			this.options.setWidget("pi-qq-bridge", lines);
		} catch {
			// reload 后旧 ctx 已 stale（pi 会抛 "extension ctx is stale"）——忽略
		}
	}
}

function truncate(value: string, max: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
