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

### 方式一：拉取预构建生产镜像一键部署（免源码编译）

```bash
cd deploy
cp .env.example .env
# 默认拉取 ghcr.io/dreamforsh/slipgate:latest
docker compose -f docker-compose.prod.yml up -d
# 若需启用 dev 仓库自动热更新通道：
# SLIPGATE_IMAGE_TAG=dev SLIPGATE_MODE=dev docker compose -f docker-compose.prod.yml up -d
```

### 方式二：Linux 预编译二进制一键安装

```bash
# Release 稳定通道：
curl -fsSL https://raw.githubusercontent.com/dreamforSh/Slipgate/main/deploy/install.sh | sudo bash

# Dev 自动热更新通道（自动跟踪 dreamforSh/Slipgate main 最新构建）：
curl -fsSL https://raw.githubusercontent.com/dreamforSh/Slipgate/main/deploy/install.sh | sudo bash -s -- --channel dev
```

### 方式三：本地源码 Docker Compose 构建

```bash
cd deploy
docker compose up --build -d
# 访问统一入口：http://127.0.0.1:8080
# 就绪探针：curl http://127.0.0.1:8080/readyz
```

### 私有仓库部署（Private GitHub Repo & GHCR）

当仓库为私有状态时，请创建一个只读 **GitHub Personal Access Token (PAT)**（拉取 GHCR 镜像勾选 `read:packages`；使用 Release 安装或 `dev` 热更新勾选 `repo` / Fine-grained `Contents: Read-only`）：

1. **私有 GHCR 镜像一键部署（推荐）**：
   ```bash
   echo "<YOUR_GITHUB_PAT>" | docker login ghcr.io -u <YOUR_GITHUB_USER> --password-stdin
   # 下载或克隆 deploy/ 目录后：
   cd deploy && cp .env.example .env
   # 若需开启私有仓库 dev 自动热更新，在 .env 中填写 SLIPGATE_GITHUB_TOKEN=<YOUR_GITHUB_PAT>
   SLIPGATE_IMAGE_TAG=dev docker compose -f docker-compose.prod.yml up -d
   ```
2. **私有 Release 二进制一键安装（systemd）**：
   ```bash
   curl -fsSL -H "Authorization: Bearer <YOUR_GITHUB_PAT>" \
     https://raw.githubusercontent.com/dreamforSh/Slipgate/main/deploy/install.sh \
     | sudo SLIPGATE_GITHUB_TOKEN="<YOUR_GITHUB_PAT>" bash -s -- --channel dev
   ```
3. **服务器克隆私有源码本地构建（无需 GHCR 登录）**：
   ```bash
   git clone git@github.com:dreamforSh/Slipgate.git && cd Slipgate/deploy
   cp .env.example .env && docker compose up --build -d
   ```

---

## Dev 模式仓库热更新（Hot-Update）

以 `--dev` 或 `SLIPGATE_MODE=dev` 启动时，`slipgate` 网关会在保持 `:8080` 入口不断线的前提下自动同步仓库更新：

- **`release` 通道策略（无编译器服务器 / Docker 容器默认）**：轮询 `dreamforSh/Slipgate` 的 `dev-latest` 滚动预发布与 `BUILD_META.json`，下载平台包并通过 `SHA256SUMS.txt` 严格校验 SHA-256 后，动态接管 Vue SPA 目录并用进程监管器平滑重启 `slipgate-core` 与 `slipgate-bff`。
- **`git` 通道策略（源码工作区）**：执行 `git fetch` / `git pull --ff-only`，仅在工作区干净时重编译静态前端、`slipgate-bff` 与 `slipgate-core` 并重启子进程。
- **管理控制台入口**：登录管理员控制台可在「版本构建与仓库热更新 (Dev Hot-Sync)」卡片中实时查看提交哈希并触发一键检查/热更新（`/api/v1/admin/system/update`）。

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
