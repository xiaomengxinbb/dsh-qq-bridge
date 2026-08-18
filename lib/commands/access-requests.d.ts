import type { QQInboundMessage } from "../core/types.ts";
export type QQAccessRole = "user" | "admin";
export interface QQAccessRequest {
    code: string;
    userOpenId: string;
    createdAt: number;
    expiresAt: number;
    /** 原消息元数据（redacted），用于审批后的被动回复 */
    message: QQInboundMessage;
}
export interface QQAccessRequestAdmission {
    request?: QQAccessRequest;
    created: boolean;
    suppressed: boolean;
}
export interface QQAccessRequestStoreOptions {
    ttlMs?: number;
    maxPending?: number;
    denyCooldownMs?: number;
}
export declare class QQAccessRequestStore {
    private readonly byCode;
    private readonly codeByUser;
    private readonly deniedUntil;
    private readonly ttlMs;
    private readonly maxPending;
    private readonly denyCooldownMs;
    constructor(options?: QQAccessRequestStoreOptions);
    /** 登记申请。仅私聊；冷却期内/容量满 → suppressed。重复申请返回同一 code。 */
    admit(message: QQInboundMessage, now?: number): QQAccessRequestAdmission;
    list(now?: number): QQAccessRequest[];
    get(code: string, now?: number): QQAccessRequest | undefined;
    /** 批准：移除申请并返回（调用方负责持久化配置 + 通知用户） */
    approve(code: string, now?: number): QQAccessRequest | undefined;
    /** 拒绝：移除申请 + 冷却（冷却期内该用户申请被压制） */
    deny(code: string, now?: number): QQAccessRequest | undefined;
    get size(): number;
    private purge;
    private remove;
    private createCode;
}
export declare function normalizeAccessRole(value: string | undefined): QQAccessRole | undefined;
//# sourceMappingURL=access-requests.d.ts.map