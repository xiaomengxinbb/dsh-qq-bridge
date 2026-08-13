/**
 * QQ 侧命令解析（spec §6.8 / 差距分析 P0-3）
 * 不调用 shell 或模型：/cmd args → {name, args, rawArgs}
 */

export interface ParsedQQCommand {
	name: string;
	args: string[];
	rawArgs: string;
}

const COMMAND_ALIASES: Record<string, string> = {
	"qqbot-help": "help",
	"qqbot-status": "status",
	"qqbot-last": "last",
	cancel: "stop",
};

const MAX_COMMAND_BYTES = 2048;
const MAX_ARGUMENTS = 20;

/** 归一化用户输入：去 BOM/零宽字符，接受全角 "／" */
export function normalizeCommandText(text: string): string {
	return text
		.replace(/^\uFEFF/, "")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/^[／]/, "/")
		.trim();
}

/** 解析一条 / 开头的 QQ 命令。非命令返回 undefined；非法命令抛错（回复给用户）。 */
export function parseQQCommand(text: string): ParsedQQCommand | undefined {
	const source = normalizeCommandText(text);
	if (!source.startsWith("/")) return undefined;
	if (Buffer.byteLength(source, "utf8") > MAX_COMMAND_BYTES)
		throw new Error("命令过长，请缩短后重试");
	const separator = source.search(/\s/);
	const rawName = (
		separator < 0 ? source.slice(1) : source.slice(1, separator)
	).toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(rawName))
		throw new Error("命令名称无效；发送 /help 查看可用命令");
	const rawArgs = separator < 0 ? "" : source.slice(separator).trim();
	const args = tokenizeArguments(rawArgs);
	if (args.length > MAX_ARGUMENTS)
		throw new Error(`参数过多，最多允许 ${MAX_ARGUMENTS} 个`);
	return { name: COMMAND_ALIASES[rawName] ?? rawName, args, rawArgs };
}

/** 轻量 tokenize：支持引号与转义（不执行任何内容） */
function tokenizeArguments(source: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of source) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote) {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error("命令中的引号没有闭合");
	if (current) args.push(current);
	return args;
}
