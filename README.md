# DSH RP Studio

本地优先的 DeepSeek Harness 角色扮演前端。

```text
React SPA -> RP Gateway / BFF -> DSH 127.0.0.1:3080
                            \-> Prompt Presets 127.0.0.1:3091
```

DSH 继续负责模型、agent preset、工具、session、projection 与持久化。Studio 只提供玩家界面；浏览器不会访问 3080，也不会接收 raw DSH event、reasoning、tool result、`meta.rp`、`secrets` 或 `offscreen`。

## 当前档案

- `rp-runtime`：卡片无关的 RP Runtime 基础模板；不出现在新建列表，仅用于恢复已存历史会话和派生新卡
- `zombie-world`：可直接新建的世界模拟器档案

Gateway 只展示同时满足以下条件的可玩预设：用户预设、DSH roster 可用、存在合法且目录 id 一致的 `rp-card.json`，且 `kind` 不是 `template`。基础模板仍保留在内部索引中，因此旧会话可继续打开。

## 安装与启动

2026-09 适配后可运行 `pnpm start:stack`：使用旁边 `deepseek-harness-local` 的 DSH 0.1.2-rc.1，启动 3080 Web 与 4317 Studio，并在进程内自动交换认证 token。Prompt Presets 共用 3080 宿主；无需另开 3091。终端会显示私有 DSH 登录链接；关闭启动进程同时停止两个服务。运行前先执行 `pnpm build`。已有服务占用端口时启动器会报错，不会关闭其他进程。`DSH_HOME` 可指定测试目录，`DSH_PORT` / `DSH_RP_PORT` 可调整端口。

环境要求：Node.js 24、pnpm 11，以及运行在 `127.0.0.1:3080` 的 DSH。叙事方法管理还需要带 `dsh-prompt-presets` bundle 的 DSH Web profile 运行在 `127.0.0.1:3091`；该服务不可用时，Studio 仍保留 Agent runtime 与卡片底座，只禁用可选叙事方法面板。

当前适配目标为 **DSH 0.1.2-rc.1**。Gateway 使用 Remote RPC、`remote.mux`、`session/follow` 和 `session/page`；旧版 `ApiProxy` 的点号 RPC 已不再支持。详细接口与版本边界见 [DSH 兼容说明](docs/dsh-compatibility.md)。

DSH Web 的 HTTP API 和 WebSocket 在 loopback 上也需要认证。先启动相应 DSH Web profile，将其启动 URL 中 `token` 的值设为 Gateway 进程环境变量（下面为占位示例）：

```powershell
$env:DSH_WEB_TOKEN = '<3080 启动 URL 的 token>'
$env:PROMPT_PRESETS_WEB_TOKEN = '<3091 启动 URL 的 token>'
```

Gateway 在服务端以启动 token 换取 cookie，并在 HTTP/WebSocket 中复用；token/cookie 不进入浏览器或公开协议。`.env.example` 是配置示例，启动脚本不会自动加载 `.env`。DSH 重启后若认证失效，更新对应 token 并重启 Gateway。不要将 token 写入 `VITE_*` 变量或提交到仓库。

```powershell
Set-Location E:\WorkSpace\repos\dsh-rp-studio
.\scripts\install.ps1
.\scripts\start.ps1
```

默认地址：<http://127.0.0.1:4317>。启动脚本仅绑定 loopback；若首选端口被其他程序占用，会在随后 20 个端口中选择可用端口。已有 Studio 占用首选端口时，脚本直接报告现有地址。

可用 `-DshPort`、`-PromptPresetsPort` 和 `-Port` 分别覆盖三个 loopback 端口。所有会话的可选叙事方法默认关闭；空白配置会在“方法”页提示，修改从下一轮生效。

安装脚本在检查前把已安装的两套 RP runtime 关键文件复制到 `.snapshots/<timestamp>-before-install`。它不会读取、复制或修改 `C:\Users\Owner\.dsh\sessions`。

## 验证

```powershell
pnpm verify
pnpm smoke:real
```

`pnpm verify` 执行零 warning lint、workspace typecheck、单元测试、生产构建和 Playwright。浏览器验收覆盖 SSE 流式输出、取消、连续回退、分支、自动续跑启停、刷新恢复、卡片切换、移动 sheet、四个目标视口、secret canary 扫描与 axe 无障碍检查。`pnpm smoke:real` 只读检查真实 DSH 和生产页面，不会发送模型 prompt。

`smoke:real` 的 HTTP 请求只使用读取接口，但 DSH 的 `session/follow` 可能激活冷会话并由 DSH 执行日志升级；需要绝对不触碰历史文件时，请使用隔离的 DSH home。Studio 自身不会直接打开或改写线上 Session 日志。

## API

公开协议位于 `/api/v1`：

- `GET /health`, `/cards`, `/sessions`, `/sessions/:id`
- `POST /sessions`, `/sessions/:id/messages`, `/cancel`, `/rollback`, `/fork`
- `PUT /sessions/:id/autoplay`
- `GET`, `PUT`, `DELETE /sessions/:id/prompt-presets`
- `GET /sessions/:id/events`（SSE）

早期本地客户端使用的 `/prompt`、`/stream` 和 `POST /autoplay` 仍作为兼容入口保留。
