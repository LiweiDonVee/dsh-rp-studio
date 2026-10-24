# DSH RP Studio

DSH 0.2.1-rc.2 原生角色扮演工作区。在会话顶部点击 RP 打开右侧页签，支持宿主的拖动宽度、全屏和关闭操作。

- 角色与剧情：场景、主角、目标、关系、任务、物品和记忆。
- 沉浸阅读：玩家与 GM 对话、流式回复，以及发送、停止、回退、分支和自动续写。
- 故事档案：选择角色开始故事，或继续已有故事。

1.2 可与独立的 `dsh-rp-last-step` 联用：故事页增加预设入口，读取已确认的最终正文，并接收原生正文流。已启用最后一步的故事中，主 Agent 的处理文字不作为旁白；旧故事及普通预设保持原有阅读方式。

## 安装

下载 `dsh-rp-studio-1.2.0.tgz` 后，先完全退出 dsh，再在终端执行：

```powershell
dsh plugin --profile desktop add ./dsh-rp-studio-1.2.0.tgz
```

Web 模式请把 `desktop` 改为 `web`。重新打开 dsh，进入任一会话，点击会话顶部的 RP 按钮。新故事沿用 dsh 自己的模型、权限审批和登录状态。

插件在 dsh 内运行，不启动额外服务，不需要复制访问令牌。所有内容通过宿主的认证接口读取；角色配置中的私有字段保持原有过滤规则。

## 从源码构建

在仓库根目录执行 `pnpm install`，然后 `pnpm plugin:package`。产物位于 `packages/plugin/artifacts/`。浏览器入口使用 dsh ModuleLoader，React 由宿主提供；发布包包含已打包的宿主和浏览器代码，无需另行安装仓库内的包。

## 验证

`pnpm plugin:test` 运行宿主契约测试。`pnpm plugin:smoke` 使用官方 dsh 启动器及全新的 `.runtime/native-smoke-*` home，安装打包产物、创建合成 RP 预设和会话，并验证入口、全屏、档案导航、窄窗口与关闭重开。它不发送模型 prompt，也不读取现有用户会话。需要 Playwright Chromium（`pnpm exec playwright install chromium`）；可通过 `DSH_BIN` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定启动器及浏览器。测试截图位于 `.runtime/evidence/`。
