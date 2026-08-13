# 真实沙箱实测清单（dsh-qq-bridge 版）

> 目标：验证 dsh-qq-bridge 与 QQ 官方沙箱环境的真实连通性。
> 前置：已拿到 QQ 开放平台 AppID/AppSecret；测试 QQ 号已加入沙箱白名单。
> 对照 pi-qq-bridge docs/SANDBOX_TEST.md（本清单为其 DSH 移植版）。

## 实测记录（2026-08-14）

- ✅ 1.1/1.2/1.3：token 获取 + 沙箱 WS 连接 + 心跳（已实测）
- ✅ 2.1-2.4：私聊文本闭环 + 首访审批 + 授权后完整回复（已实测，openid 已入 allowUsers）
- ✅ 会话持久化：重启后自动恢复（隔离 DSH 会话）
- ⛔ **6 群聊：个人开发者无法沙箱实测**——QQ 开放平台沙箱的群聊白名单仅对企业/认证主体开放，
  个人开发者账号无法添加测试群（平台限制）。代码支持已就绪（GROUP_AT 意图 + allowGroups），
  待正式环境（提审上线）验证，步骤见 README「群聊支持状态」。

## 0. 前置（一次性）

1. 配置就绪（占位符已存在）：

```bash
nano ~/.dsh/qq-bridge/config.json   # 填入 appId / clientSecret，sandbox 保持 true
chmod 600 ~/.dsh/qq-bridge/config.json
```

2. 插件挂载到 web profile（会重启 3080 服务器，先确认没有进行中的任务）：

```bash
dsh plugin --profile web add ~/dsh-qq-bridge          # 安装到共享 node_modules
cp ~/dsh-qq-bridge/web-overlay.yml /tmp/web-overlay.yml
# 编辑 ~/.dsh/profiles/web/cordis.patch.yml 追加：
#   - insert:
#       - id: dsh-qq-bridge
#         name: 'dsh-qq-bridge'
# 重启 dsh web
```

3. 重启后验证：Web 聊天里发 `/qqbot-status` → 应显示配置已装载。

## 1. 启动与连接（5 分钟）

| # | 操作 | 预期 |
|---|---|---|
| 1.1 | Web 里发 `/qqbot-start` | 返回 "QQ 网关已连接"（或显示错误原因） |
| 1.2 | `/qqbot-status` | 网关 **connected**，配置 schemaVersion 4，锁已持有 |
| 1.3 | 等 2 分钟再看 | 仍 connected（心跳正常） |

风险点：token 端点（bots.qq.com）与 WS 网关（sandbox.api.sgroup.qq.com）连通性。

## 2. 文本私聊闭环（10 分钟）

| # | 操作 | 预期 |
|---|---|---|
| 2.1 | 测试 QQ 发"你好" | QQ 收到回复（首次为审批码流程） |
| 2.2 | 发"查看当前目录文件" | agent 执行 ls 类工具并回复（隔离 DSH 会话生效） |
| 2.3 | 发 `/status` | 返回会话/模型/队列/网关状态 |
| 2.4 | 首次授权：allowUsers 空 → 发消息 → Web 里 `/qqbot-requests` 看到申请 → `/qqbot-approve <码> user` | 回复"已批准"，再发消息正常处理 |

## 3. 会话持久化验证（关键，Phase 3 核心）

| # | 操作 | 预期 |
|---|---|---|
| 3.1 | 对话几轮后 `/new 测试` | 新会话提示；旧会话保留 |
| 3.2 | `/sessions` | 列出本对话历史会话（含名称） |
| 3.3 | `/resume <短ID>` | 恢复旧会话，能继续上下文 |
| 3.4 | 重启 dsh web 后再发消息 | 自动恢复最近会话（restore=recent） |
| 3.5 | 检查持久化目录 | `~/.dsh/sessions/--<cwd>--/qq-<hash>-<seq>/session.jsonl.zstd` |

## 4. 命令与权限（5 分钟）

| # | 操作 | 预期 |
|---|---|---|
| 4.1 | `/help` | 命令菜单 |
| 4.2 | `/model` | 模型列表（llm.listProviders + listModels） |
| 4.3 | `/thinking high` | 思考等级切换 |
| 4.4 | 未加入 admins 发 `/new` | 权限拒绝（预期） |

## 5. 多媒体（10 分钟，可选）

| # | 操作 | 预期 |
|---|---|---|
| 5.1 | 发图片 | 视觉模型描述（经 dsh-attachment saveImage） |
| 5.2 | 发语音 | QQ ASR 文本回复 |
| 5.3 | 发 .txt/.pdf | 内容摘要 |

## 6. 出站媒体（5 分钟，可选）

| # | 操作 | 预期 |
|---|---|---|
| 6.1 | 配置 outboundMedia.enabled=true + allowedRoots | — |
| 6.2 | QQ 发"把 /tmp/test.png 发给我" | 收到图片（qq_send_local_file 工具） |
| 6.3 | 大文件（>5MB） | 分片上传（字段以上线实测为准） |

## 7. 群聊（5 分钟，可选）

| # | 操作 | 预期 |
|---|---|---|
| 7.1 | 群里 @机器人 | 回复（allowGroups 加入群 openid 后） |

## 收尾

- 全部通过 → 沙箱切换正式环境（sandbox: false，需开放平台提审）
- 任一失败 → 记录：操作 + 现象 + /qqbot-status 输出 + /tmp/dsh-qq-bridge-gw.log（cfg.debug=true 时）

## 已知"以上线实测为准"的代码点（与 pi 版一致）

- qq-api uploadMediaChunked：分片协议字段名
- qq-gateway：Resume/op9 错误码行为（4009 等）
- router isMarkdownRejected：Markdown 被拒的错误特征
