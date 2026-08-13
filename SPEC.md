# pi-qq-bridge → DSH 移植 Spec

> **文档目的**：作为新工作区（qqbotdsh）开发"QQ → DeepSeek Harness 插件"的移植基准文档。
> **来源**：pi-qq-bridge v0.1.2（~/qqbot，Apache-2.0），2026-08 源码通读整理。
> **阅读对象**：在 DSH 上重建同等能力的开发者。凡涉及宿主差异处均标注「宿主无关」或「需替换」。

---

## 1. 项目概述

**一句话**：通过 QQ 官方机器人 API v2 将 QQ（私聊 + 群聊 @）接入本地 coding agent 的双向通信扩展，每个 QQ 对话拥有独立、持久的隔离 Agent 会话，支持工作区切换。

**验证状态（v0.1.x）**：沙箱环境已实测（token / WS 连接 / 心跳 / 文本闭环 / 自动授权）；正式环境与分片上传、群聊、命令、多媒体、出站 **未全部实测**——这些点在代码里标注"以上线实测为准"。

**技术底座**：TypeScript（Node ≥ 22.19，type-strip 直接运行 .ts），零运行时依赖（WebSocket 用 Node 内置），peer 依赖 @earendil-works/pi-coding-agent ≥ 0.82。测试 154 个（node:test + 本地 mock QQ 平台，含真实 WS 协议 mock）。

---

## 2. 核心功能清单（移植必须保留的能力）

### 2.1 双向消息
- 私聊（C2C）与群聊（GROUP_AT_MESSAGE_CREATE，仅 @ 触发）双向收发
- 被动回复（引用 msg_id），单消息回复预算上限 4 次
- 消息去重：msg_id 2h TTL / 2000 条上限（平台会重复推送）

### 2.2 隔离会话架构（本项目灵魂）
- 每个 QQ 对话（key = `private:{user_openid}` / `group:{group_openid}`）一个独立、持久的 Agent 会话
- 会话文件存专属目录，**绝不进入**本地 TUI 会话列表
- 会话加载宿主 skills/MCP/插件，但**排除 pi-qq-bridge 自身**（防递归）
- 懒创建 + 空闲回收（30min）+ 常驻上限（8 个，超限回收最旧空闲）

### 2.3 会话管理命令（QQ 侧）
`/help` `/status` `/last` `/model` `/thinking` `/new` `/sessions` `/resume` `/name` `/compact` `/stop` `/workspace`
- 管理命令（mutating）需 `commands.admins` 权限；群内管理命令默认关闭
- 多步交互（模型选择、会话恢复消歧、确认）用**命令状态机**（selection 300s / confirmation 120s TTL）
- 原生键盘按钮（5 行 × 2 列，permission.type=2 全员可点，权限仍由服务端校验）

### 2.4 本地管理命令（主机侧）
`/qqbot-start|stop|status|reconnect|runtime|last|requests|approve|deny|revoke` + `/workspace`（add/remove/切换，带补全）

### 2.5 访问审批流
- 未授权私聊 → 6 位审批码（10min TTL，每用户唯一）→ 管理员本地 `/qqbot-approve <码> <user|admin>` → 原子持久化 + 热生效 + QQ 通知
- 申请只记录 OpenID + 元数据（**正文 redact**，附件批准前不下载）；deny 后 1h 冷却；pending 上限 20

### 2.6 多媒体入站
- **图片** → 安全下载 → 嗅探 → resize → base64 进 prompt images[]（视觉模型；不支持则明确提示）
- **语音** → QQ ASR 文本优先（asr_refer_text）；可选 OpenAI-compatible STT（密钥仅环境变量）
- **TXT/PDF** → 有界提取正文（编码校验；PDF 文本层，不 OCR）
- **DOC/压缩包/视频** → 明确拒绝（不把二进制当文本、不自动解压执行）
- 失败附件不中断整体：rejected 资源 + 稳定错误码 + 汇总回复
- 附件内容以 `<qq-attachments untrusted="true">` 标记进 prompt，**声明为不可信数据**

### 2.7 出站媒体（默认关闭，独立权限）
- agent 可调用工具 `qq_send_local_file` 把本地文件发回当前 QQ 对话
- 校验链：realpath → allowedRoots 白名单（OS tmp 恒可用）→ 普通文件 → 硬链接拒绝 → 大小限制 → 读取前后 stat 复检（rename-race）→ 上传（base64 ≤5MB，大文件分片）→ 发送
- 目标绑定当前回合（模型不能改 openid/msg_id/msg_seq）；媒体与文字共用回复预算

### 2.8 回复格式
- Markdown 优先（msg_type:2），被平台拒绝降级纯文本（msg_seq 对齐）
- 语义边界分块：每块 ≤3600B UTF-8，最多 4 块，加"回答(1/N)"标签
- 宽 Markdown 表格自动转列表；控制字符清理；超长截断（源 14KB）

### 2.9 进度回执与运行态
- 慢任务（>3s 未完成）先发"已收到，正在处理…"（占 1 次回复配额）
- 可选 showProcess：最终回复追加工具执行摘要
- **steering 插嘴**：同对话运行中再发消息 → 不等旧任务完成直接注入（当前回合结束后生效）；/stop 清空待处理队列并中止

### 2.10 工作区
- 配置注册 `{name, path}`；default 恒存在（= 宿主启动目录）；name 限 `[a-zA-Z0-9_-]{1,32}`
- 切换 = 旧会话全部 dispose，新会话以新 cwd 懒创建；会话历史按 (对话, 工作区) 隔离，**永不跨工作区恢复**
- 启动即校验全部 path（realpath + isDirectory）

### 2.11 单实例守卫
- 文件锁（O_EXCL，`~/.pi/agent/pi-qq-bridge.lock`，0600）：同一时刻只有一个进程持有 QQ 网关
- 陈旧锁检测（pid 存活 / mtime 5min）；进程退出路径统一释放；锁丢失检测（30s 周期，锁不在本进程 → 主动断网关防双连接）

---

## 3. 总体架构

### 3.1 分层

```
src/
├── core/        config（schemaVersion 4 严格校验 + 深合并默认值）、类型、稳定错误码、用户侧文案
├── gateway/     qq-auth（token 生命周期）· qq-gateway（WS 状态机）· qq-api（REST 发送/上传）
├── session/     qq-session（隔离 AgentSession）· conversation-registry · workspace-registry
│                message-dedupe · reply-budget
├── media/       attachment-pipeline（编排）· attachment-downloader（安全下载）·
│                attachment-extractors（TXT/PDF）· stt · outbound-media
├── commands/    command-parser · command-controller（授权+状态机）· access-requests ·
│                qq-keyboard · model-pages
├── index.ts     入口与编排（进程级单例、/reload 语义、本地命令）
├── router.ts    消息路由核心（去重→授权→命令/队列→隔离会话→回复）
├── reply-formatter.ts · terminal-view.ts · instance-guard.ts
```

### 3.2 入站数据流

```
QQ 平台 WS 事件
  → QQGateway.dispatchEvent（归一化 QQInboundMessage）
  → QQRouter.handleInbound
      ├─ MessageDedupe（msg_id）
      ├─ 白名单校验（allowUsers/allowGroups）
      │    └─ 未授权私聊 → QQAccessRequestStore 审批码流程
      ├─ 命令（/开头）→ CommandStateMachine + 授权矩阵 → executeCommand
      └─ 普通消息 → 附件预处理（AttachmentPipeline）
           → FIFO 队列（maxQueueSize 20，满丢最新）
           → pump 串行 → ConversationRegistry.get（懒创建隔离会话）
           → QQAgentSession.run(prompt, {images})
           → 最终文本 → reply-formatter 分块 → QQApi.send（Markdown→降级纯文本）
           → ReplyBudget 控制 msg_seq（每入站消息独立 4 次预算）
```

### 3.3 关键对象关系

- `index.ts` 组装：QQAuth → QQGateway / QQApi / AttachmentPipeline / ConversationRegistry / QQRouter / WorkspaceRegistry / QQAccessRequestStore / TerminalView
- gateway.onInbound → router.handleInbound（单向）
- router 依赖 registry（懒建会话）+ api（发送）+ pipeline（附件）+ stateMachine + accessRequests + workspaceRegistry
- 进程级单例：`Symbol.for("pi-qq-bridge.runtime.v1")` 挂 globalThis，跨 /reload 存活（WS socket 与定时器是进程级的，reload 只换 ctx 视图）

---

## 4. 各模块实现要点（移植时按此还原）

### 4.1 QQAuth（token 生命周期）— 宿主无关
- POST `https://bots.qq.com/app/getAppAccessToken`（appId + clientSecret → access_token）
- expires_in 7200s；过期前 60s 预刷新；并发刷新去抖（共享 Promise）
- 失败指数退避 5s→30s；**连续 3 次失败 → onFatal 回调**（断网关 + 通知用户）
- API 401 → forceRefresh 后重试一次（调用方）
- 凭据仅内存：不落盘、不进日志；tokenUrl 主机白名单（SSRF 防护）

### 4.2 QQGateway（WS 网关）— 宿主无关
- 状态机：disconnected → connecting → connected → error
- GET `{base}/gateway` 取 wss url（Authorization: `QQBot {token}`）
- 协议：op10 Hello → op2 Identify（token, intents=1<<25 GROUP_AND_C2C_EVENT, shard [0,1]）→ READY；op1 心跳（d=lastSeq）/ op11 ACK；op7 Reconnect 主动重连；op9 Invalid Session（4009 可 resume）
- **Resume（op6）**：断线重连带 session_id + seq 补发遗漏事件；非 4009 错误清空重走 Identify
- 自动重连：指数退避 1s→30s，最多 5 次后停止（暴露手动重连命令）
- 心跳假死检测：ACK 超 15s → 主动重连
- API base：沙箱 `https://sandbox.api.sgroup.qq.com` / 正式 `https://api.sgroup.qq.com`
- 事件归一化：C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE → QQInboundMessage（含 attachments 字段透传 asr_refer_text）
- 零依赖：Node 内置 WebSocket（≥22.19）

### 4.3 QQApi（REST 发送）— 宿主无关
- 路径：私聊 `/v2/users/{openid}/messages`；群 `/v2/groups/{group_openid}/messages`
- msg_type：0 纯文本（可带 keyboard）、2 Markdown（群聊要求 content 非空占位）、7 媒体
- 均带 msg_id（被动回复）+ msg_seq（递增去重保序）
- 上传：`/v2/users|groups/{id}/files`（file_type 1=图片 4=文件，base64，srv_send_msg=false）→ 返回 file_info（TTL）→ sendMedia
- **分片上传**：upload_prepare → 逐块 PUT 预签名 URL（并发 2，单块重试 1 次）→ upload_part_finish → file_info；默认 block 1MB、maxParts 128（协议字段**以上线实测为准**）
- 401 → forceRefresh 重试一次；QQApiError{status, code, requestAccepted}

### 4.4 ConversationRegistry — 宿主无关（依赖宿主 session 工厂）
- key：`private:{user_openid}` / `group:{group_openid}`
- 懒创建：首次消息才 init 会话（mkdir sessionDir 0700 → session.init(cwd, {sessionDir, persistent, restore})）；并发初始化去抖（entry.initializing Promise）
- 回收：idleDisposeMs 空闲回收（非 streaming 且非初始化中）；maxResident 超限逐出最旧空闲；全忙则拒绝
- sessionDir：`sha256("pi-qq-bridge\0"+key+"\0"+workspaceName)` 前 32 位 → `{agentDir}/pi-qq-bridge/sessions/{hash}`（按 (对话, 工作区) 隔离）
- setWorkspace：旧会话全部 dispose（含初始化中），新会话以新 cwd 懒创建

### 4.5 QQAgentSession（隔离 AgentSession）— **宿主绑定（移植核心难点）**
- **动态定位宿主 SDK**：从 process.argv[1] 反向定位 pi 安装目录（或 PI_QQBRIDGE_SDK_ENTRY 覆盖；import.meta.resolve 兜底），运行时 import，类型未知
- init：SessionManager.create/continueRecent/inMemory → createAgentSessionServices（cwd, agentDir, 内存隔离 SettingsManager）→ createAgentSessionRuntime → bindExtensions
- **隔离设置**：读宿主全局 settings 一次，扩展列表过滤掉 pi-qq-bridge 自身路径特征（"pi-qq-bridge"/"qq-bridge"/"qqbot"）后建 inMemory 副本——QQ 侧所有变更（/model 等）不污染本地
- run()：session.subscribe 事件流（agent_start / message_update text_delta|text_end / tool_execution_start|end / agent_end）→ session.prompt(prompt, {source:"extension", images}) → agent_end 时从 messages 提取最终 assistant 文本（stopReason=error 显式抛错）
- 会话管理：newSession / switchSession（限本对话作用域 listSessions）/ compact / abort / setModel（限 availableModels）/ setThinkingLevel（归一化 off..max）
- 自定义工具：defineTool("qq_send_local_file")，execute 委托给当前回合的 QQOutboundDeliveryContext（回合结束 close，防串目标）

### 4.6 QQRouter — 宿主无关
- handleInbound：去重 → 授权 → 命令/附件+普通消息分流
- 队列：FIFO，maxQueueSize 20 满丢最新；pump 单飞串行（running 标志防重入）
- runOne：ReplyBudget（4 次/消息）→ progress ack 定时器（3s）→ 附件预处理 → registry.get → 绑定 OutboundDeliveryContext → session.run → 格式化发送 → 错误映射（formatUserFacingAgentError：abort/认证/上游/网络分类 + 稳定文案）
- **steering**：activeConversation 记录当前运行 (key, session, accepting)；同对话新消息 → steerInto（附件走管线后 session.steer，不回中间回复）；失败回退入队
- 命令分发：parseQQCommand（无 shell 无模型，纯 tokenize，支持引号/转义/全角斜杠、2048B/20 参数上限）→ authorizeQQCommand（白名单 + 管理命令授权矩阵 + 远程危险命令黑名单 login/logout/theme/settings/quit/exit/reload/tree/fork/clone/clear/redo/undo）→ executeCommand
- 发送：sendFormatted 分块循环，Markdown 被拒 → 剩余全部降级纯文本（msg_seq 对齐）；回复失败不抛出（防队列卡死）
- 事件观察者（onEvent）：queued/run_start/run_end/reply/access_request/command/error → TerminalView（≤10 行 widget，观察者失败不影响主流程）

### 4.7 命令状态机 — 宿主无关
- QQ 无终端回车，多步命令用显式 pending：selection（/model 序号、/sessions、/resume 消歧；TTL 300s）/ confirmation（TTL 120s）
- 每对话独立；新命令覆盖旧状态；TTL 过期静默清除

### 4.8 访问审批 — 宿主无关
- admit（仅私聊、冷却期/容量压制、重复申请同码）→ 本地 list/approve/deny
- 批准落地：saveConfig 原子写（tmp+rename 0600）→ 热生效（router/registry 持有同一 config 引用）→ QQ 被动回复通知（引用原消息，60min 窗口）
- admin 授权需本地二次确认（ctx.ui.confirm）

### 4.9 附件管线 — 宿主无关（图片 resize 依赖宿主 SDK）
- 编排：数量/总字节限制（4 个/30MB）→ 逐附件下载 → 嗅探分类 → 提取/转写/resize → PreparedQQMessage{prompt, images, resources, cleanup}
- **安全下载器**：仅公网 HTTPS；每次请求/重定向 DNS 解析校验 + 结果 pinning（SSRF）；≤5 重定向、≤2 重试（指数退避）；流式大小断言 + 落盘复核；超时 + AbortSignal；临时目录 `/tmp/pi-qq-bridge/{runtimeId}/{messageId}/` 0700，处理完 cleanup
- 嗅探：magic bytes → kind（image/audio/pdf/doc/text/archive/unknown）；声明与实嗅不符 → mime_mismatch 拒绝
- 提取：TXT（UTF-8/UTF-16 fatal 校验，2MB/150k 字符）；PDF（unpdf 文本层，20MB/100 页/150k 字符，无文本层报 pdf_no_text 不 OCR）；DOC 明确拒绝
- 图片：宿主 resizeImage → base64 进 images[]；XML 标签片段 `<image index name mime/>` 进 prompt
- 语音：QQ ASR 优先；STT（OpenAI-compatible /audio/transcriptions，key 只读环境变量）
- prompt 头部：`[QQ private user=... message=... ref=correlationId]` + `<qq-attachments untrusted="true">` + 不可信声明

### 4.10 出站媒体 — 宿主无关（工具注册宿主绑定）
- 校验链（顺序敏感）：outboundMedia.enabled → adminsOnly → 每回合数量上限（2）→ 回复预算预留 → resolveAllowedLocalFile（realpath 后必须在 allowedRoots 或 OS tmp 内，不信任 cwd）→ open O_NOFOLLOW → /proc/self/fd realpath pinning → 普通文件 → nlink>1 硬链接拒绝 → 大小限制（图片 10MB/文件 20MB/回合累计 30MB）→ 读后 stat 复检（size/mtime，rename-race）→ base64 或分片上传 → sendMedia（msg_seq 再预留）
- QQApiError.requestAccepted=false（网络中断无法确认）→ status "unknown" 明确告知

### 4.11 回复格式化 — 宿主无关
- normalizeMarkdown（\r\n 归一、控制字符、表格转列表）→ 语义分块（标题归属其后内容、代码围栏不拆、单行硬切）→ ≤3600B × 4 → "回答(1/N)" 标签 → markdownToPlain 同步降级（保证 msg_seq 对齐）

### 4.12 工作区 — 宿主无关
- WorkspaceRegistry：default 恒存在（= 宿主 cwd）；配置 + 运行时 add/remove（本地命令，持久化热生效）；启动即校验路径

### 4.13 实例守卫 — 宿主无关
- 锁文件 O_EXCL 0600 + pid；stale = pid 不存在 || mtime > 5min；exit/SIGINT/SIGTERM/uncaughtException/unhandledRejection 统一释放；30s 周期 isLockHeldByMe 校验

### 4.14 index.ts 编排 — **宿主绑定（pi.* API）**
- 进程级单例跨 /reload 存活；HOST_SCHEMA + buildId（src 递归哈希）用于 reload 后判定旧 runtime 需替换
- session_start：已有 runtime → 只换 TerminalView（新 ctx）；否则 auto 模式抢锁建桥
- session_shutdown：keepAcrossLocalSessions=false → 停止网关 + 释放锁；true → 保持（进程级）

---

## 5. 关键设计决策（移植时不要推翻）

| # | 决策 | 理由 |
|---|---|---|
| 1 | schemaVersion 严格匹配，缺失/不符拒绝启动（不静默迁移） | 配置是契约；迁移必须显式可测 |
| 2 | 回复预算 4 次/消息（msg_seq 递增），ack/分块/媒体共用 | QQ 文档 4/5 冲突，保守取 4 |
| 3 | 会话目录 hash 隔离 (对话, 工作区)，永不跨工作区恢复 | 防止目录间会话串扰 |
| 4 | 附件内容标记 untrusted + 明确提示语 | 防 prompt 注入 |
| 5 | 出站媒体默认关闭 + allowedRoots 白名单 + 硬链接/rename-race 校验 | 数据外传是高危权限 |
| 6 | 键盘按钮 permission.type=2（全员可点），权限服务端校验 | v2 openid 不能用于 specify_user_ids |
| 7 | 错误码是稳定契约（枚举），回复文本可本地化、code 原样暴露 | 测试与排查依赖稳定码 |
| 8 | Markdown 被拒 → 剩余全部降级纯文本，msg_seq 对齐 | 避免部分消息丢失/乱序 |
| 9 | 单实例文件锁 + 锁归属周期校验 | 防双连接被平台踢 |
| 10 | 隔离会话排除自身扩展（路径特征） | 防递归调用 QQ 桥 |
| 11 | 附件下载仅 HTTPS + DNS pinning + 重定向校验 | SSRF 防护（QQ 附件域名是公网 IP，实测不拦） |
| 12 | 语音优先 QQ ASR，STT 密钥仅环境变量 | 少一个依赖；密钥不进配置 |

---

## 6. 配置 Schema（schemaVersion 4 全量）

关键字段（默认值见 pi-qq-bridge.json.example）：

- `enabled` true；`startup.mode` auto|manual；`startup.keepAcrossLocalSessions` true
- `appId` / `clientSecret`（必填，空串拒绝）
- `sandbox` true（沙箱/正式切换）
- `allowUsers` [] / `allowGroups` []（openid 白名单）
- `workspaces` [{name, path}]（path 空 = 宿主启动目录；default 恒存在）
- `commands`：enabled、accessRequests、allowInGroups、admins、buttons、maxListItems 5、modelPageSize 6、selectionTtlMs 300000、confirmationTtlMs 120000
- `sessions`：mode persistent|memory、restore recent|new、maxResident 8、idleDisposeMs 1800000
- `replyFormat` auto|plain；`showProcess` false；`progress`{enabled, ackAfterMs 3000}；`maxQueueSize` 20
- `media`：enabled、maxAttachments 4、maxTotalBytes 30MB、downloadTimeoutMs 120000、image.maxBytes 10MB、voice{enabled, preferQQAsr, maxBytes 25MB, stt{apiKeyEnv, model, timeoutMs}}、documents{allowExtensions [.txt .pdf .doc], maxTxtBytes 2MB, maxPdfBytes 20MB, maxDocBytes 10MB, maxPdfPages 100, maxExtractedChars 150000}
- `outboundMedia`：enabled false、adminsOnly、allowPrivate/allowGroups、allowedRoots []、images/files、maxFilesPerTurn 2、maxImageBytes 10MB、maxFileBytes 20MB、maxTotalBytes 30MB、uploadTimeoutMs 30000、uploadMode auto|base64|chunked、base64UploadMaxBytes 5MB、chunked{maxParts 128, partConcurrency 2, ...}
- `logging.level` info；`debug` false（/tmp/pi-qq-bridge-gw.log）

加载：深合并默认值（只信任默认键）→ 关键字段类型校验 → ConfigError 用户可读报错。

---

## 7. 安全模型汇总

1. **凭据**：仅内存；配置 0600 勿提交；token 端点主机白名单
2. **SSRF**：附件下载仅 HTTPS + DNS 解析校验 + 每次重定向复验 + 结果 pinning
3. **不可信数据**：附件正文标记 untrusted 进 prompt；ASR 文本提示可能不准
4. **权限**：白名单双列表（user/group）+ 管理命令 admin 矩阵 + 审批码首访 + admin 授权二次确认
5. **数据外传**：出站媒体默认关；allowedRoots；硬链接/rename-race/符号链接防护；每回合上限
6. **资源限制**：附件数量/大小/页数/字符数全有上限；下载/上传/STT 超时；回复预算；队列上限
7. **稳定性**：单实例锁防双连接；心跳假死检测；token 失败致命回调；所有观察者失败隔离；回复失败不阻塞队列

---

## 8. 宿主（Pi）API 依赖面 —— 移植到 DSH 的差异清单

### 8.1 pi.* 调用点（需找 DSH 等价物）

| 调用 | 位置 | 用途 | DSH 对应思考 |
|---|---|---|---|
| `pi.registerCommand(name, {description, handler, getArgumentCompletions})` | index.ts 全部本地命令（11 个） | 本地管理命令 | DSH: 命令/插件服务（cordis command?）需调研 |
| `pi.on("session_start"/"session_shutdown")` | index.ts | 生命周期（auto 连接 / reload 重挂 / 停机策略） | DSH: 插件 apply/active/stop 生命周期 |
| `ctx.ui.notify(msg, level)` | index.ts | 本地通知 | DSH: 客户端通知（ui notify） |
| `ctx.ui.confirm(title, msg)` | index.ts approve/revoke | 二次确认 | DSH: ask_user 类确认 |
| `ctx.ui.setWidget(id, lines)` | terminal-view | TUI 尾视图 | DSH: 客户端 UI 插件或省略 |
| `ctx.cwd` | index.ts | 宿主启动目录 | DSH: session workspace path |
| `ExtensionAPI` 类型 | index.ts | 类型契约 | DSH: 插件类型定义 |

### 8.2 动态宿主 SDK 调用点（qq-session.ts 内，全部经 resolveSdkEntry 运行时 import）

| SDK 符号 | 用途 | DSH 对应思考 |
|---|---|---|
| SettingsManager.create / inMemory / getGlobalSettings | 读宿主全局配置 + 内存隔离 | DSH: 配置服务（settings） |
| createAgentSessionServices | 建隔离会话服务（resourceLoader extensionsOverride 排除自身） | DSH: 会话服务组装 |
| createAgentSessionFromServices / createAgentSessionRuntime | 组装 runtime | DSH: agent session runtime |
| SessionManager.create / continueRecent / inMemory / list | 会话持久化/恢复/列表 | DSH: dsh-session + workspace 注册表 |
| runtime.session.bindExtensions / subscribe / prompt / setModel / setThinkingLevel / compact / abort / sessionManager | 运行与管控 | DSH: agent session API |
| resizeImage | 图片压缩 | DSH: 需等价实现（或本地 sharp 等） |
| defineTool | 注册 qq_send_local_file | DSH: 工具注册服务 |

### 8.3 宿主无关、可原样复用的模块（预计 70%+ 代码量）
qq-auth、qq-gateway、qq-api、router、conversation-registry（工厂注入）、workspace-registry、message-dedupe、reply-budget、command-parser、command-controller、access-requests、qq-keyboard、model-pages、attachment-downloader、attachment-extractors、stt、outbound-media（工具入口外）、reply-formatter、instance-guard、error-codes、user-facing、config。

### 8.4 移植到 DSH 的开放问题
1. DSH 会话（dsh-session）如何以"指定 cwd + 指定持久化目录"创建独立会话？能否多会话并存（每 QQ 对话一个）？
2. DSH 是否提供"运行一次 prompt 到结束、取最终文本与工具记录"的编程接口（等价 session.subscribe + prompt + agent_end）？
3. 模型列表/切换/思考等级 API 对应 DSH 哪个服务（modelRuntime/modelRegistry?）？
4. 自定义工具注册（defineTool 等价物）与回合级绑定上下文（delivery context）如何实现？
5. 本地管理命令/通知/确认在 DSH 插件体系中的挂载点？
6. DSH 的 workspace 与 pi-qq-bridge 的 workspace 语义如何映射（DSH 已有 workspace registry + 会话按 workspace 隔离）？
7. 是否需要 TUI widget（可省略，DSH 无同等 UI 槽位时可退化为日志）。
8. 单实例锁、进程级单例跨 reload 语义在 DSH 插件生命周期里是否仍必要（DSH 插件加载模型不同）。

---

## 9. 测试策略（原项目做法，建议保留）

1. **单测**（node:test + type-strip，154 个）：config 合并/校验、命令解析、授权矩阵、状态机、审批流、去重、预算、分块格式化、附件提取（含最小 PDF fixture）、下载器（mock DNS/重定向/超时）、STT（mock HTTP）、出站校验链、实例锁（pid 存活/stale/竞争）
2. **mock 平台 e2e**：test/mock-qq-server.ts 实现真实 WS 协议（Hello/Identify/心跳/事件推送），验证网关握手、重连、Resume、消息闭环、命令、多媒体
3. **真实沙箱清单**：docs/SANDBOX_TEST.md（token/连接/心跳/文本闭环已实测；工具/命令/多媒体/出站/群聊待测；分片上传字段"以上线实测为准"）
4. 移植后至少对齐 1-3；DSH 插件形态的加载冒烟测试另行设计

---

## 10. 附：源文件清单与规模（参考工作量）

| 文件 | 行数 | 宿主绑定 |
|---|---|---|
| src/router.ts | 1115 | 否 |
| src/session/qq-session.ts | 688 | **是（SDK 动态调用）** |
| src/index.ts | 678 | **是（pi.* API）** |
| src/media/attachment-downloader.ts | 584 | 否 |
| src/media/attachment-pipeline.ts | 542 | 弱（resizeImage） |
| src/media/outbound-media.ts | 449 | 弱（defineTool 入口） |
| src/gateway/qq-gateway.ts | 441 | 否 |
| src/reply-formatter.ts | 417 | 否 |
| src/core/config.ts | 284 | 否 |
| src/gateway/qq-api.ts | 262 | 否 |
| src/gateway/qq-auth.ts | 182 | 否 |
| src/session/conversation-registry.ts | 176 | 否（session 工厂注入） |
| src/commands/command-controller.ts | 176 | 否 |
| src/commands/access-requests.ts | 171 | 否 |
| src/media/attachment-extractors.ts | 151 | 否 |
| src/instance-guard.ts | 144 | 否 |
| src/session/workspace-registry.ts | 129 | 否 |
| src/commands/model-pages.ts | 111 | 否 |
| src/core/types.ts / user-facing.ts / error-codes.ts | 239 | 否 |
| src/session/message-dedupe.ts / reply-budget.ts | 91 | 否 |
| src/commands/command-parser.ts / qq-keyboard.ts | 161 | 否 |
| src/media/stt.ts | 97 | 否 |
| src/terminal-view.ts | 93 | 弱（setWidget） |
| **合计** | **~7500** | 宿主绑定集中在 index.ts + qq-session.ts（约 1400 行） |

**错误码枚举**：入站 16 个（invalid_url/ssrf_blocked/dns_failed/download_timeout/size_limit/mime_mismatch/parse_failed/pdf_no_text/page_limit/invalid_encoding/stt_not_configured/stt_key_missing/stt_failed/media_disabled/attachment_count_limit/aborted）；出站 7 个（outbound_disabled/outbound_not_authorized/path_outside_allowed_roots/file_too_large/reply_budget_exhausted/media_upload_failed/media_send_unknown）。

**参考文档**：README.md（用法/FAQ）、docs/SANDBOX_TEST.md（实测清单）、pi-qq-bridge.json.example（配置模板）。
