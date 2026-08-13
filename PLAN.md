# dsh-qq-bridge 移植计划

**目标**：在 ~/dsh-qq-bridge 从零搭建 DSH 插件 dsh-qq-bridge，把 pi-qq-bridge 的 QQ 网关、路由、会话、命令、多媒体能力搬到 DeepSeek Harness。

## 阶段划分（每阶段验收后再进下一阶段）

| Phase | 内容 | 预估 | 验收标准 |
|---|---|---|---|
| 0 | 宿主 API 调研（8 个开放问题 + hello 插件在 dev profile 跑通） | 0.5-1 天 | HOST-API.md 完成；hello 插件可加载 |
| 1 | 骨架 + 配置（cordis 入口/tsconfig/config 移植） | 0.5 天 | typecheck 过；插件加载不报错 |
| 2 | 网关移植（auth/gateway/api/dedupe/budget/instance-guard 原样复用） | 1 天 | mock QQ 平台测试全绿 |
| 3 | 隔离会话适配（每 QQ 对话 ↔ 持久 DSH 会话；风险最高） | 2 天 | 双对话隔离 + 重启恢复 |
| 4 | 路由 + 命令（router/parser/授权/状态机/审批/本地命令） | 1 天 | 路由测试全绿；QQ 侧命令跑通 |
| 5 | 多媒体（下载/提取/STT/resize 等价 + 出站工具注册） | 1.5 天 | 附件管线测试全绿 |
| 6 | 集成 + 真实沙箱实测（dev profile → web profile） | 1 天 | 沙箱文本闭环 |

## 开发方式约定
1. 全程在 qqbotdsh 开发 + node:test 单测，不碰运行中的 GUI（3080）
2. 独立 dev profile 做集成冒烟；最后才考虑装进 web profile（需用户确认重启）
3. 每阶段结束向用户汇报产出

## 关键决策
- 70%+ 模块宿主无关原样复用（SPEC §8.3 清单）
- 宿主绑定集中在 index.ts（pi.* API）和 qq-session.ts（SDK 调用）→ 适配层隔离（src/host/）
- 8 个开放问题见 SPEC §8.4，Phase 0 必须全部回答
