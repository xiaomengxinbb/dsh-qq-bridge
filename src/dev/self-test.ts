/**
 * 开发期自测（DSH_QQBRIDGE_SELFTEST=1 时在 apply 内运行，验证后 process.exit）
 *
 * 覆盖：agents.create（sessionId/cwd/setup）→ followup+whenIdle 摘要 → 持久化
 * → listSessions → 连续多轮 → newSession → resumeSession → dispose。
 * 结果写 <cwd>/.selftest-result.json 并打印。
 * 发布前删除本文件与 index.ts 中的钩子。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { QQAgentSession, type DshHost } from "../session/qq-session.ts";

/** 自测工作区：固定路径（保证 id 家族稳定，跨运行可恢复/续跑） */
const SELFTEST_WS = process.cwd() + "/.selftest-ws";

export async function runSelfTest(ctx: unknown): Promise<void> {
  const results: Record<string, unknown> = {};
  mkdirSync(SELFTEST_WS, { recursive: true });
  const ws = SELFTEST_WS;
  const host: DshHost = { ctx: ctx as never };
  try {
    // 1. 创建 + 第一轮（真实模型调用）
    const s1 = new QQAgentSession(host);
    await s1.init(ws, { sessionId: "qq-selftest", persistent: true, restore: "recent" });
    results.createdSessionId = s1.sessionId();
    results.ready = s1.isReady();
    const r1 = await s1.run("Reply with exactly: SELFTEST_OK");
    results.run1 = r1.text;
    results.run1Tools = r1.tools.length;

    // 2. 模型/思考等级
    results.model = s1.currentModel();
    results.thinking = s1.thinkingLevel();
    results.availableModels = (await s1.availableModels()).length;

    // 2.5 诊断：原始持久化列表 + 事件摘要
    try {
      const raw = await (s1 as unknown as { listPersistedIds(): Promise<string[]> }).listPersistedIds();
      results.diagPersistedIds = raw;
      const persistence = (s1 as unknown as { svc<T>(n: string): T | undefined }).svc<{
        list(): Promise<Array<{ id: string; cwd?: string }>>;
      }>("sessionPersistence");
      const all = persistence ? await persistence.list() : [];
      results.diagAllHeaders = all.map((h) => ({ id: h.id, cwd: h.cwd }));
      const agent = (s1 as unknown as { requireAgent(): { session: { events: Array<{ type: string; seq: number; data: Record<string, unknown> }> } } }).requireAgent();
      results.diagEventTypes = agent.session.events.map((e) => e.type).slice(-14);
      const turnEnd = agent.session.events.filter((e) => e.type === "turn/end").pop();
      results.diagTurnEnd = turnEnd?.data as unknown;
      const splices = agent.session.events.filter((e) => e.type === "agent/inbox/spliced").map((e) => e.data);
      results.diagSplices = splices as unknown;
    } catch (err) {
      results.diagError = String(err);
    }

    // 3. 持久化：listSessions 应包含刚创建的会话
    const list1 = await s1.listSessions();
    results.listCount1 = list1.length;
    results.list1Names = list1.map((s) => ({ id: s.id.slice(0, 20), name: s.name, msg: s.messageCount }));

    // 4. 连续第二轮（同会话上下文延续）
    const r2 = await s1.run("Reply with exactly: SELFTEST_AGAIN");
    results.run2 = r2.text;
    try {
      const agent2 = (s1 as unknown as { requireAgent(): { session: { events: Array<{ type: string; seq: number; data: Record<string, unknown> }> } } }).requireAgent();
      const recent = agent2.session.events.slice(-10).map((e) => e.type);
      results.diagRun2Events = recent;
      const turnEnd = agent2.session.events.filter((e) => e.type === "turn/end").pop();
      results.diagRun2TurnEnd = turnEnd?.data as unknown;
    } catch (err) {
      results.diagRun2Error = String(err);
    }
    try {
      const probe = (ctx as { get?(n: string): unknown }).get?.("agents");
      results.diagAgentsProbe = probe ? "present" : "undefined";
    } catch (err) {
      results.diagAgentsProbe = "throw: " + String(err);
    }

    // 5. 新会话（同对话新 seq）+ 恢复旧会话
    const created = await s1.newSession("selftest-2");
    results.newSessionId = created.id;
    const list2 = await s1.listSessions();
    results.listCount2 = list2.length;
    const firstId = list2[list2.length - 1]?.id ?? "";
    const resumed = await s1.resumeSession(firstId);
    results.resumedId = resumed.id;

    // 6. 命名 + 释放
    const named = s1.setSessionName("selftest-renamed");
    results.renamed = named;
    await s1.dispose();
    results.ok = true;
  } catch (err) {
    results.ok = false;
    results.error = err instanceof Error ? err.stack ?? err.message : String(err);
  }
  try {
    mkdirSync(process.cwd(), { recursive: true });
    writeFileSync(
      process.cwd() + "/.selftest-result.json",
      JSON.stringify(results, null, 2),
    );
  } catch {
    // 标记失败不影响结果判定
  }
  console.log("[qq-bridge-selftest] " + JSON.stringify(results));
  process.exit(results.ok === true ? 0 : 1);
}
