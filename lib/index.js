/**
 * dsh-qq-bridge 入口（Phase 4：完整组装）
 *
 * 生命周期：apply(ctx) → 配置 → auto 抢锁连网关 → 建桥（registry+router）→ 命令注册。
 * 数据流：QQGateway.onInbound → QQRouter（去重→授权→命令/队列→隔离 DSH 会话→回复）。
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
/** 开发期启动诊断（QQBOT_DEBUG_START=1 时写 /tmp/qq-start-debug.log） */
function dbgStart(...args) {
    if (process.env.QQBOT_DEBUG_START !== "1")
        return;
    try {
        appendFileSync("/tmp/qq-start-debug.log", `${new Date().toISOString()} ${args.join(" ")}
`);
    }
    catch {
        // 忽略
    }
}
import { loadConfig, expandHome, DEFAULT_CONFIG_PATH, ConfigError, saveConfig, } from "./core/config.js";
import { QQAuth } from "./gateway/qq-auth.js";
import { QQGateway } from "./gateway/qq-gateway.js";
import { QQApi } from "./gateway/qq-api.js";
import { acquireInstanceLock, ensureLockDir, isLockHeldByMe, DEFAULT_LOCK_PATH, } from "./instance-guard.js";
import { ConversationRegistry } from "./session/conversation-registry.js";
import { QQAgentSession } from "./session/qq-session.js";
import { WorkspaceRegistry } from "./session/workspace-registry.js";
import { QQRouter } from "./router.js";
import { QQAccessRequestStore, normalizeAccessRole } from "./commands/access-requests.js";
import { AttachmentPipeline } from "./media/attachment-pipeline.js";
import { CommandStateMachine } from "./commands/command-controller.js";
import { TerminalView } from "./terminal-view.js";
/** Stable Cordis plugin name（profile 行 id 引用） */
export const name = "dsh-qq-bridge";
/** 依赖的核心服务（loader 解析顺序） */
export const inject = ["commands"];
const state = {};
function loadConfigOnce() {
    if (state.config)
        return state.config;
    try {
        // QQBOT_CONFIG_PATH：测试/集成环境覆盖（mock 平台、独立配置）
        const configPath = process.env.QQBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
        state.config = loadConfig(expandHome(configPath));
        state.configError = undefined;
    }
    catch (err) {
        state.configError =
            err instanceof ConfigError ? err.message : `配置加载失败：${err.message}`;
        state.config = undefined;
    }
    return state.config;
}
function debugLogFor(cfg) {
    if (!cfg.debug)
        return undefined;
    return (message) => {
        try {
            appendFileSync("/tmp/dsh-qq-bridge-gw.log", `${new Date().toISOString()} ${message}\n`);
        }
        catch {
            // 日志失败不影响功能
        }
    };
}
/** 路由事件 → 日志（DSH 无 TUI widget，退化日志观察） */
function logRouterEvent(event) {
    const logger = state.logger;
    switch (event.kind) {
        case "queued":
            logger?.debug?.(`[dsh-qq-bridge] 入队 ${event.messageId.slice(0, 12)}（队列 ${event.queueSize}）`);
            break;
        case "run_start":
            logger?.info?.(`[dsh-qq-bridge] 开始处理 ${event.messageId.slice(0, 12)}`);
            break;
        case "run_end":
            logger?.info?.(`[dsh-qq-bridge] ${event.ok ? "处理完成" : "处理失败"} ${event.messageId.slice(0, 12)}`);
            break;
        case "reply":
            logger?.debug?.(`[dsh-qq-bridge] 回复(${event.msgSeq}) ${event.content.slice(0, 40)}`);
            break;
        case "access_request":
            logger?.warn?.(`[dsh-qq-bridge] 访问申请：${event.userOpenId.slice(0, 16)} 码 ${event.code}`);
            break;
        case "command":
            logger?.info?.(`[dsh-qq-bridge] 命令 /${event.name}`);
            break;
        case "error":
            logger?.warn?.(`[dsh-qq-bridge] 错误(${event.stage})：${event.message.slice(0, 100)}`);
            break;
    }
}
/** 组装完整桥接运行时（auth + gateway + api + registry + router） */
function createBridge(cfg, ctx) {
    const logger = state.logger;
    // QQBOT_API_BASE / QQBOT_TOKEN_URL：测试/集成环境覆盖（mock 平台）
    const apiBase = process.env.QQBOT_API_BASE;
    const tokenUrl = process.env.QQBOT_TOKEN_URL;
    const auth = new QQAuth(cfg.appId, cfg.clientSecret, tokenUrl ? { tokenUrl } : {});
    // gateway 重连配置：0 = 无限重连（避免自动重连 5 次耗尽后 bot 永久失联）
    const gwOptions = {
        sandbox: cfg.sandbox,
        debugLog: debugLogFor(cfg),
    };
    if (apiBase)
        gwOptions.apiBase = apiBase;
    if (cfg.gateway) {
        // 0 = 无限重连;显式传入(含 0),让 QQGateway 的默认 5 被覆盖
        if (Number.isFinite(cfg.gateway.maxReconnectAttempts))
            gwOptions.maxReconnectAttempts = cfg.gateway.maxReconnectAttempts;
        if (cfg.gateway.reconnectBaseMs > 0)
            gwOptions.reconnectBaseMs = cfg.gateway.reconnectBaseMs;
        if (cfg.gateway.reconnectMaxMs > 0)
            gwOptions.reconnectMaxMs = cfg.gateway.reconnectMaxMs;
    }
    const gateway = new QQGateway(auth, gwOptions);
    const api = new QQApi(auth, { sandbox: cfg.sandbox, ...(apiBase ? { apiBase } : {}) });
    const agentDir = expandHome("~/.dsh/qq-bridge");
    // 默认工作区:优先用配置里的非 home 工作区(避免 C:/Users/ampct 包含 Temp 导致
    // windows-acl 沙箱报 "temp root must be outside the workspace")
    const wsConfig = cfg.workspaces.find((w) => w.name !== "default" && w.path && !w.path.toLowerCase().startsWith("c:/users/"));
    const cwd = wsConfig?.path || process.cwd();
    const host = {
        ctx: ctx,
        // Phase 5：注册 qq_send_local_file 等 QQ 专属工具（agent 作用域）
        setupAgent: (agentCtx) => {
            logger?.debug?.("[dsh-qq-bridge] setupAgent（Phase 5 挂工具）");
            void agentCtx;
        },
    };
    const workspaceRegistry = new WorkspaceRegistry(cfg.workspaces, cwd);
    const registry = new ConversationRegistry(cfg, agentDir, cwd, { create: () => new QQAgentSession(host) }, { name: "default", path: cwd });
    const accessRequests = new QQAccessRequestStore();
    const attachmentPipeline = new AttachmentPipeline(cfg, `${process.pid}-${Date.now()}`);
    // viewHolder：无 TUI widget，终端视图退化为 noop（保留结构便于未来 client bundle 接入）
    const viewHolder = {
        current: new TerminalView({
            setWidget: () => undefined,
        }),
    };
    const router = new QQRouter(cfg, registry, api, {
        accessRequests,
        attachmentPipeline,
        workspaceRegistry,
        stateMachine: new CommandStateMachine(cfg.commands),
        statusProvider: () => {
            const { state: gwState, info } = gateway.getState();
            return `**${gwState}**${info ? `（${info}）` : ""}`;
        },
        onEvent: logRouterEvent,
        debugLog: debugLogFor(cfg),
    });
    gateway.onInbound((msg) => router.handleInbound(msg));
    const rt = {
        auth,
        gateway,
        api,
        registry,
        router,
        workspaceRegistry,
        accessRequests,
        viewHolder,
        lock: null,
        lockCheckTimer: undefined,
        startedAt: Date.now(),
    };
    // 锁归属校验：锁不在本进程 → 主动断开网关（防双连接）
    rt.lockCheckTimer = setInterval(() => {
        if (rt.lock && !isLockHeldByMe(rt.lock.path)) {
            void rt.gateway.stop();
        }
    }, 30_000);
    rt.lockCheckTimer.unref?.();
    return rt;
}
/** 抢锁 + 建桥 + 连接（auto 模式与 /qqbot-start 共用） */
async function startBridge(cfg, ctx) {
    dbgStart("startBridge begin, enabled=", cfg.enabled, "mode=", cfg.startup.mode, "apiBase=", process.env.QQBOT_API_BASE ?? "(default)");
    const currentState = state.runtime?.gateway.getState().state;
    // 注意：?. 在 runtime 未定义时短路为 undefined，必须显式判 undefined，否则恒判"已在运行"
    if (currentState !== undefined && currentState !== "disconnected") {
        return "QQ 网关已在运行（/qqbot-status 查看）";
    }
    const lockPath = expandHome(DEFAULT_LOCK_PATH);
    ensureLockDir(lockPath);
    const acquired = acquireInstanceLock(lockPath);
    if (!acquired.held)
        return `无法启动：${acquired.reason}`;
    dbgStart("lock acquired at", lockPath);
    const rt = createBridge(cfg, ctx);
    rt.lock = acquired.lock;
    state.runtime = rt;
    dbgStart("gateway.start() calling...");
    const ok = await rt.gateway.start();
    dbgStart("gateway.start() done ok=", ok);
    if (!ok && rt.lock) {
        try {
            rmSync(rt.lock.path, { force: true });
        }
        catch {
            // 陈旧锁下次启动会被 stale 检测回收
        }
        state.runtime = undefined;
    }
    state.logger?.info?.(`[dsh-qq-bridge] 网关 ${ok ? "已连接" : "连接失败"}：${rt.gateway.getState().info}`);
    return ok ? "QQ 网关已连接" : `QQ 网关连接失败：${rt.gateway.getState().info}`;
}
/** 审批落地：原子更新配置 + 热生效（router/registry 持有同一 config 引用） */
function applyApproval(cfg, userOpenId, role) {
    const updated = {
        ...cfg,
        allowUsers: [...cfg.allowUsers],
        commands: { ...cfg.commands, admins: [...cfg.commands.admins] },
    };
    if (!updated.allowUsers.includes(userOpenId))
        updated.allowUsers.push(userOpenId);
    if (role === "admin" && !updated.commands.admins.includes(userOpenId)) {
        updated.commands.admins.push(userOpenId);
    }
    saveConfig(expandHome(DEFAULT_CONFIG_PATH), updated);
    cfg.allowUsers = updated.allowUsers;
    cfg.commands.admins = updated.commands.admins;
}
/**
 * 插件主体。
 * @param ctx - cordis 上下文（agents/sessions/sessionPersistence/commands/llm...）
 */
export function apply(ctx, _config) {
    const logger = ctx.logger ?? console;
    state.logger = logger;
    writeBootMarker(logger);
    const cfg = loadConfigOnce();
    if (!cfg) {
        logger.warn?.(`[dsh-qq-bridge] 配置不可用：${state.configError}`);
    }
    else {
        logger.info?.(`[dsh-qq-bridge] 配置已装载（schemaVersion ${cfg.schemaVersion}，sandbox=${cfg.sandbox}，mode=${cfg.startup.mode}）`);
    }
    // ── 本地管理命令 ──────────────────────────────────────────────
    ctx.commands.register({
        name: "qqbot-start",
        description: "dsh-qq-bridge：启动 QQ 网关（抢单实例锁 + 连接沙箱/正式环境）",
        handler: async () => {
            const cfgNow = loadConfigOnce();
            if (!cfgNow)
                return { kind: "error", text: `配置不可用：${state.configError ?? "未加载"}` };
            return { kind: "success", text: await startBridge(cfgNow, ctx) };
        },
    });
    ctx.commands.register({
        name: "qqbot-stop",
        description: "dsh-qq-bridge：停止 QQ 网关（保留配置与锁释放）",
        handler: async () => {
            const rt = state.runtime;
            if (!rt)
                return { kind: "success", text: "QQ 网关未运行" };
            await rt.gateway.stop();
            await rt.registry.dispose();
            if (rt.lock) {
                try {
                    rmSync(rt.lock.path, { force: true });
                }
                catch {
                    // 陈旧锁下次启动会被 stale 检测回收
                }
            }
            if (rt.lockCheckTimer)
                clearInterval(rt.lockCheckTimer);
            state.runtime = undefined;
            return { kind: "success", text: "QQ 网关已停止" };
        },
    });
    ctx.commands.register({
        name: "qqbot-reconnect",
        description: "dsh-qq-bridge：强制重连 QQ 网关（自动重连停止后使用）",
        handler: async () => {
            const rt = state.runtime;
            if (!rt)
                return { kind: "error", text: "QQ 网关未运行（先 /qqbot-start）" };
            const ok = await rt.gateway.reconnect();
            return {
                kind: ok ? "success" : "error",
                text: ok ? "QQ 网关已重连" : `重连失败：${rt.gateway.getState().info}`,
            };
        },
    });
    ctx.commands.register({
        name: "qqbot-status",
        description: "dsh-qq-bridge：查看网关/会话/队列/配置状态",
        handler: async () => {
            const cfgNow = loadConfigOnce();
            const rt = state.runtime;
            const { state: gwState, info } = rt?.gateway.getState() ?? { state: "disconnected", info: "未启动" };
            const lines = [
                "## dsh-qq-bridge 状态",
                `- 网关：**${gwState}**${info ? `（${info}）` : ""}`,
                cfgNow
                    ? `- 配置：schemaVersion ${cfgNow.schemaVersion}，sandbox=${cfgNow.sandbox}`
                    : `- 配置：不可用（${state.configError ?? "未加载"}）`,
                `- 会话：${rt ? `${rt.registry.residentCount} 驻留，队列 ${rt.router.queueSize}${rt.router.isRunning() ? "，运行中" : ""}` : "未启动"}`,
                rt?.lock ? `- 锁：${rt.lock.path}（pid ${rt.lock.pid}）` : "- 锁：未持有",
            ];
            return { kind: "success", text: lines.join("\n") };
        },
    });
    ctx.commands.register({
        name: "qqbot-requests",
        description: "dsh-qq-bridge：列出待审批的 QQ 访问申请",
        handler: async () => {
            const rt = state.runtime;
            if (!rt)
                return { kind: "error", text: "QQ 网关未运行（先 /qqbot-start）" };
            const requests = rt.accessRequests.list();
            if (!requests.length)
                return { kind: "success", text: "没有待审批的访问申请" };
            const lines = [
                "## 待审批访问申请",
                "",
                ...requests.map((r) => `- \`${r.code}\` 用户 ${r.userOpenId}（${new Date(r.createdAt).toLocaleTimeString()} 提交）`),
                "",
                "执行 /qqbot-approve <码> <user|admin> 或 /qqbot-deny <码>",
            ];
            return { kind: "success", text: lines.join("\n") };
        },
    });
    ctx.commands.register({
        name: "qqbot-approve",
        description: "dsh-qq-bridge：批准访问申请：/qqbot-approve <码> <user|admin> [--yes]",
        handler: async (_invocation) => {
            const rt = state.runtime;
            const cfgNow = loadConfigOnce();
            if (!rt || !cfgNow)
                return { kind: "error", text: "QQ 网关未运行或配置不可用" };
            const raw = _invocation.rawInput ?? "";
            const tokens = raw.trim().split(/\s+/).filter(Boolean);
            const code = tokens[0];
            const roleArg = tokens[1];
            const force = tokens.includes("--yes");
            const role = normalizeAccessRole(roleArg);
            if (!code || !role) {
                return { kind: "error", text: "用法：/qqbot-approve <申请码> <user|admin> [--yes]" };
            }
            const request = rt.accessRequests.approve(code);
            if (!request)
                return { kind: "error", text: `申请码 ${code} 不存在或已过期` };
            if (role === "admin" && !force) {
                // 二次确认：--yes 显式确认（DSH 无 ui.confirm）
                return {
                    kind: "success",
                    text: `将授予 ${request.userOpenId} 管理员权限。确认请重新执行：/qqbot-approve ${code} admin --yes`,
                };
            }
            applyApproval(cfgNow, request.userOpenId, role);
            // QQ 通知（被动回复引用原消息，60min 窗口内有效）
            try {
                await rt.api.sendText({ type: "private", userOpenId: request.userOpenId, msgId: request.message.id }, `已批准你的访问申请（${role}）。现在可以开始使用了。`, 1);
            }
            catch {
                // 通知失败（如窗口过期）不影响授权生效
            }
            return { kind: "success", text: `已批准 ${request.userOpenId}（${role}）` };
        },
    });
    ctx.commands.register({
        name: "qqbot-deny",
        description: "dsh-qq-bridge：拒绝访问申请：/qqbot-deny <码>",
        handler: async (_invocation) => {
            const rt = state.runtime;
            if (!rt)
                return { kind: "error", text: "QQ 网关未运行（先 /qqbot-start）" };
            const raw = _invocation.rawInput ?? "";
            const code = raw.trim().split(/\s+/)[0];
            if (!code)
                return { kind: "error", text: "用法：/qqbot-deny <申请码>" };
            const request = rt.accessRequests.deny(code);
            if (!request)
                return { kind: "error", text: `申请码 ${code} 不存在或已过期` };
            return { kind: "success", text: `已拒绝 ${request.userOpenId}（1 小时内不再接收其申请）` };
        },
    });
    ctx.commands.register({
        name: "qqbot-revoke",
        description: "dsh-qq-bridge：撤销用户权限：/qqbot-revoke <user_openid> [--yes]",
        handler: async (_invocation) => {
            const cfgNow = loadConfigOnce();
            if (!cfgNow)
                return { kind: "error", text: "配置不可用" };
            const raw = _invocation.rawInput ?? "";
            const tokens = raw.trim().split(/\s+/).filter(Boolean);
            const openid = tokens[0];
            const force = tokens.includes("--yes");
            if (!openid)
                return { kind: "error", text: "用法：/qqbot-revoke <user_openid> [--yes]" };
            if (!force) {
                return {
                    kind: "success",
                    text: `将撤销 ${openid} 的全部权限（普通用户 + 管理员）。确认请重新执行：/qqbot-revoke ${openid} --yes`,
                };
            }
            const updated = {
                ...cfgNow,
                allowUsers: cfgNow.allowUsers.filter((id) => id !== openid),
                commands: { ...cfgNow.commands, admins: cfgNow.commands.admins.filter((id) => id !== openid) },
            };
            saveConfig(expandHome(DEFAULT_CONFIG_PATH), updated);
            cfgNow.allowUsers = updated.allowUsers;
            cfgNow.commands.admins = updated.commands.admins;
            return { kind: "success", text: `已撤销 ${openid} 的权限` };
        },
    });
    ctx.commands.register({
        name: "workspace",
        description: "dsh-qq-bridge：查看/切换工作区：/workspace [名称] | add <名称> <路径> | remove <名称>",
        handler: async (_invocation) => {
            const rt = state.runtime;
            const cfgNow = loadConfigOnce();
            if (!rt || !cfgNow)
                return { kind: "error", text: "QQ 网关未运行或配置不可用（先 /qqbot-start）" };
            const raw = _invocation.rawInput ?? "";
            const tokens = raw.trim().split(/\s+/).filter(Boolean);
            const registry = rt.workspaceRegistry;
            if (tokens.length === 0) {
                const current = rt.registry.currentWorkspace;
                const lines = [
                    "## 工作区",
                    "",
                    `当前：**${current.name}**（${current.path}）`,
                    "",
                    ...registry.list().map((w) => `- \`${w.name}\`  ${w.path}`),
                    "",
                    "切换：/workspace <名称>；管理：/workspace add <名称> <绝对路径> | remove <名称>",
                ];
                return { kind: "success", text: lines.join("\n") };
            }
            if (tokens[0] === "add") {
                const [wName, wPath, ...rest] = tokens.slice(1);
                if (!wName || !wPath)
                    return { kind: "error", text: "用法：/workspace add <名称> <绝对路径> [描述]" };
                try {
                    const workspace = registry.add(wName, wPath, rest.join(" "));
                    cfgNow.workspaces = registry.list().filter((w) => w.name !== "default");
                    saveConfig(expandHome(DEFAULT_CONFIG_PATH), cfgNow);
                    return { kind: "success", text: `已添加工作区 ${workspace.name} → ${workspace.path}` };
                }
                catch (err) {
                    return { kind: "error", text: `${err.message}` };
                }
            }
            if (tokens[0] === "remove") {
                const wName = tokens[1];
                if (!wName)
                    return { kind: "error", text: "用法：/workspace remove <名称>" };
                try {
                    registry.remove(wName);
                    cfgNow.workspaces = registry.list().filter((w) => w.name !== "default");
                    saveConfig(expandHome(DEFAULT_CONFIG_PATH), cfgNow);
                    return { kind: "success", text: `已移除工作区 ${wName}` };
                }
                catch (err) {
                    return { kind: "error", text: `${err.message}` };
                }
            }
            try {
                const resolved = registry.resolve(tokens[0]);
                if (rt.registry.currentWorkspace.name === resolved.name) {
                    return { kind: "success", text: `已在工作区 ${resolved.name}（${resolved.path}）` };
                }
                await rt.registry.setWorkspace(resolved.name, resolved.path);
                return { kind: "success", text: `已切换工作区：${resolved.name}（${resolved.path}）` };
            }
            catch (err) {
                return { kind: "error", text: `${err.message}` };
            }
        },
    });
    // ── auto 模式：装载即启动 ─────────────────────────────────────
    dbgStart("apply done, cfg=", !!cfg, "auto=", cfg?.startup.mode === "auto");
    if (cfg?.enabled && cfg.startup.mode === "auto") {
        void startBridge(cfg, ctx).then((message) => {
            logger.info?.(`[dsh-qq-bridge] auto 启动：${message}`);
            dbgStart("auto-start result:", message);
        });
    }
    // ── 开发期自测（发布前移除）────────────────────────────────────
    if (process.env.DSH_QQBRIDGE_SELFTEST === "1") {
        void import("./dev/self-test.js").then(({ runSelfTest }) => runSelfTest(ctx));
    }
}
/** 开发期冒烟标记：仅 DSH_QQBRIDGE_BOOT_MARKER=1 时写入（默认关闭） */
function writeBootMarker(logger) {
    if (process.env.DSH_QQBRIDGE_BOOT_MARKER !== "1")
        return;
    try {
        mkdirSync(process.cwd(), { recursive: true });
        writeFileSync(process.cwd() + "/.boot-marker", JSON.stringify({ applied: true, at: Date.now(), pid: process.pid }, null, 2));
    }
    catch (err) {
        logger.warn?.(`[dsh-qq-bridge] boot marker 写入失败：${String(err)}`);
    }
}
//# sourceMappingURL=index.js.map