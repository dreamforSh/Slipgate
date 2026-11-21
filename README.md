# Slipgate

> 新一代高性能 AI API 统一网关：融合多平台配额调度、Clash 独立出口隐匿与 VM 虚拟机全拟真订阅转 API（基于 Go + Zig + Bun + Vue）。

## 技术栈总览

| 层级 | 模块 | 技术选型 | 职责 |
| :--- | :--- | :--- | :--- |
| **L1 网络与监管层** | [`services/net-go`](services/net-go) | Go 1.27 + mihomo + uTLS | 统一 `:8080` 边缘入口（H1/H2C/WS）、单服务进程监管器、Clash 1 槽 1 IP 独立出口池、VM 硬件指纹与 SSH KVM 集群调度 |
| **L2 核心引擎层** | [`services/core-zig`](services/core-zig) | Zig 0.14 + Arena + i128 | 零 GC 宿主路由与进槽前风控（`slipgate-core`）、i128 复式账本、5h/7d 窗口与客机内原生守护进程（`slipgate-guestd`） |
| **L3 业务中间件** | [`services/bff-ts`](services/bff-ts) | Bun + TypeScript + Hono + Zod | Vue 控制台 BFF、IAM/Passkey/OAuth2、VM 种子/遥测/风控审计聚合、支付回调 Outbox 与 TS 插件宿主 |
| **L4 前端控制台** | [`apps/web-vue`](apps/web-vue) | Vue 3.5 + Vite 6 + TailwindCSS + Pinia | 用户工作台、Clash 出口拓扑、VM 拟真槽舰队看板与进槽前风控面板 |
| **跨语言契约** | [`proto`](proto) / [`packages/contracts`](packages/contracts) | Buf Protobuf v3 / Zod | 跨 Go / Zig / Bun / Vue 的单一事实来源契约 |

更多架构细节请参阅 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 目录结构

```text
Slipgate/
├── proto/                  # Buf Protobuf v3 跨语言契约
├── migrations/             # PostgreSQL 单写者 Schema (core / net / commerce)
├── packages/
│   ├── contracts/          # Vue 与 Bun BFF 共享 Zod Schema 及 nano-USD 工具
│   └── plugin-sdk/         # TypeScript 生命周期插件 SDK
├── services/
│   ├── net-go/             # L1 Go 网络层 + 单服务 Supervisor + 内嵌前端 SPA
│   ├── core-zig/           # L2 Zig 数据面核心引擎
│   └── bff-ts/             # L3 Bun TypeScript 业务中间件
├── apps/
│   └── web-vue/            # L4 Vue 3 双端控制台
├── scripts/                # 跨平台构建与统一开发启动脚本
├── deploy/                 # Docker Compose 与环境变量模板
├── Dockerfile              # 多阶段构建 -> 单一运行镜像 (内置 Go+Zig+Bun 三进程)
└── .github/workflows/      # CI (Proto/Go/Zig/Bun/Docker 冒烟) 与 Release 发布流水线
```

---

## 快速开始

### 方式一：单服务容器一键启动（推荐）

```bash
cd deploy
docker compose up --build -d
# 访问统一入口：http://127.0.0.1:8080
# 就绪探针：curl http://127.0.0.1:8080/readyz
```

### 方式二：本地开发工具链

推荐在开发机安装以下工具：
- **Go 1.27+**
- **Zig 0.14.0**
- **Bun 1.2+**
- **Buf CLI**（可选，用于 Protobuf 校验与生成）
- **just**（可选，统一任务命令）

构建与运行：

```bash
# 安装 JS/TS 工作区依赖
bun install

# 一键编译所有层到 bin/ 并启动单服务
bun run build
./bin/slipgate
```

Windows PowerShell 若仅安装了 Go / 部分工具链，也可运行分步构建脚本：

```powershell
.\scripts\build.ps1
.\bin\slipgate.exe --allow-degraded
```

---

## 关联远端 Git 仓库与触发 CI

本地仓库已初始化在 `main` 分支，推送到你创建的远端仓库后即可自动触发 `.github/workflows/ci.yml`：

```bash
git remote add origin <你的远端仓库URL>
git push -u origin main
```

发布镜像（`v*.*.*` Tag 自动构建多架构镜像并推送至 GHCR）：

```bash
git tag v0.1.0
git push origin v0.1.0
```
