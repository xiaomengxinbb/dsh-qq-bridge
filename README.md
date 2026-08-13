# dsh-qq-bridge

[![npm version](https://img.shields.io/npm/v/dsh-qq-bridge)](https://www.npmjs.com/package/dsh-qq-bridge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-qq-bridge)](https://www.npmjs.com/package/dsh-qq-bridge)
[![License](https://img.shields.io/npm/l/dsh-qq-bridge)](LICENSE)
[![GitHub repo](https://img.shields.io/badge/GitHub-xiaomengxinbb%2Fdsh--qq--bridge-blue?logo=github)](https://github.com/xiaomengxinbb/dsh-qq-bridge)

**首个将 QQ 接入 DeepSeek Harness 的双向桥插件** 🎉——通过 QQ 官方机器人 API v2（私聊 + 群聊），
让你直接在 QQ 里驱动 DeepSeek Harness 的 Agent：每个 QQ 对话拥有独立、持久的隔离 Agent 会话，
像在 Web 里一样使用完整的工具链、模型切换与工作区。

## ✨ 特性

- 🔌 **零依赖网关**：QQ 官方 WebSocket 协议（token 预刷新 / 心跳假死检测 / 指数退避重连 / Resume 补发），仅用 Node 内置能力
- 🧊 **隔离会话**：每 QQ 对话 ↔ 一个持久 DSH Agent（`agents.create/resume`），历史按 (对话, 工作区) 隔离，重启自动恢复
- ⚡ **steering 插嘴**：任务运行中继续发消息，立即注入下一步骤（DSH 原生）
- 📚 **完整命令体系**：`/help /status /model /thinking /new /sessions /resume /compact /stop /workspace` + 键盘按钮
- 🔐 **首访审批**：未授权用户自动生成审批码，管理员一键授权（支持普通用户/管理员两级）
- 🖼️ **多媒体**：图片直入视觉模型、语音 ASR/STT、TXT/PDF 有界提取；安全下载（SSRF 防护）
- 📤 **出站文件**：Agent 可调用 `qq_send_local_file` 把本地文件发回 QQ（白名单 + 硬链接/竞态防护）
- 🗂️ **多工作区**：QQ 侧 `/workspace` 切换目录，会话历史按工作区隔离
- ✅ **实测可用**：116 个单测 + 真实 QQ 沙箱文本闭环验证

> **移植自** [pi-qq-bridge](https://github.com/xiaomengxinbb/pi-qq-bridge)（Apache-2.0）：
> 宿主无关模块（网关/路由/命令/媒体/格式化）原样复用；宿主绑定层（会话创建/工具/命令）改为 DSH 官方 API。

---

## 架构

```
QQ 平台 WS 事件
  → src/gateway/qq-gateway.ts（状态机/心跳/重连/Resume）
  → src/router.ts（去重 → 白名单/审批 → 命令 | FIFO 队列 → 隔离会话）
  → src/session/qq-session.ts（DSH 适配：ctx.agents.create/resume + followup/whenIdle）
  → 最终文本 → src/reply-formatter.ts（Markdown 分块 → 降级纯文本）→ QQApi 发送
```

| 模块 | 说明 |
|---|---|
| `src/gateway/` | token 管理 / WS 网关 / REST 发送与上传（宿主无关，原样移植） |
| `src/session/` | **DSH 隔离会话**：每 QQ 对话 ↔ 一个持久 DSH agent（sessionId `qq-<hash>-<seq>`，cwd = 桥工作区）；注册表懒创建/回收/工作区切换 |
| `src/router.ts` | 消息路由、steering 插嘴、回复预算（宿主无关） |
| `src/commands/` | QQ 侧命令、授权矩阵、审批码、键盘（宿主无关） |
| `src/media/` | 附件安全下载/嗅探/提取/STT/出站媒体（宿主无关；图片经 `ctx.attachments`） |
| `src/core/` | 配置（schemaVersion 4 严格校验）/ 类型 / 错误码（宿主无关） |

**关键宿主 API**（详见 HOST-API.md）：

- 会话：`ctx.agents.create({sessionId, meta:{cwd}, agentOptions, setup})` / `ctx.agents.resume({resumeSessionId})`
- 运行：`agent.followup(createUserMessage(...))` + `agent.whenIdle()` + 事件摘要（官方范式，见 dsh-headless）
- 插嘴/中止：`agent.steer` / `agent.cancel({kind:'user'})`
- 模型：`ctx.agentDefaultModel` + `installModelSelection`；`ctx.llm.listProviders/listModels`
- 工具：`ctx.tools.register(defineTool(...))`（agent 作用域，QQ 会话专属 `qq_send_local_file`）
- 命令：`ctx.commands.register`（全局，Web UI 可见）
- 图片：`ctx.attachments.saveImage` → ImageBlock

---

## 安装

### 开发/冒烟（dev profile，不碰运行中的 GUI）

```bash
# 1. 插件依赖（typescript/@types/node + unpdf）
cd ~/dsh-qq-bridge && pnpm install

# 2. dev profile（已存在 ~/.dsh/profiles/dev，bundles: dsh-base + dsh-headless）
dsh plugin --profile dev add ~/dsh-qq-bridge

# 3. 冒烟：headless 任务 + 插件 overlay
dsh --profile dev --patch ~/dsh-qq-bridge/dev-overlay.yml 'Reply with exactly: OK'
# 验证：qqbotdsh/.boot-marker 出现（apply 已执行）
```

### 挂载到 web profile（正式使用；需重启 dsh web）

```bash
dsh plugin --profile web add ~/dsh-qq-bridge
# 编辑 ~/.dsh/profiles/web/cordis.patch.yml 追加：
#   - insert:
#       - id: dsh-qq-bridge
#         name: 'dsh-qq-bridge'
# 重启 dsh web（注意：这是你正在用的 GUI 服务器）
```

### 配置

```bash
cp config.example.json ~/.dsh/qq-bridge/config.json
chmod 600 ~/.dsh/qq-bridge/config.json
# 填入 appId / clientSecret；sandbox 保持 true
```

字段与 pi-qq-bridge 一致（schemaVersion 4）：`allowUsers` / `allowGroups` / `workspaces` /
`commands` / `sessions` / `replyFormat` / `progress` / `media` / `outboundMedia` 等。

---

## 本地命令（Web 聊天里输入，注册于 ctx.commands）

| 命令 | 说明 |
|---|---|
| `/qqbot-start` / `/qqbot-stop` | 启动/停止 QQ 网关 |
| `/qqbot-status` | 网关/会话/队列/配置/锁状态 |
| `/qqbot-reconnect` | 强制重连 |
| `/qqbot-requests` | 待审批访问申请列表 |
| `/qqbot-approve <码> <user\|admin> [--yes]` | 批准申请（admin 需 --yes 二次确认） |
| `/qqbot-deny <码>` | 拒绝申请（1h 冷却） |
| `/qqbot-revoke <openid> [--yes]` | 撤销权限 |
| `/workspace [名称] \| add <名称> <路径> \| remove <名称>` | 工作区管理 |

## QQ 侧命令（发给机器人）

`/help` `/status` `/last` `/model` `/thinking` `/new` `/sessions` `/resume`
`/name` `/compact` `/stop` `/workspace`（管理命令需 `commands.admins`）

---

## 测试

```bash
npm run typecheck   # tsc --noEmit
npm test            # 116 个测试（node:test；网关测试用本地 mock QQ 平台，含真实 WS 协议）
```

### 真宿主自测（无需 QQ 凭据）

在**纯 dsh-base** 的 dev-int profile 里跑（不要用 headless profile——headless 任务完成后会关停整棵树，
与自测赛跑导致 agent 被 dispose）：

```bash
# 一次性准备
dsh plugin --profile dev-int add ~/dsh-qq-bridge

# 每次验证
DSH_QQBRIDGE_SELFTEST=1 dsh --profile dev-int --patch ~/dsh-qq-bridge/dev-overlay.yml
cat ~/dsh-qq-bridge/.selftest-result.json   # ok: true = 全链路通过
```

覆盖：agents.create（sessionId/cwd/setup）→ 真模型两轮调用 → 持久化 → 跨进程恢复 → newSession → resume → 命名。

### 全链路集成测试（mock QQ 平台 + 真 DSH 宿主 + 真模型）

无需 QQ 凭据即可验证完整业务闭环（WS 网关 ↔ 路由 ↔ 隔离会话 ↔ 模型 ↔ 回复）：

```bash
# 一次性准备
cd ~/dsh-qq-bridge && pnpm install
cd ~ && dsh plugin --profile dev-int add ~/dsh-qq-bridge/scripts/integration-driver

# 每次验证（mock 固定端口 18432/18433）
QQBOT_CONFIG_PATH=~/dsh-qq-bridge/scripts/integration-config.json \
QQBOT_API_BASE=http://127.0.0.1:18432 \
QQBOT_TOKEN_URL=http://127.0.0.1:18432/app/getAppAccessToken \
dsh --profile dev-int --patch ~/dsh-qq-bridge/int-overlay.yml
cat ~/dsh-qq-bridge/.integration-result.json   # ok: true = 闭环通过
```

覆盖：网关握手/心跳 → C2C 消息注入 → 白名单 → 队列 → 真 DSH 会话 → 真模型调用 →
Markdown 格式化 → 被动回复回传。测试期环境变量：`QQBOT_CONFIG_PATH` / `QQBOT_API_BASE` /
`QQBOT_TOKEN_URL`（mock 平台注入，不影响正式运行）。

## 状态与验证进度

- ✅ 沙箱 mock 全链路单测（116 个）
- ✅ dev profile 装载冒烟（apply/命令注册/网关生命周期）
- ✅ **真实 QQ 沙箱文本闭环**（私聊 C2C：消息 → 隔离会话 → 模型回复 → 送达 QQ）
- ⚠️ 分片上传协议字段、op9 4009 行为、Markdown 拒绝特征——以上线实测为准

### 群聊支持状态（重要）

代码层面**完整支持群聊**（`GROUP_AT_MESSAGE_CREATE` 意图、`allowGroups` 白名单、群回复），
但**沙箱环境无法实测**：QQ 开放平台沙箱要求把测试群加入沙箱配置的白名单，
**个人开发者账号无法在沙箱中配置群聊测试**（平台限制，非代码问题）。

群聊接入正式环境的步骤：

1. 机器人应用通过平台**提审上线**（`sandbox: false`）
2. 把机器人**拉入目标群**
3. 获取群 openid（机器人入群后，群内 @ 机器人一次，从网关日志的 `[router] 入站 ... group=<openid>` 行取得）
4. 把群 openid 加入配置 `allowGroups`，重启桥
5. 群内 @ 机器人即可对话

## 开发期开关（默认全部关闭）

| 环境变量 | 作用 |
|---|---|
| `DSH_QQBRIDGE_SELFTEST=1` | apply 时运行真宿主自测（src/dev/self-test.ts，结果写 .selftest-result.json） |
| `DSH_QQBRIDGE_BOOT_MARKER=1` | 写开发期冒烟标记 .boot-marker |
| `QQBOT_DEBUG_START=1` | 启动诊断写 /tmp/qq-start-debug.log |
| `QQBOT_CONFIG_PATH` / `QQBOT_API_BASE` / `QQBOT_TOKEN_URL` | 测试/集成环境覆盖（mock 平台） |

开发期 `node_modules/@deepseek-ai` 是指向 `~/.dsh/profiles/node_modules/@deepseek-ai` 的符号链接（保证与宿主单一拷贝；发布版由 peerDependencies 解析）。
