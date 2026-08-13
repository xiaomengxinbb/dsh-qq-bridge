/**
 * 消息去重（spec §6.2：msg_id 去重，2h TTL / 2000 条上限）
 */
export class MessageDedupe {
	private readonly seen = new Map<string, number>();

	private readonly ttlMs: number;
	private readonly maxEntries: number;

	constructor(ttlMs = 2 * 60 * 60 * 1000, maxEntries = 2000) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}

	/**
	 * 尝试登记消息。返回 true = 首次见到（放行），false = 重复（丢弃）。
	 * 相同 msg_id 可能被 QQ 平台重复推送，必须去重。
	 */
	admit(id: string, now = Date.now()): boolean {
		if (!id) return false;
		this.purge(now);
		if (this.seen.has(id)) return false;
		this.seen.set(id, now);
		if (this.seen.size > this.maxEntries) this.evictOldest();
		return true;
	}

	/** 是否已见过（不登记） */
	has(id: string, now = Date.now()): boolean {
		const ts = this.seen.get(id);
		if (ts === undefined) return false;
		if (now - ts > this.ttlMs) {
			this.seen.delete(id);
			return false;
		}
		return true;
	}

	get size(): number {
		return this.seen.size;
	}

	private purge(now: number): void {
		for (const [id, ts] of this.seen) {
			if (now - ts > this.ttlMs) this.seen.delete(id);
		}
	}

	private evictOldest(): void {
		let oldestId: string | undefined;
		let oldestTs = Infinity;
		for (const [id, ts] of this.seen) {
			if (ts < oldestTs) {
				oldestTs = ts;
				oldestId = id;
			}
		}
		if (oldestId !== undefined) this.seen.delete(oldestId);
	}
}
