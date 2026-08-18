const PROD_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";
export class QQApiError extends Error {
    status;
    code;
    requestAccepted;
    constructor(message, status, code, requestAccepted = false) {
        super(message);
        this.name = "QQApiError";
        this.status = status;
        this.code = code;
        this.requestAccepted = requestAccepted;
    }
}
export class QQApi {
    base;
    auth;
    constructor(auth, options) {
        this.auth = auth;
        this.base = options.apiBase ?? (options.sandbox ? SANDBOX_BASE : PROD_BASE);
    }
    /** 纯文本被动回复（msg_type:0，可选键盘） */
    async sendText(target, content, msgSeq, keyboard) {
        await this.send(target, {
            content,
            msg_type: 0,
            msg_id: target.msgId,
            msg_seq: msgSeq,
            ...(keyboard ? { keyboard } : {}),
        });
    }
    /** Markdown 被动回复（msg_type:2；群聊文档要求 content 非空） */
    async sendMarkdown(target, content, msgSeq, keyboard) {
        await this.send(target, {
            markdown: { content },
            msg_type: 2,
            msg_id: target.msgId,
            msg_seq: msgSeq,
            ...(keyboard ? { keyboard } : {}),
            ...(target.type === "group" ? { content: " " } : {}),
        });
    }
    /** 上传本地字节（不主动发送；返回 file_info） */
    async uploadMedia(target, fileType, fileData, signal, timeoutMs = 30_000) {
        const path = target.type === "private"
            ? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/files`
            : `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/files`;
        const body = await this.postJson(path, { file_type: fileType, file_data: fileData, srv_send_msg: false }, timeoutMs, "media upload", signal);
        if (typeof body.file_info !== "string" || !body.file_info) {
            throw new QQApiError("media upload response missing file_info", 502, undefined, true);
        }
        return {
            fileInfo: body.file_info,
            ...(typeof body.file_uuid === "string" ? { fileUuid: body.file_uuid } : {}),
            ttl: typeof body.ttl === "number" && Number.isFinite(body.ttl) ? body.ttl : 0,
        };
    }
    /**
     * 分片上传（spec §6.3 P0-1）：upload_prepare → 逐块 PUT 预签名 → upload_part_finish
     * 用于超过 base64 阈值的大文件（file_data 有平台硬上限）
     * 协议字段以 QQ 官方文档为准（spec §3.5 已存档），上线前需沙箱实测
     */
    async uploadMediaChunked(target, fileType, filename, fileSize, readPart, options = {}) {
        const base = target.type === "private"
            ? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/files`
            : `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/files`;
        const maxParts = options.maxParts ?? 128;
        const concurrency = options.partConcurrency ?? 2;
        const prepareTimeout = options.prepareTimeoutMs ?? 15_000;
        const partTimeout = options.partTimeoutMs ?? 60_000;
        const signal = options.signal;
        // 1. prepare：平台返回分块参数与预签名 URL
        const prepared = await this.postJson(`${base}/upload_prepare`, { file_type: fileType, filename, file_size: fileSize }, prepareTimeout, "media upload prepare", signal);
        const urls = Array.isArray(prepared.urls) ? prepared.urls : [];
        const blockSize = typeof prepared.block_size === "number" ? prepared.block_size : 1024 * 1024;
        if (!urls.length)
            throw new QQApiError("media upload prepare missing urls", 502, undefined, true);
        // 2. 逐块 PUT 预签名地址（并发受限；单块失败重试一次）
        const totalParts = Math.min(Math.ceil(fileSize / blockSize), maxParts);
        const uploadPart = async (partNumber) => {
            const offset = (partNumber - 1) * blockSize;
            const length = Math.min(blockSize, fileSize - offset);
            const data = await readPart(offset, length);
            const targetUrl = urls.find((u) => u.part_number === partNumber)?.url ?? urls[partNumber - 1]?.url;
            if (!targetUrl)
                throw new QQApiError(`media upload part ${partNumber} missing url`, 502, undefined, true);
            let lastErr;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const putSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(partTimeout)]) : AbortSignal.timeout(partTimeout);
                    const res = await fetch(targetUrl, { method: "PUT", body: data, signal: putSignal });
                    if (!res.ok)
                        throw new QQApiError(`media upload part ${partNumber} failed (HTTP ${res.status})`, res.status, undefined, true);
                    return;
                }
                catch (err) {
                    lastErr = err;
                }
            }
            throw lastErr instanceof QQApiError ? lastErr : new QQApiError(`media upload part ${partNumber} failed`, 0);
        };
        const parts = Array.from({ length: totalParts }, (_, i) => i + 1);
        for (let index = 0; index < parts.length; index += concurrency) {
            await Promise.all(parts.slice(index, index + concurrency).map(uploadPart));
        }
        // 3. 合并 → file_info
        const finished = await this.postJson(`${base}/upload_part_finish`, { file_uuid: prepared.file_uuid, upload_id: prepared.upload_id }, 15_000, "media upload finish", signal);
        if (typeof finished.file_info !== "string" || !finished.file_info) {
            throw new QQApiError("media upload finish missing file_info", 502, undefined, true);
        }
        return { fileInfo: finished.file_info };
    }
    /** 发送已上传媒体（msg_type:7 被动回复） */
    async sendMedia(target, fileInfo, msgSeq, signal) {
        await this.send(target, {
            msg_type: 7,
            media: { file_info: fileInfo },
            msg_id: target.msgId,
            msg_seq: msgSeq,
            ...(target.type === "group" ? { content: " " } : {}),
        }, signal);
    }
    async send(target, payload, signal) {
        const path = target.type === "private"
            ? `/v2/users/${encodeURIComponent(target.userOpenId ?? "")}/messages`
            : `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/messages`;
        try {
            await this.postJson(path, payload, 10_000, "send", signal);
        }
        catch (err) {
            // 401：token 失效，刷新后重试一次
            if (err instanceof QQApiError && err.status === 401) {
                await this.auth.forceRefresh();
                await this.postJson(path, payload, 10_000, "send", signal);
                return;
            }
            throw err;
        }
    }
    /** ACK 按钮交互(INTERACTION_CREATE 后必须快速 ACK,否则客户端显示错误图标;仿 Hermes _acknowledge_interaction) */
    async ackInteraction(interactionId, code = 0) {
        const token = await this.auth.getToken();
        const res = await fetch(`${this.base}/interactions/${encodeURIComponent(interactionId)}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                Authorization: `QQBot ${token}`,
            },
            body: JSON.stringify({ code }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok && res.status !== 401) {
            throw new QQApiError(`interaction ACK failed [${res.status}]: ${(await res.text()).slice(0, 200)}`, res.status, undefined, true);
        }
        if (res.status === 401) {
            await this.auth.forceRefresh();
            const token2 = await this.auth.getToken();
            const res2 = await fetch(`${this.base}/interactions/${encodeURIComponent(interactionId)}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `QQBot ${token2}`,
                },
                body: JSON.stringify({ code }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res2.ok) {
                throw new QQApiError(`interaction ACK failed [${res2.status}]: ${(await res2.text()).slice(0, 200)}`, res2.status, undefined, true);
            }
        }
    }
    /** 发送"对方正在输入"状态(msg_type:6, C2C 专用;仿 Hermes send_typing) */
    async sendTyping(userOpenId, msgId, msgSeq) {
        await this.postJson(`/v2/users/${encodeURIComponent(userOpenId)}/messages`, {
            msg_type: 6,
            msg_id: msgId,
            msg_seq: msgSeq,
            input_notify: {
                input_type: 1,
                input_second: 60,
            },
        }, 10_000, "typing");
    }
    async postJson(path, payload, timeoutMs, operation, signal) {
        const token = await this.auth.getToken();
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        let res;
        try {
            res = await fetch(`${this.base}${path}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `QQBot ${token}`,
                },
                body: JSON.stringify(payload),
                signal: requestSignal,
            });
        }
        catch (err) {
            throw new QQApiError(`${operation} request failed: ${err instanceof Error ? err.message : String(err)}`, 0);
        }
        let body = {};
        try {
            body = (await res.json());
        }
        catch {
            // 成功发送可能无 body；错误仍由 status 判定
        }
        if (res.ok)
            return body;
        const code = typeof body.code === "number" ? body.code : undefined;
        const message = typeof body.message === "string" ? body.message : "";
        throw new QQApiError(`${operation} failed (status ${res.status}${code != null ? `, code ${code}` : ""})${message ? `: ${message}` : ""}`, res.status, code, true);
    }
}
//# sourceMappingURL=qq-api.js.map