# DSH 宿主 API 调研（Phase 0 产出）

> 结论：DSH 提供了**完整、官方**的编程式 Agent 创建/驱动 API（dsh-agent + dsh-session + dsh-tools + dsh-commands），
> pi-qq-bridge 移植**不需要**任何 hack——dsh-headless 包就是"创建隔离会话 → 跑一轮任务 → 取结果"的官方范式。
> 本文件回答 SPEC §8.4 的全部 8 个开放问题，并给出可直接照抄的代码范式。

---

## 0. 核心概念速览

| 概念 | 对应 | 说明 |
|---|---|---|
| Agent | `ctx.agents` (AgentRegistry) | 一个 agent = 一个 session + 驱动循环；`Agent.ctx` 是它的私有作用域（工具/提示词可 agent 级注册） |
| Session | `ctx.sessions` (SessionStore) | 事件溯源日志（append-only），`session.deriveMessages()` 派生 LLM 历史 |
| 持久化 | `ctx.sessionPersistence` | jsonl 后端按 **header.cwd** 分目录：`$DSH_HOME/sessions/--<mangled cwd>--/<sessionId>/session.jsonl.zstd` |
| 工具 | `ctx.tools` (ToolRuntime) | `defineTool` + `register`（全局或 agent 作用域）；`restrict` 限制全局工具 |
| 命令 | `ctx.commands` (CommandRuntime) | 本地斜杠命令（不进模型），全局或 agent 作用域 |
| 配置 | `ctx.settings` | 插件注册 namespace + schemastery schema，用户文档层覆盖 |
| 审批 | `ctx.approval` (ApprovalService) | `request({agent, toolName, reason})` → allowed-once/rejected/cancelled/unavailable |
| 模型 | `ctx.llm` (LlmRuntime) + `ctx.agentDefaultModel` | listProviders/listModels；默认模型选择 |
| LLM 消息 | `createUserMessage` | `{content: ContentBlock[], source}`；图片 = `{type:'image', attachment: ImageAttachmentRef}`（走 dsh-attachment） |

**插件形态**（cordis）：导出 `{name, inject?, Config?, apply(ctx, config)}`，包 main 指向入口。

---

## 实战教训（2026-08 自测发现，开发必读）

1. **cordis 服务必须经 ctx.get(name) 访问**（get 是安全访问器，可选服务返回 undefined）；
   属性访问（ctx.agents）在未 inject 声明时会抛 "cannot get property X without inject"。
   插件只 inject 自己直接用的服务（如 commands），其余一律 ctx.get() 兜底。
   dsh-headless 的写法（ctx.get("agents") + 判空）就是官方范式。
2. **sessionPersistence.list() 只返回已物化（有过写入）的会话**——新建但未跑过消息的会话
   不在列表里（lazy materialization，废弃会话零残留）。"new 后立即 sessions 看不到新会话"是预期行为。
3. **插件依赖的 dsh 包必须与宿主同一拷贝**：用 peerDependencies 声明 + 开发期
   node_modules/@deepseek-ai 符号链接指向 profiles/node_modules/@deepseek-ai，
   否则出现双 cordis 实例（installModelSelection 等跨实例操作不可靠）。
4. **真宿主自测方式**：DSH_QQBRIDGE_SELFTEST=1 时插件 apply 内跑 src/dev/self-test.ts
   （创建、真模型调用、持久化、newSession、resume 全链路），结果写 .selftest-result.json。
   ✅ 2026-08-13 实测通过：opencode-go/deepseek-v4-flash 两轮真实调用、16 模型列举、
   会话持久化/新建/恢复全部工作。

---

## 1. Q1：如何以指定 cwd 创建独立持久会话？能否多会话并存？

**能。** 每个 QQ 对话 = 一个独立 `Agent`（sessionId 由我们指定，cwd 由我们指定），
同一进程内多个 agent 并存（AgentRegistry/SessionStore 都是注册表）。

```ts
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// 创建（官方范式，dsh-headless）
const { agent, dispose } = await ctx.agents.create({
  sessionId: SessionId(`qq-${conversationKeyHash}-${n}`), // 自选 id
  meta: { cwd: qqWorkspacePath },   // 决定持久化目录 + bash 沙箱工作目录
  agentOptions: { provider, model }, // 不传则用 agentDefaultModel.currentSelection()
  setup: (agentCtx) => {
    installModelSelection(agentCtx, { current: selectionRef, assembled: undefined });
    // agentCtx 里可注册 QQ 专属工具、限制全局工具、挂 prompt section
  },
});

// 恢复已持久化会话
const { agent } = await ctx.agents.resume({
  resumeSessionId: sessionId,   // 按 id 恢复（backend 自动定位）
  agentOptions: { provider, model },
  setup: ...,
});

// 列出（/sessions 命令用）
const headers = await ctx.sessionPersistence.list(); // SessionHeader[]，过滤 header.cwd
// 关闭
await handle.dispose(); // 停循环 + 注销 + 移除 store + 解挂作用域
```

**持久化细节**：
- 新会话：工厂内部把 meta 折进 SessionHeader 并写库（jsonl backend 的 `create(meta)` 按 cwd 落目录）
- 恢复：`agents.resume` → `ctx.sessionPersistence.prepare(id)`（backend 全局扫描定位）→ 重建 session + agent
- 会话 id 格式自由（Branded string）；建议 `qq-<sha256(convKey+workspace)[:12]>-<seq>` 保证隔离且可枚举
- `session/event`、`session/flush` 事件；每回合结束 `ctx.sessions.flush(session)` 强制落盘
- **注意**：QQ 会话用专用 cwd（如 `~/.dsh/qq-bridge/workspaces/<name>` 或用户选定目录），
  与 DSH UI 的 workspace.json 注册表解耦（不污染用户会话列表，`list()` 按 cwd 过滤）

## 2. Q2：如何"跑一轮 prompt 到结束"取最终文本 + 工具记录？

**官方范式（dsh-headless 逐字照抄）**：

```ts
await agent.whenIdle();                    // 确保就绪
const firstSeq = agent.session.seq;        // 记录起点
agent.followup(createUserMessage({
  content: [{ type: "text", text: prompt }],
  source: { kind: "user" },                // 用户消息；插件注入用 {kind:'plugin', plugin:'dsh-qq-bridge', ...}
}));
await agent.whenIdle();                    // 等本回合完成
await ctx.sessions.flush(agent.session);   // 强制持久化

// 提取：遍历 firstSeq 之后的事件
let text = "";
for (const ev of agent.session.events) {
  if (ev.seq < firstSeq) continue;
  if (ev.type === "assistant/message") {
    const t = ev.data.message.content.filter(b => b.type === "text").map(b => b.text).join("");
    if (t) text = t;
  }
  if (ev.type === "turn/end") reason = ev.data.reason;  // completed/aborted/error{error}
}
```

**工具记录**（showProcess 用）：`tool/call`（name、arguments JSON 字符串）+ `tool/result`（message + error 信息）事件。

**流式观察**：订阅 `session/event`（`assistant/chunk` text-delta）或 `agent/status`。

**插嘴（steering 等价物，DSH 原生支持！）**：
- `agent.steer(createUserMessage(...))` — 运行中注入，下一步骤消费
- `agent.followup(...)` — 排队下一轮
- `agent.inject(...)` — 不唤醒的上下文注入
- `agent.cancel({kind:'user'}, {keepInbox?})` — 中止；默认丢弃排队+steering 项（= pi 的 /stop 语义）

## 3. Q3：模型列表 / 切换 / 思考等级？

| 需求 | API |
|---|---|
| 默认模型 | `ctx.agentDefaultModel.currentSelection(): {provider, model, reasoningEffort?}` |
| 可用模型列表 | `ctx.llm.listProviders()` → `await ctx.llm.listModels(provider)`（LlmModelInfo[]） |
| 单模型详情 | `ctx.llm.resolveModelInfo(provider, model)` |
| 创建时指定 | `agents.create({agentOptions: {provider, model, maxTokens}})` |
| **运行时切换** | setup 里 `installModelSelection(agentCtx, ref)`；之后 `ref.current = {provider, model, reasoningEffort}` 对下一步骤生效 |
| 思考等级 | = `reasoningEffort`（ReasoningEffortId，adapter 自有标识，如 off/low/high…）；随 ModelSelection 或 agent/request 瀑布注入 |

（pi 的 `/model`、`/thinking` 命令直接映射到上面两个 API。）

## 4. Q4：自定义工具注册（qq_send_local_file 等价物）？

```ts
import { defineTool } from "@deepseek-ai/dsh-tools";

const tool = defineTool({
  name: "qq_send_local_file",
  description: "Send one real local computer file to the QQ conversation...",
  parameters: { path: { type: "string", description: "..." } }, // ParameterSchemaSpec
  output: {
    schema: { type: "object", properties: { ... } },            // ValueSchemaSpec
    render: (args, value) => [{ type: "text", text: ... }],     // 模型可见内容
  },
  execute: async (args, exec) => { /* exec.signal 取消；exec.agent 可用 */ },
});

// 全局注册（所有 agent 可见）
ctx.tools.register(tool);
// 或 QQ 会话专属：在 agents.create 的 setup(agentCtx) 里注册 → 仅该 agent 可见
setup: (agentCtx) => { agentCtx.tools.register(tool); };
// 限制全局工具（如去掉 web_search）：ctx.tools.restrict({ deny: [...] })
```

**回合级绑定**：`exec.agent` 拿到当前 agent；我们的 outbound delivery 上下文存到
conversation registry 的 entry 上（每回合设置），execute 闭包读取即可，无需宿主钩子。
（比 pi 的 bindOutboundDelivery 更简单。）

## 5. Q5：本地管理命令 / 通知 / 确认？

```ts
ctx.commands.register({
  name: "qqbot-approve",
  description: "批准访问申请：/qqbot-approve <码> <user|admin>",
  handler: async ({ agent, rawInput, signal }) => {
    // rawInput = 命令后的原文；直接执行，不进模型；可返回 CommandResult
  },
});
```

- 全局注册 → Web UI 对所有 agent 可见可点（dsh-client-ui-commands 自动渲染）
- **确认**：DSH 无 pi 的 ctx.ui.confirm；ApprovalService.request 需要 open turn（不适合管理员命令）。
  方案：二次命令确认（`/qqbot-approve <码> <role> --yes`），或 client 插件做按钮（后续阶段）
- **通知**：host 插件无浏览器 toast；v1 用命令 + `ctx.logger`；Web 通知做 client bundle（Phase 6 可选）

## 6. Q6：workspace 语义映射？

- DSH 中 workspace = 目录（session.header.cwd）；持久化、bash 沙箱都跟 cwd 走
- **映射**：桥内维护 `workspaces` 配置（复用 pi 的 WorkspaceRegistry 原样移植）；
  当前 QQ workspace → 创建 QQ agent 时的 `meta.cwd`
- **切换**：dispose 全部 QQ agent（含初始化中）→ 以新 cwd 懒创建（= pi 的 setWorkspace）
- QQ 会话目录建议独立于 DSH UI 工作区（`~/.dsh/qq-bridge/sessions/<workspaceName>` 或用户目录），
  避免污染 workspace.json 的用户会话列表；`/workspace` 列表/切换命令沿用 pi 语义

## 7. Q7：TUI widget？

DSH 无 pi 的 setWidget。**退化为**：`/qqbot-status`、`/qqbot-last` 命令 + 日志；
流式进度可选 client bundle（dsh.client 机制，Phase 6）。

## 8. Q8：单实例锁 / 跨 reload？

- DSH web profile 的 HMR 默认 disabled（见 dsh-web-app patch）；插件生命周期由 cordis 管理，
  **无 pi 的 /reload 重挂场景** → 进程级单例符号可去掉，改为插件 apply 时抢锁、dispose 时释放
- **保留 instance-guard 锁**（多开 dsh web 时防双连接），锁路径 `~/.dsh/qq-bridge.lock`，
  30s 周期 isLockHeldByMe 校验保留

---

## 9. 插件装载方式（dev loop）

1. 包结构：`package.json` (`main`: 入口, `type`: module) + cordis 插件导出
2. 安装到 profile：`dsh plugin --profile <name> add ~/dsh-qq-bridge`（转发 pnpm，node_modules 共享在 `~/.dsh/profiles/node_modules`）
3. 挂载行：profile 的 `cordis.patch.yml` 加：
   ```yaml
   - insert:
       - id: dsh-qq-bridge
         name: 'dsh-qq-bridge'
   ```
4. **dev profile**（不碰 3080 生产实例）：`~/.dsh/profiles/dev/package.json` 复制 web 的 bundles
   → `dsh --profile dev --port 3099`（webStartup.port 覆盖；默认 3080 冲突需显式传）
5. 冒烟：`dsh --profile dev --dump-config` 验证行组合；`dsh --profile dev --port 3099` 验证模块加载

## 10. 与 pi-qq-bridge 的映射总表

| pi-qq-bridge | DSH 对应 | 备注 |
|---|---|---|
| pi.registerCommand | ctx.commands.register | 全局注册即可 |
| pi.on(session_start/shutdown) | apply(ctx) / 插件 dispose | 生命周期天然对应 |
| ctx.ui.notify | ctx.logger + 命令 | client bundle 可选 |
| ctx.ui.confirm | 二次命令确认 | ApprovalService 不适用（需 open turn） |
| ctx.ui.setWidget | （无） | 退化日志/命令 |
| ExtensionAPI 类型 | cordis Context 类型 | |
| SessionManager.create/continueRecent | ctx.agents.create / resume | 语义一一对应 |
| session.prompt + subscribe | agent.followup + whenIdle + events | 官方范式（headless） |
| session.setModel | installModelSelection ref | |
| session.setThinkingLevel | reasoningEffort | |
| session.compact | session.compact（session 服务） | 需验证 API 形态 |
| session.abort | agent.cancel | |
| customTools/defineTool | ctx.tools.register(defineTool) | agent 作用域注册 |
| resizeImage | ctx.attachments（SaveImageAttachment） | dsh-attachment 服务 |
| SettingsManager.inMemory | agents.create setup 隔离 | 天然隔离（每 agent 独立 ctx） |
| 扩展排除自身 | setup 里 restrict + 不注册 | 天然隔离 |

**已验证的官方范例文件**：
- `dsh-headless/lib/index.js` — 创建→跑→取结果全流程（summarize 函数）
- `dsh-api-remotes/lib/index.js` — resume 范式
- `dsh-tool-bash`、`dsh-commands` — 插件形态与 Config schema
- `dsh-web-app/cordis.patch.yml` — bundle patch / 行插入格式
- `dsh-session-persistence-jsonl` — cwd 分目录存储、list/load 语义
