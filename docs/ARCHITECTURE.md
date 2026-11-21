# Slipgate 架构设计说明

Slipgate 是基于 [Linksyncx](../Linksyncx) 功能全景重构的新一代 AI API 统一网关，采用 **Go + Zig + Bun (TypeScript) + Vue 3** 四层双平面架构，并支持单服务一键启动。

## 1. 双平面与四层边界

- **DataPlane（热路径）**：`Client -> slipgate-net (Go) <-> slipgate-core (Zig) <-> slipgate-net (Clash/uTLS) -> Upstream`
  - `/v1/*`、`/v1beta/*`、`/mcp/*` 请求**严禁经过 TypeScript 中间件**。
  - Go 与 Zig 通过定长 10 字节帧头的多路复用二进制 IPC 协议通信（Linux 默认 UDS，Windows/开发模式使用 `127.0.0.1:19081`）。
- **ControlPlane（管理与商业路径）**：`Browser / PayHook -> slipgate-net (Go) -> slipgate-bff (Bun TS)`
  - `/api/*`、`/webhooks/*`、`/oauth/*` 由 `slipgate-net` 反向代理至 `slipgate-bff`。
  - 静态页面 `/` 由 `slipgate-net` 内嵌 `apps/web-vue` 编译产物直接服务。

## 2. 单服务 Supervisor 启动模型

`slipgate`（Go 主进程）集成了内置进程监管器 `internal/supervisor`：
1. 顺序拉起 `slipgate-core`（Zig 数据面引擎）和 `slipgate-bff`（Bun 编译产物或脚本进程）；
2. 聚合子进程 `[core]` / `[bff]` 日志流至统一标准输出；
3. `/readyz` 同时探活 Zig IPC（`FramePing -> FramePong`）与 Bun BFF（`GET /api/v1/health`）；
4. 收到 `SIGINT` / `SIGTERM` 后先优雅排空边缘 HTTP 请求，再逆序停止子进程。

## 3. Clash 独立出口池与 Fail-Closed 守卫

- 默认 `SLIPGATE_MAX_ACCOUNTS_PER_EXIT_IP=1`：多个上游账号不得共享同一个外部落地 IP（`shadow` 影子跟随账号除外）。
- **Fail-Closed**：`clashpool.Manager.ResolveDialTarget` 在节点缺失、禁用、连续探测失败熔断或出口 IP 漂移未确认时立即返回 `ErrExitCircuitOpen`，**绝不退化为宿主机直连**。
- **订阅骤降保护**：订阅节点归零或降幅超过 `50%` 时自动跳过本次同步，防止异常订阅导致全网账号掉线。

## 4. 数据库单写者隔离（PostgreSQL Schemas）

| Schema | 唯一写者 | 核心表 |
| :--- | :--- | :--- |
| `core.*` | `slipgate-core` (Zig) | `groups`, `accounts`, `composite_routes`, `api_keys`, `quota_wallets`, `ledger_entries`, `usage_logs` |
| `net.*` | `slipgate-net` (Go) | `clash_subscriptions`, `clash_nodes`, `tls_profiles`, `proxy_bindings`, `node_traffic_daily` |
| `commerce.*` | `slipgate-bff` (Bun TS) | `users`, `auth_identities`, `passkeys`, `payment_orders`, `outbox_events`, `subscriptions`, `redeem_codes` |

所有金额均采用 `i128` 定点纳美元（`1 USD = 1,000,000,000 nano-USD`），PostgreSQL 中以 `NUMERIC(39, 0)` 存储。
