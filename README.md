# DSH RP Studio

本地优先的 DeepSeek Harness 角色扮演前端。

```text
Electron / React SPA -> RP Gateway / BFF -> official DSH Web (loopback)
```

DSH 继续负责模型、agent preset、工具、session、projection 与持久化。Studio 只提供玩家界面；浏览器不会访问 3080，也不会接收 raw DSH event、reasoning、tool result、`meta.rp`、`secrets` 或 `offscreen`。

## 档案

Studio 不附带私有角色卡。新安装的隔离 DSH home 可以没有可玩卡和会话；测试中的 `sample-world` 只是合成 fixture。`rp-runtime` 基础模板不出现在新建列表，仅用于恢复已存历史会话和派生新卡。

Gateway 只展示同时满足以下条件的可玩预设：用户预设、DSH roster 可用、存在合法且目录 id 一致的 `rp-card.json`，且 `kind` 不是 `template`。基础模板仍保留在内部索引中，因此旧会话可继续打开。

## 安装与启动

Windows Desktop portable 位于 `apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.exe`，桌面快捷方式为 `DSH RP Studio.lnk`。它内置 Gateway/Web 构建资源，依赖本机安装的官方 DeepSeek Harness `0.2.0-rc.2`，自动发现其 `resources/runtime/cli/bin/dsh.cmd` 和独立 Node 24，并将新用户数据保存在 Electron `userData`。不会在 portable 内捆绑或替代官方 DSH，也不会读取私有卡库。ZIP 是同一 Windows Desktop 的解压版。

开发环境可运行 `pnpm start:stack`：使用官方 DSH 0.2.0-rc.2 Web profile，启动 DSH Web 与 Studio，并在进程内自动交换认证 token。先运行 `pnpm build`。默认 DSH home 位于项目忽略的 `.runtime/dsh-home`，`DSH_RUNTIME_ROOT` 可覆盖官方安装目录，`DSH_HOME` 可指定隔离测试目录，`DSH_PORT` / `DSH_RP_PORT` 可调整端口。已有服务占用端口时不会关闭其他进程。

开发构建要求 Node.js 24 和 pnpm 11；portable 运行使用官方 DSH 自带的独立 Node，不要求单独启动 3080/3091 服务。Supervisor 在 loopback 上为 DSH/Gateway 分配端口。可选叙事方法由配置的 DSH Web profile 提供，缺失时仅禁用方法面板。

当前适配目标为 **DSH 0.2.0-rc.2**。Gateway 使用 Remote RPC、`remote.mux`、`session/follow` 和 `session/page`；旧版 `ApiProxy` 的点号 RPC 已不再支持。详细接口与版本边界见 [DSH 兼容说明](docs/dsh-compatibility.md)。

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

项目默认使用隔离的 DSH home，不会读取、复制或修改 `C:\Users\Owner\.dsh\sessions`。私有预设和卡片仍由其所有者单独安装。

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
