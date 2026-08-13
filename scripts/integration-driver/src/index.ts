/**
 * 全链路集成驱动（开发期）：mock QQ 平台 + 真实 DSH 宿主 + 真实模型。
 *
 * 流程：启动 mock（固定端口 18432/18433）→ 等网关 Identify → 注入 C2C 消息
 * → 等被动回复 → 断言内容 → 写结果文件并退出。
 * 依赖：QQBOT_CONFIG_PATH / QQBOT_API_BASE / QQBOT_TOKEN_URL 指向 mock；
 *       插件行在 overlay 中先于本驱动装载（网关 auto 启动）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { startMockQQServer } from "../../../test/mock-qq-server.ts";

const MOCK_PORT = 18432;
const RESULT_PATH = process.cwd() + "/.integration-result.json";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const name = "qq-bridge-integration-driver";
export const inject: string[] = [];

export async function apply(_ctx: unknown): Promise<void> {
  const results: Record<string, unknown> = { startedAt: Date.now() };
  const mock = await startMockQQServer(MOCK_PORT);
  results.mockBase = mock.baseUrl;
  try {
    // 1. 等网关连接（Identify 到达）
    for (let i = 0; i < 100; i++) {
      if (mock.identify !== undefined) break;
      await sleep(200);
    }
    results.identified = mock.identify !== undefined;
    if (mock.identify === undefined) throw new Error("网关未在 20s 内完成 Identify");

    // 2. 注入私聊消息（授权用户 test-openid）
    mock.sendEvent("C2C_MESSAGE_CREATE", {
      id: "int-msg-1",
      author: { user_openid: "test-openid" },
      content: "Reply with exactly: INTEGRATION_OK",
      attachments: [],
    });

    // 3. 等被动回复（超时 90s：真实模型调用）
    for (let i = 0; i < 180; i++) {
      if (mock.messages.length > 0) break;
      await sleep(500);
    }
    results.messageCount = mock.messages.length;
    const reply = mock.messages[0];
    if (!reply) throw new Error("未收到被动回复（90s 超时）");
    results.replyPath = reply.path;
    results.replyBody = reply.body;
    // Markdown 模式内容在 body.markdown.content；降级纯文本在 body.content
    const md = (reply.body as { markdown?: { content?: unknown } }).markdown?.content;
    const text = typeof md === "string" ? md : typeof reply.body.content === "string" ? reply.body.content : "";
    results.ok = text.includes("INTEGRATION_OK");
    results.finalText = text.slice(0, 200);
  } catch (err) {
    results.ok = false;
    results.error = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      await mock.close();
    } catch {
      // 忽略关闭错误
    }
  }
  try {
    mkdirSync(process.cwd(), { recursive: true });
    writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2));
  } catch {
    // 标记失败不影响判定
  }
  console.log("[integration-driver] " + JSON.stringify(results).slice(0, 600));
  process.exit(results.ok === true ? 0 : 1);
}
