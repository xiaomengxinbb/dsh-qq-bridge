/**
 * 被动回复预算（spec §6.7：每条入站 msg_id 独立预算，默认 4 次；
 * ack/分块/媒体共用；msg_seq 递增保证多次回复顺序与去重）
 */
export declare class ReplyBudget {
    private used;
    readonly msgId: string;
    private readonly limit;
    constructor(msgId: string, limit?: number);
    /** 取下一个 msg_seq（1 起递增）；超过上限返回 undefined */
    nextSeq(): number | undefined;
    /** 剩余配额 */
    get remaining(): number;
    get isExhausted(): boolean;
}
//# sourceMappingURL=reply-budget.d.ts.map