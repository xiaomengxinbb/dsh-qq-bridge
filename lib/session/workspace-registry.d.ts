export interface Workspace {
    name: string;
    path: string;
    description?: string;
}
export declare class WorkspaceError extends Error {
    constructor(message: string);
}
export declare class WorkspaceRegistry {
    private readonly workspaces;
    constructor(configured: Workspace[], agentCwd: string);
    list(): Workspace[];
    has(name: string): boolean;
    /** 解析 workspace 名 → 真实绝对路径（realpath；不存在/不是目录则报错） */
    resolve(name: string): {
        name: string;
        path: string;
    };
    /** 新增 workspace（管理员本地命令用；返回注册后的条目） */
    add(name: string, path: string, description?: string): Workspace;
    /** 移除 workspace（default 不可移除） */
    remove(name: string): void;
    private resolvePath;
}
/** 供测试/工具使用的导出 */
export declare function isValidWorkspaceName(name: string): boolean;
/** 供 index.ts 使用的存在性检查 */
export declare function directoryExists(path: string): boolean;
//# sourceMappingURL=workspace-registry.d.ts.map