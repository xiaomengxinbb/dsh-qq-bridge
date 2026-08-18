p = "src/gateway/qq-api.ts"
s = open(p).read()
# 移除第二个 ackInteraction（我插入的重复块）：从 279 行后的注释到 postJson 前
marker = "	}

	/** ACK 按钮交互(INTERACTION_CREATE 后必须快速 ACK,否则客户端显示错误图标;仿 Hermes _acknowledge_interaction) */
	async ackInteraction(interactionId: string, code = 0): Promise<void> {"
# 找到第二次出现的位置（第一次出现保留）
first = s.find(marker)
second = s.find(marker, first + 1)
assert first != -1 and second != -1, f"marker not found twice: {first}, {second}"
end = s.find("	private async postJson(", second)
assert end != -1
# 删除从 second 到 end 的内容（保留第一个 ackInteraction 和 postJson）
s = s[:second] + s[end:]
open(p, "w").write(s)
print("duplicate removed")
