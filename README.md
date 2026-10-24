# DSH RP Studio

DSH 0.2.1-rc.2 内置角色扮演工作区。点击会话顶部的 **RP** 打开右侧页签；空白会话中，RP 位于输入区上方。工作区可以拉宽、全屏阅读或关闭，使用 dsh 本身的主题和会话导航。

- **角色与剧情**：场景、角色状态、目标、关系、任务、物品与记忆。
- **沉浸阅读**：玩家与 GM 对话、流式回复、发送行动、停止生成、回退、分支和自动续写。
- **故事档案**：选择已安装的 RP 角色预设开始故事，或继续已有旅程。

原生插件直接使用宿主进程内的 Remote 接口及经过认证的 Connection 路由，不另起服务，不需要复制 token。模型选择、权限审批与数据持久化沿用 dsh；公开状态和叙事仍经过原有过滤，不把 reasoning、tool result 或私有剧情字段发给工作区。

![DSH 内置 RP 工作区](docs/images/native-rp-workspace.png)

## 通用 Agent Loop 插件

独立的 [DSH Loop Studio](packages/loop-plugin/README.md) 适用于任意 dsh 预设的组成分析及内置 agent-loop 执行图。支持为首个模型请求、工具后的后续请求和接入的模型阶段单独配置 provider/model，保存会话覆盖或预设默认；无需安装 RP Studio。第一版保持宿主执行顺序，图内核与适配器分离，为后续可编辑流程保留边界。

![通用 Agent Loop Studio](docs/images/agent-loop-studio.png)

构建：`pnpm loop:package`；无密钥真实宿主验收：`pnpm loop:smoke`。RP“最后一步”及其 ST 迁移 skill 为独立部分，设计位于 [RP 设计稿](docs/superpowers/specs/2026-10-24-rp-last-step-design.md)。

## 安装原生插件（推荐）

下载 `dsh-rp-studio-1.1.0.tgz`，完全退出 dsh 后执行：

```powershell
dsh plugin --profile desktop add ./dsh-rp-studio-1.1.0.tgz
```

重新启动 dsh 即可。Web 模式将 `desktop` 换为 `web`。也可以通过右侧面板的新增页签导航找到 **RP Studio**。插件不附带角色卡；RP 预设仍需单独安装。具体说明见 [插件文档](packages/plugin/README.md)。

源码构建：Node 24、pnpm 11，执行 `pnpm install` 与 `pnpm plugin:package`。安装包生成在 `packages/plugin/artifacts/`。仅构建原生插件时，若不需要下载旧 Electron 客户端，可以在安装依赖前设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。

下文保留独立客户端及其 Gateway 的使用说明，作为已有用户的兼容入口。

## 档案

Studio 不附带私有角色卡。新安装的隔离 DSH home 可以没有可玩卡和会话；测试中的 `sample-world` 只是合成 fixture。`rp-runtime` 基础模板不出现在新建列表，仅用于恢复已存历史会话和派生新卡。

Gateway 只展示同时满足以下条件的可玩预设：用户预设、DSH roster 可用、存在合法且目录 id 一致的 `rp-card.json`，且 `kind` 不是 `template`。基础模板仍保留在内部索引中，因此旧会话可继续打开。

## 独立客户端与 Gateway

Windows Desktop portable 位于 `apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.exe`，桌面快捷方式为 `DSH RP Studio.lnk`。它内置 Gateway/Web 构建资源，依赖本机安装的官方 DeepSeek Harness `0.2.0-rc.2`，自动发现其 `resources/runtime/cli/bin/dsh.cmd` 和独立 Node 24，并将新用户数据保存在 Electron `userData`。不会在 portable 内捆绑或替代官方 DSH，也不会读取私有卡库。ZIP 是同一 Windows Desktop 的解压版。

开发环境可运行 `pnpm start:stack`：使用官方 DSH 0.2.0-rc.2 Web profile，启动 DSH Web 与 Studio，并在进程内自动交换认证 token。先运行 `pnpm build`。默认 DSH home 位于项目忽略的 `.runtime/dsh-home`，`DSH_RUNTIME_ROOT` 可覆盖官方安装目录，`DSH_HOME` 可指定隔离测试目录，`DSH_PORT` / `DSH_RP_PORT` 可调整端口。已有服务占用端口时不会关闭其他进程。

开发构建要求 Node.js 24 和 pnpm 11；portable 运行使用官方 DSH 自带的独立 Node，不要求单独启动 3080/3091 服务。Supervisor 在 loopback 上为 DSH/Gateway 分配端口。可选叙事方法由配置的 DSH Web profile 提供，缺失时仅禁用方法面板。

原生插件的验证目标为 **DSH 0.2.1-rc.2**；独立客户端的运行时发现同时接受 0.2.0-rc.2 与 0.2.1-rc.2。Gateway 使用 Remote RPC、`remote.mux`、`session/follow` 和 `session/page`；旧版 `ApiProxy` 的点号 RPC 已不再支持。详细接口与版本边界见 [DSH 兼容说明](docs/dsh-compatibility.md)。

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
