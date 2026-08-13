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
	content: { rows: { buttons: QQKeyboardButton[] }[] };
}

interface QQKeyboardButton {
	id: string;
	render_data: { label: string; visited_label: string; style: number };
	action: {
		type: 2;
		permission: { type: 2 };
		data: string;
		reply: boolean;
		enter: boolean;
		unsupport_tips: string;
	};
}

const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;

/** 构建保守的两列命令键盘；无 userOpenId 或空行时返回 undefined */
export function buildCommandKeyboard(
	msg: QQInboundMessage,
	rows: QQCommandButton[][],
): QQKeyboard | undefined {
	if (!msg.userOpenId || !rows.length) return undefined;
	const contentRows = rows.slice(0, MAX_ROWS).map((row, rowIndex) => ({
		buttons: row
			.slice(0, MAX_BUTTONS_PER_ROW)
			.map((button, columnIndex) =>
				makeButton(msg, button, rowIndex, columnIndex),
			),
	}));
	if (!contentRows.some((row) => row.buttons.length)) return undefined;
	return { content: { rows: contentRows.filter((row) => row.buttons.length) } };
}

function makeButton(
	msg: QQInboundMessage,
	button: QQCommandButton,
	rowIndex: number,
	columnIndex: number,
): QQKeyboardButton {
	const label =
		button.label.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 20) || "操作";
	const command = button.command.trim().slice(0, 300);
	return {
		id: `cmd-${rowIndex}-${columnIndex}`,
		render_data: { label, visited_label: label, style: button.primary ? 1 : 0 },
		action: {
			type: 2,
			permission: { type: 2 },
			data: command,
			reply: false,
			enter: msg.type === "private",
			unsupport_tips: `请手动发送：${command}`.slice(0, 80),
		},
	};
}
