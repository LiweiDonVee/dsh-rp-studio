# DSH RP Studio

本地优先的 DeepSeek Harness 角色扮演前端。

```text
React SPA -> RP Gateway / BFF -> DSH 127.0.0.1:3080
```

DSH 继续负责模型、agent preset、工具、session、projection 与持久化。Studio 只提供玩家界面；浏览器不会访问 3080，也不会接收 raw DSH event、reasoning、tool result、`meta.rp`、`secrets` 或 `offscreen`。

## 当前卡片

- `rp-runtime`：魔药宗师
- `zombie-world`：世界模拟器

Gateway 只展示同时满足以下条件的预设：用户预设、DSH roster 可用、存在合法且目录 id 一致的 `rp-card.json`。

## 安装与启动

环境要求：Node.js 24、pnpm 11，以及运行在 `127.0.0.1:3080` 的 DSH。

```powershell
Set-Location E:\WorkSpace\dsh-rp-studio
.\scripts\install.ps1
.\scripts\start.ps1
```

默认地址：<http://127.0.0.1:4317>。启动脚本仅绑定 loopback；若首选端口被其他程序占用，会在随后 20 个端口中选择可用端口。已有 Studio 占用首选端口时，脚本直接报告现有地址。

安装脚本在检查前把已安装的两套 RP runtime 关键文件复制到 `.snapshots/<timestamp>-before-install`。它不会读取、复制或修改 `C:\Users\Owner\.dsh\sessions`。

## 验证

```powershell
pnpm check
pnpm e2e
```

`pnpm check` 执行 workspace typecheck、单元测试与生产构建。`pnpm e2e` 使用隔离的 mock Gateway 运行 Playwright，覆盖 SSE 流式输出、回退、分支、自动续跑、移动 sheet、四个目标视口、secret canary 扫描与 axe 无障碍检查，不会调用真实模型。

## API

公开协议位于 `/api/v1`：

- `GET /health`, `/cards`, `/sessions`, `/sessions/:id`
- `POST /sessions`, `/sessions/:id/messages`, `/cancel`, `/rollback`, `/fork`
- `PUT /sessions/:id/autoplay`
- `GET /sessions/:id/events`（SSE）

早期本地客户端使用的 `/prompt`、`/stream` 和 `POST /autoplay` 仍作为兼容入口保留。
