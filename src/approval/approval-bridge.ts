/**
 * QQ 审批桥(仿 Hermes tools/approval.py + gateway/platforms/qqbot/keyboards.py)
 *
 * 职责:
 * 1. 维护挂起的审批请求(approvalId → {resolve, userOpenId, reason, toolName})
 * 2. 按钮数据编码:approval:{approvalId}:{choice}(仿 Hermes APPROVAL_BUTTON_PREFIX)
 * 3. 构建审批键盘:✅允许一次 / ⭐始终允许 / ❌拒绝(同 group 互斥)
 * 4. 渲染审批文本(命令/工具审批)
 * 5. 解析按钮点击 / 文本命令(/approve /deny) → resolve 等待中的审批
 *
 * 使用方式(在 index.ts 中挂接):
 *   ctx.on("approval/request", (req, next) => bridge.handleApprovalRequest(req, next))
 */

// 按钮 data 前缀(仿 Hermes APPROVAL_BUTTON_PREFIX)
export const APPROVAL_BUTTON_PREFIX = "approval:";

export type ApprovalChoice = "once" | "always" | "deny";

export interface PendingApproval {
	/** 审批唯一 id(按钮 data 中编码) */
	approvalId: string;
	/** 等待审批的用户 openid */
	userOpenId: string;
	/** 工具名(显示用) */
	toolName: string;
	/** 审批原因(显示用) */
	reason: string;
	/** 会话 cwd(显示用) */
	cwd?: string;
	/** 回调:choice 决定后调用,返回 outcome 给 DSH approval 系统 */
	resolve: (choice: ApprovalChoice) => void;
	/** 超时定时器 */
	timer?: ReturnType<typeof setTimeout>;
	createdAt: number;
}

export interface QQKeyboardButton {
	id: string;
	render_data: { label: string; visited_label: string; style: number };
	action: {
		// type 1 = 自定义回调(触发 INTERACTION_CREATE,审批按钮必需;仿 Hermes)
		// type 2 = 文本指令(点击=发送 data 文本,不产生 INTERACTION_CREATE)
		type: 1;
		permission: { type: 2 };
		data: string;
		reply: boolean;
		enter: boolean;
		unsupport_tips: string;
	};
}

export interface QQKeyboard {
	content: { rows: { buttons: QQKeyboardButton[] }[] };
}

const APPROVAL_TTL_MS = 120_000; // 审批 2 分钟超时

export class ApprovalBridge {
	private pending = new Map<string, PendingApproval>();

	/** 创建审批请求,返回按钮键盘 + 文本 */
	createRequest(req: {
		approvalId: string;
		userOpenId: string;
		toolName: string;
		reason: string;
		cwd?: string;
		resolve: (choice: ApprovalChoice) => void;
	}): { keyboard: QQKeyboard; text: string } {
		const { approvalId, userOpenId } = req;
		// 同用户旧审批先取消(避免堆积)
		for (const [id, p] of this.pending) {
			if (p.userOpenId === userOpenId && id !== approvalId) {
				clearTimeout(p.timer);
				p.resolve("deny");
				this.pending.delete(id);
			}
		}
		const timer = setTimeout(() => {
			// 超时:按拒绝处理,避免永久挂起
			const p = this.pending.get(approvalId);
			if (p) {
				p.resolve("deny");
				this.pending.delete(approvalId);
			}
		}, APPROVAL_TTL_MS);
		timer.unref?.();
		this.pending.set(approvalId, {
			approvalId,
			userOpenId,
			toolName: req.toolName,
			reason: req.reason,
			cwd: req.cwd,
			resolve: req.resolve,
			timer,
			createdAt: Date.now(),
		});
		return {
			keyboard: this.buildKeyboard(approvalId),
			text: this.buildText(req.toolName, req.reason, req.cwd),
		};
	}

	/** 构建审批键盘(仿 Hermes build_approval_keyboard:三按钮同 group) */
	buildKeyboard(approvalId: string): QQKeyboard {
		const btn = (
			id: string,
			label: string,
			visited: string,
			choice: ApprovalChoice,
			style: number,
		): QQKeyboardButton => ({
			id,
			render_data: { label, visited_label: visited, style },
			action: {
				// type 1 = 自定义回调 → 触发 INTERACTION_CREATE(审批必需;仿 Hermes)
				type: 1,
				permission: { type: 2 },
				data: `${APPROVAL_BUTTON_PREFIX}${approvalId}:${choice}`,
				reply: false,
				enter: false,
				unsupport_tips: "请更新 QQ 版本后使用",
			},
		});
		return {
			content: {
				rows: [
					{
						buttons: [
							btn("allow", "✅ 允许一次", "已允许", "once", 1),
							btn("always", "⭐ 始终允许", "已始终允许", "always", 1),
							btn("deny", "❌ 拒绝", "已拒绝", "deny", 0),
						],
					},
				],
			},
		};
	}

	/** 渲染审批文本(仿 Hermes build_approval_text) */
	buildText(toolName: string, reason: string, cwd?: string): string {
		const lines = ["🔐 **工具审批请求**", ""];
		if (toolName) lines.push(`🛠️ 工具: \`${toolName}\``);
		if (cwd) lines.push(`📁 目录: \`${cwd}\``);
		if (reason) lines.push(`📋 原因: ${reason.slice(0, 300)}`);
		lines.push("");
		lines.push("请在下方选择,或回复 `/approve`(允许一次)/`/always`(始终)/`/deny`(拒绝)");
		return lines.join("\n");
	}

	/** 解析按钮 data → 命中挂起审批则 resolve(返回 true=已处理) */
	handleButtonData(buttonData: string, operatorOpenId: string): boolean {
		if (!buttonData.startsWith(APPROVAL_BUTTON_PREFIX)) return false;
		const rest = buttonData.slice(APPROVAL_BUTTON_PREFIX.length);
		// 格式: approval:{approvalId}:{choice}
		const sepIdx = rest.lastIndexOf(":");
		if (sepIdx <= 0) return false;
		const approvalId = rest.slice(0, sepIdx);
		const choiceRaw = rest.slice(sepIdx + 1);
		const choice: ApprovalChoice =
			choiceRaw === "once" || choiceRaw === "always" || choiceRaw === "deny"
				? choiceRaw
				: "deny";
		return this.resolve(approvalId, operatorOpenId, choice);
	}

	/** 文本命令 /approve /always /deny → resolve */
	handleTextCommand(
		command: string,
		operatorOpenId: string,
	): { handled: boolean; approvalId?: string } {
		const p = this.findForUser(operatorOpenId);
		if (!p) return { handled: false };
		let choice: ApprovalChoice | undefined;
		if (command === "approve" || command === "yes" || command === "ok") choice = "once";
		else if (command === "always" || command === "allow-always") choice = "always";
		else if (command === "deny" || command === "no" || command === "cancel") choice = "deny";
		if (!choice) return { handled: false };
		this.resolve(p.approvalId, operatorOpenId, choice);
		return { handled: true, approvalId: p.approvalId };
	}

	/** 找该用户最早的挂起审批 */
	private findForUser(userOpenId: string): PendingApproval | undefined {
		let oldest: PendingApproval | undefined;
		for (const p of this.pending.values()) {
			if (p.userOpenId !== userOpenId) continue;
			if (!oldest || p.createdAt < oldest.createdAt) oldest = p;
		}
		return oldest;
	}

	/** 核心:resolve 审批(校验操作者身份) */
	private resolve(approvalId: string, operatorOpenId: string, choice: ApprovalChoice): boolean {
		const p = this.pending.get(approvalId);
		if (!p) return false;
		// 安全:只有挂起审批的发起人能决定(仿 Hermes _is_authorized_interaction_for_session)
		if (p.userOpenId !== operatorOpenId) return false;
		clearTimeout(p.timer);
		this.pending.delete(approvalId);
		p.resolve(choice);
		return true;
	}

	/** 清空所有挂起(网关断开时调用,避免悬挂) */
	dispose(): void {
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.resolve("deny");
		}
		this.pending.clear();
	}

	/** 待审批数量(调试/状态用) */
	get pendingCount(): number {
		return this.pending.size;
	}
}
