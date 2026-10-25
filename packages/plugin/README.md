# DSH RP Studio

RP Studio 1.3.0 是面向 DSH 0.2.1-rc.3 的原生角色扮演工作区。在会话顶部点击 RP 打开右侧页签，支持宿主的拖动宽度、全屏和关闭操作。

- 角色与剧情：通用 GM 的当前场景与事实，以及旧预设的关系、任务、物品和记忆。
- 沉浸阅读：玩家行动、正式正文、候选手改与采用、冻结材料、失败重试和作者注入口。
- 故事档案：Story Kit 角色、身份与开场入口，旧预设故事导航，以及阅读稿和完整存档操作。

可与独立的 [RP 最后一步 0.3](https://github.com/LiweiDonVee/dsh-rp-last-step) 联用：读取已确认的有效正文并接收原生正文流，候选采用不会重复事实结算。失败重试可能包含一次主模型受限调度及一次正文请求，沿用原冻结材料。旧故事及普通预设保留原有阅读方式。[Loop Studio 0.1](https://github.com/LiweiDonVee/dsh-loop-studio) 配置各阶段的实际模型。

通用开局使用 [RP GM 0.1](https://github.com/LiweiDonVee/dsh-rp-gm)、[Story Kit 0.1](https://github.com/LiweiDonVee/dsh-rp-story-kit)、[Database 0.2](https://github.com/LiweiDonVee/dsh-rp-database) 和最后一步；[Context 0.2](https://github.com/LiweiDonVee/dsh-rp-context) 管理选材、历史表示及下一轮作者注。资产、多库策略、作者注编辑与内容包组合使用各自原生面板，能力缺失只禁用对应操作。[1.3 使用与边界](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/agent-rp-integration.md) · [验证记录](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/native-acceptance.md)。

## 安装

从 [1.3.0 发布页](https://github.com/LiweiDonVee/dsh-rp-studio/releases/tag/v1.3.0) 下载 `dsh-rp-studio-1.3.0.tgz` 后，先完全退出 dsh，再在终端执行：

```powershell
dsh plugin --profile desktop add ./dsh-rp-studio-1.3.0.tgz
```

Web 模式请把 `desktop` 改为 `web`。重新打开 dsh，进入任一会话，点击会话顶部的 RP 按钮。新故事沿用 dsh 自己的模型、权限审批和登录状态。

插件在 dsh 内运行，不启动额外服务，不需要复制访问令牌。所有内容通过宿主的认证接口读取；角色配置中的私有字段保持原有过滤规则。

Windows 找不到 `dsh` 命令时，可使用默认官方启动器：

```powershell
$dshCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $dshCli plugin --profile desktop add ./dsh-rp-studio-1.3.0.tgz
```

发布页附 SHA256SUMS。完整使用、角色预设和三插件配置见 [原生指南](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/native-usage.md)。

## 从源码构建

在仓库根目录执行 `pnpm install`，然后 `pnpm plugin:package`。产物位于 `packages/plugin/artifacts/`。浏览器入口使用 dsh ModuleLoader，React 由宿主提供；发布包包含已打包的宿主和浏览器代码，无需另行安装仓库内的包。

## 验证

`pnpm plugin:test` 运行宿主契约测试。`pnpm plugin:smoke` 使用官方 dsh 启动器及全新的 `.runtime/native-smoke-*` home，安装打包产物、创建合成 RP 预设和会话，并验证入口、全屏、档案导航、窄窗口与关闭重开。它不发送模型 prompt，也不读取现有用户会话。需要 Playwright Chromium（`pnpm exec playwright install chromium`）；可通过 `DSH_BIN` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定启动器及浏览器。测试截图位于 `.runtime/evidence/`。
