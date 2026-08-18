const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
/** 构建保守的两列命令键盘；无 userOpenId 或空行时返回 undefined */
export function buildCommandKeyboard(msg, rows) {
    if (!msg.userOpenId || !rows.length)
        return undefined;
    const contentRows = rows.slice(0, MAX_ROWS).map((row, rowIndex) => ({
        buttons: row
            .slice(0, MAX_BUTTONS_PER_ROW)
            .map((button, columnIndex) => makeButton(msg, button, rowIndex, columnIndex)),
    }));
    if (!contentRows.some((row) => row.buttons.length))
        return undefined;
    return { content: { rows: contentRows.filter((row) => row.buttons.length) } };
}
function makeButton(msg, button, rowIndex, columnIndex) {
    const label = button.label.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 20) || "操作";
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
//# sourceMappingURL=qq-keyboard.js.map