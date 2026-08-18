/**
 * QQ 侧命令解析（spec §6.8 / 差距分析 P0-3）
 * 不调用 shell 或模型：/cmd args → {name, args, rawArgs}
 */
export interface ParsedQQCommand {
    name: string;
    args: string[];
    rawArgs: string;
}
/** 归一化用户输入：去 BOM/零宽字符，接受全角 "／" */
export declare function normalizeCommandText(text: string): string;
/** 解析一条 / 开头的 QQ 命令。非命令返回 undefined；非法命令抛错（回复给用户）。 */
export declare function parseQQCommand(text: string): ParsedQQCommand | undefined;
//# sourceMappingURL=command-parser.d.ts.map