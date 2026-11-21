# Slipgate 架构设计说明

Slipgate 融合 [Linksyncx](../Linksyncx) 的企业级多平台网关与计费体系，以及 **虚拟机全拟真订阅转 API（VM-Slot）** 能力，严格保持 **Go + Zig + Bun (TypeScript) + Vue 3** 四层双平面技术栈，并支持单服务一键启动。

## 1. 双平面与三模式执行路由

- **DataPlane（热路径）**：`Client -> slipgate-net (Go) <-> slipgate-core (Zig) -> [Stealth-HTTP | VM-Slot (slipgate-guestd) | Direct-API]`
  - `/v1/*`、`/v1beta/*`、`/mcp/*` 请求**严禁经过 TypeScript 中间件**。
  - Go 与 Zig 通过定长 10 字节帧头的多路复用二进制 IPC 协议通信（Linux 默认 UDS，Windows/开发模式使用 `127.0.0.1:19081`）。
  - **三种上游执行模式**：
    1. `stealth_http`：Go `uTLS + mihomo` 拟真传输（适用于 OpenAI / Gemini / Grok / Antigravity 及轻量池）。
    2. `vm_slot`：在全隔离 KVM/Docker 槽位内运行官方原生 CLI 进程与 Zig 守护进程 `slipgate-guestd`（VirtIO-Vsock / UDS 通信，支持单槽 20 路 Subagent 并发与硬件指纹固化）。
    3. `direct_api`：直连用户或渠道配置的官方 API Key 端点（不占用 OAuth 或 VM 槽位）。
- **ControlPlane（管理与商业路径）**：`Browser / PayHook -> slipgate-net (Go) -> slipgate-bff (Bun TS)`
  - `/api/*`、`/webhooks/*`、`/oauth/*` 由 `slipgate-net` 反向代理至 `slipgate-bff`。
  - 静态页面 `/` 由 `slipgate-net` 内嵌 `apps/web-vue` 编译产物直接服务。

## 2. 单服务 Supervisor 启动模型

`slipgate`（Go 主进程）集成了内置进程监管器 `internal/supervisor`：
1. 顺序拉起 `slipgate-core`（Zig 数据面引擎）和 `slipgate-bff`（Bun 编译产物或脚本进程）；
2. 聚合子进程 `[core]` / `[bff]` 日志流至统一标准输出；
3. `/readyz` 同时探活 Zig IPC（`FramePing -> FramePong`）与 Bun BFF（`GET /api/v1/health`）；
4. 收到 `SIGINT` / `SIGTERM` 后先优雅排空边缘 HTTP 请求，再逆序停止子进程。

## 3. VM 完全拟真体系与 `slipgate-guestd`（纯 Zig 实现）

1. **硬件指纹不可变守卫（`net.vm_hardware_personas`）**：
   - 每个槽位生成并持久化唯一 `SMBIOS UUID`、网卡 `MAC`、CPU 拓扑、时区、可选加密 DoH 解析器，以及 32 位小写非全零十六进制 `guest_machine_id`。
   - `vmslot.Manager` 禁止在已创建槽位上篡改 `guest_machine_id`（返回 `ErrImmutableMachineID`）。
2. **1 槽 1 独立出口与 Fail-Closed 熔断**：
   - 每个活跃 `vm_slot` 必须绑定健康且不重叠的 `ClashNodeID` 与 `ExitIP`（`ErrSharedSlotEgress`）。
   - `clashpool.Manager.ResolveDialTarget` 在节点失效或出口 IP 漂移未确认时立即返回 `ErrExitCircuitOpen`，**绝不退化为宿主机直连**。
3. **20 路 Subagent 并发与 Native Handoff 锁**：
   - `slipgate-guestd` 在客机内部维护最多 20 路官方进程并发席位（`SlotQuotaWindow`）。
   - 开启原生工具交接（`native_handoff_enabled`）时，一旦首个可见工具字节（`onVisibleToolDelta`）交付调用方，即锁定当前槽位禁止换槽重试，并将重复 `tool_result` 与过期续接明确保留为 `409` / `410`。
4. **5h / 7d 窗口对齐与账号级累计**：
   - `core.account_window_quotas` 按官方 5 小时滚动窗口和 7 天硬限同步基点百分比（`watermark_bps = 9500` 提前冷却切换）；历史累计 Token 与成本锚定至 `account_id`，KVM 跨机迁移或日志清理不丢失统计。
5. **零提示词注入（Zero-Injection）与进槽前风控**：
   - Zig `risk_gate.zig` 在出站前执行协议清洗、内部 CLI 工具防泄漏拦截（`CleanseMode.zero`）、蒸馏特征检测与可配置脱敏。
   - 违规设备/会话按 **10 分钟 → 24 小时 → 永久** 阶梯封禁；**普通上游 HTTP 400 不计入违规次数**。
6. **显式种子核对、遥测开关与无 Agent SSH KVM 迁移**：
   - 控制面按槽内实际配置文件显式读写并支持切换遥测开关（`enabled` / `isolated` / `disabled`）。
   - Go 通过无 Agent SSH 纳管多台 VPS 节点；仅 `kvm_qemu` 槽在排空所有活跃 Subagent 席位（`ActiveSubagents == 0`）后可执行跨节点迁移或内存扩容。

## 4. 数据库单写者隔离（PostgreSQL Schemas）

| Schema | 唯一写者 | 核心表 |
| :--- | :--- | :--- |
| `core.*` | `slipgate-core` (Zig) | `groups`, `accounts`, `composite_routes`, `api_keys`, `quota_wallets`, `ledger_entries`, `usage_logs`, `account_window_quotas`, `risk_ban_records`, `refusal_cache` |
| `net.*` | `slipgate-net` (Go) | `clash_subscriptions`, `clash_nodes`, `tls_profiles`, `proxy_bindings`, `node_traffic_daily`, `cluster_nodes`, `vm_slots`, `vm_hardware_personas`, `vm_migration_jobs` |
| `commerce.*` | `slipgate-bff` (Bun TS) | `users`, `auth_identities`, `passkeys`, `payment_orders`, `outbox_events`, `subscriptions`, `redeem_codes` |

所有金额均采用 `i128` 定点纳美元（`1 USD = 1,000,000,000 nano-USD`），PostgreSQL 中以 `NUMERIC(39, 0)` 存储。
