/**
 * WebSocket 网关（spec §6.2）
 *
 * 状态机：disconnected → connecting → connected → error / closed
 * - GET {base}/gateway 取 wss url（Authorization: QQBot {token}）
 * - op10 Hello → op2 Identify {token, intents: 1<<25, shard:[0,1]} → READY
 * - 每 heartbeat_interval 发 op1（d=last seq）；op11 Heartbeat ACK
 * - 断线：指数退避 1s→30s，最多 5 次后停止（/qqbot-reconnect 手动重试）
 * - 重连：op6 Resume {token, session_id, seq} 补发遗漏事件；非 4009 错误走 Identify
 * - 依赖 Node 内置 WebSocket（Node >=22.19），零运行时依赖
 */
import type { QQGatewayState, QQGatewayStateListener, QQInboundListener, QQInteraction } from "../core/types.ts";
import type { QQAuth } from "./qq-auth.ts";
export declare const QQ_INTENTS: number;
export interface QQGatewayOptions {
    sandbox: boolean;
    /** 调试日志回调（写文件等；诊断连接问题用） */
    debugLog?: (message: string) => void;
    /** API 基础域名（测试/代理覆盖） */
    apiBase?: string;
    /** 重连最大次数，默认 5 */
    maxReconnectAttempts?: number;
    /** 重连退避基数 ms，默认 1000 */
    reconnectBaseMs?: number;
    /** 重连退避上限 ms，默认 30000 */
    reconnectMaxMs?: number;
}
export declare class QQGateway {
    private ws;
    private state;
    private stateInfo;
    private heartbeatTimer;
    private heartbeatAckPending;
    private lastHeartbeatAt;
    private readonly heartbeatAckTimeoutMs;
    private sessionId;
    private lastSeq;
    private reconnectAttempts;
    private reconnectTimer;
    private stopped;
    private readonly stateListeners;
    private readonly inboundListeners;
    private readonly apiBase;
    private readonly maxReconnectAttempts;
    private readonly reconnectBaseMs;
    private readonly reconnectMaxMs;
    private readonly auth;
    private readonly debugLog?;
    constructor(auth: QQAuth, options: QQGatewayOptions);
    getState(): {
        state: QQGatewayState;
        info: string;
    };
    onStateChange(listener: QQGatewayStateListener): () => void;
    onInbound(listener: QQInboundListener): () => void;
    /** 启动网关（幂等：已 connected 直接返回 true） */
    start(): Promise<boolean>;
    /** 手动重连（自动重连停止后使用） */
    reconnect(): Promise<boolean>;
    /** 停止网关（关闭 socket、清理定时器、不再自动重连） */
    stop(): Promise<void>;
    private setState;
    private closeSocket;
    private connect;
    private lastConnectAt;
    private quickDisconnectCount;
    private openSocket;
    private handleFrame;
    private dispatchEvent;
    /** 交互监听器:收到按钮点击时回调(仿 Hermes set_interaction_callback) */
    private interactionListeners;
    onInteraction(listener: (interaction: QQInteraction) => void): () => void;
    private dispatchInteraction;
    private startHeartbeat;
    private clearHeartbeat;
    private scheduleReconnect;
}
//# sourceMappingURL=qq-gateway.d.ts.map