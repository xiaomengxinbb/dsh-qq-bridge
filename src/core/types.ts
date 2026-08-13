/** 公共类型（M0 最小集，M1 扩展） */

/** 入站消息（QQGateway 归一化输出，M1 使用） */
export interface QQInboundMessage {
	id: string;
	type: "private" | "group";
	text: string;
	userOpenId: string;
	groupOpenId?: string;
	attachments: QQAttachment[];
	receivedAt: number;
	raw?: unknown;
}

/** 入站附件（来自事件 attachments[]，M1 使用） */
export interface QQAttachment {
	url: string;
	filename: string;
	size: number;
	contentType: string;
	width?: number;
	height?: number;
	/** 语音附件：QQ ASR 文本 */
	asrReferText?: string;
}

/** 网关状态(/qqbot-status 展示) */
export type QQGatewayState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

/** 被动回复目标(发送时引用原消息 msg_id) */
export interface QQReplyTarget {
	type: "private" | "group";
	userOpenId?: string;
	groupOpenId?: string;
	msgId: string;
}

/** 网关状态变化回调 */
export type QQGatewayStateListener = (
	state: QQGatewayState,
	info?: string,
) => void;

/** 入站消息回调（M1 接入 router） */
export type QQInboundListener = (msg: QQInboundMessage) => void;

/** 图片内容（进 prompt 的 images[]） */
export interface QQImageContent {
	type: "image";
	source: { type: "base64"; mediaType: string; data: string };
}

/** 附件分类（嗅探结果） */
export type QQAttachmentKind =
	| "image"
	| "audio"
	| "pdf"
	| "doc"
	| "text"
	| "archive"
	| "unknown";

/** 预处理后的单个附件资源 */
export interface PreparedAttachment {
	attachment: QQAttachment;
	kind: QQAttachmentKind;
	/** 安全化后的原始文件名 */
	filename: string;
	status: "ready" | "rejected";
	/** ready：提取的文本 / 转写文本 / 图片说明 */
	text?: string;
	/** ready：图片数据（进 prompt images[]） */
	image?: QQImageContent;
	/** rejected：错误码（spec §6.14） */
	errorCode?: string;
	/** rejected：用户可读原因 */
	errorMessage?: string;
	/** 临时文件路径（消息处理完 cleanup 删除） */
	path?: string;
}

/** 预处理后的完整消息（进 agent 的 prompt + images） */
export interface PreparedQQMessage {
	prompt: string;
	images: QQImageContent[];
	resources: PreparedAttachment[];
	/** 清理临时文件 */
	cleanup(): Promise<void>;
}

/** STT 配置（media.voice.stt） */
export interface QQMediaSttConfig {
	baseUrl?: string;
	apiKeyEnv?: string;
	model?: string;
	timeoutMs?: number;
}
