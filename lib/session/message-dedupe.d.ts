/**
 * 消息去重（spec §6.2：msg_id 去重，2h TTL / 2000 条上限）
 */
export declare class MessageDedupe {
    private readonly seen;
    private readonly ttlMs;
    private readonly maxEntries;
    constructor(ttlMs?: number, maxEntries?: number);
    /**
     * 尝试登记消息。返回 true = 首次见到（放行），false = 重复（丢弃）。
     * 相同 msg_id 可能被 QQ 平台重复推送，必须去重。
     */
    admit(id: string, now?: number): boolean;
    /** 是否已见过（不登记） */
    has(id: string, now?: number): boolean;
    get size(): number;
    private purge;
    private evictOldest;
}
//# sourceMappingURL=message-dedupe.d.ts.map