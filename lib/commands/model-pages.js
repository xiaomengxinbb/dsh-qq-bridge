export const QQ_KEYBOARD_MAX_ROWS = 5;
export const QQ_KEYBOARD_BUTTONS_PER_ROW = 2;
const RESERVED_MODEL_KEYBOARD_ROWS = 2;
export const MAX_MODEL_PAGE_SIZE = (QQ_KEYBOARD_MAX_ROWS - RESERVED_MODEL_KEYBOARD_ROWS) *
    QQ_KEYBOARD_BUTTONS_PER_ROW;
export function normalizeModelPageSize(value) {
    if (!Number.isFinite(value))
        return MAX_MODEL_PAGE_SIZE;
    return Math.min(MAX_MODEL_PAGE_SIZE, Math.max(1, Math.trunc(value)));
}
export function buildModelPage(models, page, pageSize) {
    const effectivePageSize = normalizeModelPageSize(pageSize);
    const total = models.length;
    const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
        throw new RangeError(`模型页码无效；当前共 ${totalPages} 页`);
    }
    const offset = (page - 1) * effectivePageSize;
    const items = models.slice(offset, offset + effectivePageSize);
    return {
        models: items,
        page,
        total,
        totalPages,
        offset,
        pageSize: effectivePageSize,
        keyboardRows: itemsToKeyboardRows(items, page, totalPages),
        fallbackCommands: fallbackCommands(page, totalPages),
    };
}
export function formatModelPageFallback(page) {
    if (!page.fallbackCommands.length)
        return "发送 `/model provider/model` 切换。";
    return `发送 \`${page.fallbackCommands.join("` 或 `")}\` 翻页，或发送 \`/model provider/model\` 切换。`;
}
function itemsToKeyboardRows(models, page, totalPages) {
    const rows = [];
    for (let index = 0; index < models.length; index += QQ_KEYBOARD_BUTTONS_PER_ROW) {
        rows.push(models.slice(index, index + QQ_KEYBOARD_BUTTONS_PER_ROW).map((model) => ({
            label: model.name.slice(0, 16),
            command: `/model ${model.provider}/${model.id}`,
            primary: index === 0,
        })));
    }
    if (totalPages > 1) {
        const navigation = [];
        if (page > 1)
            navigation.push({
                label: `上一页 ${page - 1}/${totalPages}`,
                command: `/model page ${page - 1}`,
            });
        if (page < totalPages)
            navigation.push({
                label: `下一页 ${page + 1}/${totalPages}`,
                command: `/model page ${page + 1}`,
            });
        if (navigation.length)
            rows.push(navigation);
    }
    rows.push([{ label: "返回帮助", command: "/help" }]);
    return rows;
}
function fallbackCommands(page, totalPages) {
    const commands = [];
    if (page > 1)
        commands.push(`/model page ${page - 1}`);
    if (page < totalPages)
        commands.push(`/model page ${page + 1}`);
    return commands;
}
//# sourceMappingURL=model-pages.js.map