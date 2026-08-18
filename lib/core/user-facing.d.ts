/**
 * 用户侧文案辅助（与 Pi SDK 解耦，便于 strip-types 单测）
 */
/**
 * 从 agent_end 的消息列表中提取最终 assistant 文本。
 * Pi 把 provider 失败记录为 assistant 消息（stopReason=error），这里显式抛错。
 */
export declare function extractFinalAssistantText(messages: unknown[]): string;
/** 把原始 agent/runtime 错误映射为短小、用户可读的中文文案（稳定错误码见 spec §6.14） */
export declare function formatUserFacingAgentError(err: unknown): string;
/** 会话预览：剥离 QQ 技术头与附件 XML，压缩为单行摘要 */
export declare function humanizeSessionPreview(text: string): string;
//# sourceMappingURL=user-facing.d.ts.map