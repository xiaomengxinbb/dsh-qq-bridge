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
export declare const APPROVAL_BUTTON_PREFIX = "approval:";
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
    render_data: {
        label: string;
        visited_label: string;
        style: number;
    };
    action: {
        type: 1;
        data: string;
        permission: {
            type: 2;
        };
        /** 单用户点击上限(1=点击后失效,防重复;仿 Hermes) */
        click_limit: number;
    };
    /** 同 group_id 的按钮互斥(点击一个置灰其余;仿 Hermes) */
    group_id: string;
}
export interface QQKeyboard {
    content: {
        rows: {
            buttons: QQKeyboardButton[];
        }[];
    };
}
export declare class ApprovalBridge {
    private pending;
    /** 创建审批请求,返回按钮键盘 + 文本 */
    createRequest(req: {
        approvalId: string;
        userOpenId: string;
        toolName: string;
        reason: string;
        cwd?: string;
        resolve: (choice: ApprovalChoice) => void;
    }): {
        keyboard: QQKeyboard;
        text: string;
    };
    /** 构建审批键盘(仿 Hermes build_approval_keyboard:三按钮同 group) */
    buildKeyboard(approvalId: string): QQKeyboard;
    /** 渲染审批文本(仿 Hermes build_approval_text) */
    buildText(toolName: string, reason: string, cwd?: string): string;
    /** 解析按钮 data → 命中挂起审批则 resolve(返回 true=已处理) */
    handleButtonData(buttonData: string, operatorOpenId: string): boolean;
    /** 文本命令 /approve /always /deny → resolve */
    handleTextCommand(command: string, operatorOpenId: string): {
        handled: boolean;
        approvalId?: string;
    };
    /** 找该用户最早的挂起审批 */
    private findForUser;
    /** 核心:resolve 审批(校验操作者身份) */
    private resolve;
    /** 清空所有挂起(网关断开时调用,避免悬挂) */
    dispose(): void;
    /** 待审批数量(调试/状态用) */
    get pendingCount(): number;
}
//# sourceMappingURL=approval-bridge.d.ts.map