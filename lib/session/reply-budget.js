/**
 * 被动回复预算（spec §6.7：每条入站 msg_id 独立预算，默认 4 次；
 * ack/分块/媒体共用；msg_seq 递增保证多次回复顺序与去重）
 */
export class ReplyBudget {
    used = 0;
    msgId;
    limit;
    constructor(msgId, limit = 4) {
        this.msgId = msgId;
        this.limit = limit;
    }
    /** 取下一个 msg_seq（1 起递增）；超过上限返回 undefined */
    nextSeq() {
        if (this.used >= this.limit)
            return undefined;
        this.used += 1;
        return this.used;
    }
    /** 剩余配额 */
    get remaining() {
        return this.limit - this.used;
    }
    get isExhausted() {
        return this.used >= this.limit;
    }
}
//# sourceMappingURL=reply-budget.js.map