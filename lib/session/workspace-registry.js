/**
 * Workspace 注册表（spec §6.6，M5 核心新增）
 *
 * - workspaces 来自配置：{ name, path, description? }；path 空 = 宿主 agentCwd
 * - 校验：path 必须存在且为目录（realpath 解析）；禁止相对路径；name 安全字符 [a-zA-Z0-9_-]
 * - "default" 始终存在（= agentCwd）
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
export class WorkspaceError extends Error {
    constructor(message) {
        super(message);
        this.name = "WorkspaceError";
    }
}
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
export class WorkspaceRegistry {
    workspaces = new Map();
    constructor(configured, agentCwd) {
        // default 恒存在（path 空 = agentCwd）
        this.workspaces.set("default", { name: "default", path: agentCwd });
        for (const workspace of configured) {
            if (!workspace || typeof workspace.name !== "string")
                continue;
            if (!NAME_PATTERN.test(workspace.name)) {
                throw new WorkspaceError(`workspace 名称非法（仅允许字母数字_-，1-32 字符）："${workspace.name}"`);
            }
            this.workspaces.set(workspace.name, {
                name: workspace.name,
                path: workspace.path || agentCwd,
                ...(workspace.description
                    ? { description: workspace.description }
                    : {}),
            });
        }
        // 启动即校验全部 path（配置错误尽早暴露）
        for (const workspace of this.workspaces.values()) {
            this.resolvePath(workspace.path);
        }
    }
    list() {
        return [...this.workspaces.values()];
    }
    has(name) {
        return this.workspaces.has(name);
    }
    /** 解析 workspace 名 → 真实绝对路径（realpath；不存在/不是目录则报错） */
    resolve(name) {
        const workspace = this.workspaces.get(name);
        if (!workspace) {
            throw new WorkspaceError(`工作区 "${name}" 不存在。可用：${[...this.workspaces.keys()].join("、")}`);
        }
        return { name: workspace.name, path: this.resolvePath(workspace.path) };
    }
    /** 新增 workspace（管理员本地命令用；返回注册后的条目） */
    add(name, path, description) {
        if (!NAME_PATTERN.test(name)) {
            throw new WorkspaceError("workspace 名称仅允许字母数字_-（1-32 字符）");
        }
        if (this.workspaces.has(name))
            throw new WorkspaceError(`工作区 "${name}" 已存在`);
        const real = this.resolvePath(path);
        const workspace = {
            name,
            path: real,
            ...(description ? { description } : {}),
        };
        this.workspaces.set(name, workspace);
        return workspace;
    }
    /** 移除 workspace（default 不可移除） */
    remove(name) {
        if (name === "default")
            throw new WorkspaceError("default 工作区不可移除");
        if (!this.workspaces.delete(name))
            throw new WorkspaceError(`工作区 "${name}" 不存在`);
    }
    resolvePath(path) {
        if (!isAbsolute(path))
            throw new WorkspaceError(`workspace 路径必须是绝对路径：${path}`);
        let real;
        try {
            real = realpathSync(path);
        }
        catch {
            throw new WorkspaceError(`workspace 路径不存在或不可访问：${path}`);
        }
        try {
            if (!statSync(real).isDirectory()) {
                throw new WorkspaceError(`workspace 路径不是目录：${path}`);
            }
        }
        catch (err) {
            if (err instanceof WorkspaceError)
                throw err;
            throw new WorkspaceError(`workspace 路径不可访问：${path}`);
        }
        return real;
    }
}
/** 供测试/工具使用的导出 */
export function isValidWorkspaceName(name) {
    return NAME_PATTERN.test(name);
}
/** 供 index.ts 使用的存在性检查 */
export function directoryExists(path) {
    try {
        return existsSync(path) && statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=workspace-registry.js.map