/**
 * QQ 原生指令按钮（spec §6.8 / 差距分析 P1-1）
 *
 * 关键约束：v2 openid 不能用作 Keyboard 的 specify_user_ids（官方客户端会拒绝点击），
 * 因此按钮一律 permission.type=2（全员可点），真实权限仍由服务端 allowlist/admin 校验。
 */
import type { QQInboundMessage } from "../core/types.ts";
export interface QQCommandButton {
    label: string;
    command: string;
    primary?: boolean;
}
export interface QQKeyboard {
    content: {
        rows: {
            buttons: QQKeyboardButton[];
        }[];
    };
}
interface QQKeyboardButton {
    id: string;
    render_data: {
        label: string;
        visited_label: string;
        style: number;
    };
    action: {
        type: 2;
        permission: {
            type: 2;
        };
        data: string;
        reply: boolean;
        enter: boolean;
        unsupport_tips: string;
    };
}
/** 构建保守的两列命令键盘；无 userOpenId 或空行时返回 undefined */
export declare function buildCommandKeyboard(msg: QQInboundMessage, rows: QQCommandButton[][]): QQKeyboard | undefined;
export {};
//# sourceMappingURL=qq-keyboard.d.ts.map