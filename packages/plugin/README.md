# DSH RP Studio

RP Studio 1.5.1 是面向 DSH 0.2.1-rc.5 的原生角色扮演工作区。在会话顶部或空白会话点击 `RP ▾`，从菜单打开故事页面、各插件的完整管理页或独立 RP 助手。支持宿主的拖动宽度、全屏和关闭操作。

- 角色与剧情：通用 GM 的当前场景与事实，以及旧预设的关系、任务、物品和记忆。
- 沉浸阅读：玩家行动、事实审批与重新生成、正式正文、候选手改与采用、冻结材料、失败重试和作者注入口。
- 故事档案：Story Kit 角色、身份与开场入口，旧预设故事导航，以及阅读稿和完整存档操作。

可与独立的 [RP 最后一步 0.4](https://github.com/LiweiDonVee/dsh-rp-last-step) 联用：读取已确认的有效正文并接收原生正文流，候选采用不会重复事实结算。失败重试可能包含一次主模型受限调度及一次正文请求，沿用原冻结材料。旧故事及普通预设保留原有阅读方式。[Loop Studio 0.1](https://github.com/LiweiDonVee/dsh-loop-studio) 配置各阶段的实际模型。

当前组合使用 [RP GM 0.2](https://github.com/LiweiDonVee/dsh-rp-gm)、[Story Kit 0.2](https://github.com/LiweiDonVee/dsh-rp-story-kit)、[Database 0.3](https://github.com/LiweiDonVee/dsh-rp-database) 和最后一步 0.4；[Context 0.3](https://github.com/LiweiDonVee/dsh-rp-context) 管理有效历史材料、选材及下一轮作者注。资产、多库策略、作者注编辑与内容包组合使用各自原生面板，能力缺失只禁用对应操作。[使用与边界](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/agent-rp-integration.md) · [原生验证记录](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/native-acceptance.md)。

## 安装

1.4 新增每故事事实审批（默认关闭）、事实重生和只重新写作。新入口要求 GM 0.2、Database 0.3、RP 最后一步 0.4 的实际能力；Context 0.3 和 Story Kit 0.2 分别消费有效材料与阅读导出。旧版插件和预设路径继续按原能力提供。V6 七包组合的旧九场景回归与审批／两层重生五组实际功能断言均已通过，范围与发行验证边界见[当前原生证据](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/native-acceptance.md#v6-approval-and-regeneration)。

等待审批时先检查候选与当前事实，再选择通过、自定义、重试事实或取消。自定义精确采用场景、事实、摘要和公开方向，不调用事实模型改写；随后写作仍会请求模型。事实生效后供后续 GM 和 Context 使用，旧版保留审计；写作失败可独立继续，新事实尚无正文时显示等待写作。

事实重生只用于最近合格普通回合，沿用已捕获起点与实际工具证据，不重跑工具；没有捕获基线的旧回合不能使用。只重新写作沿用当前事实版本的完整冻结材料与当前写作路由，成功后追加新正文，原生日志不回退或覆盖。正文生成阶段只重跑 writer，原生调度可能另有主模型请求，两者分别计数；阅读稿仍交给 Story Kit 导出。

“继续审批结算”和“继续候选结算”均不调用模型，也不自动写作；结算完成后明确点击“继续已批准事实的写作”。完整步骤见[审批与重新生成用法](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/agent-rp-integration.md#事实审批与两层重新生成)。

安装包为 `dsh-rp-studio-1.5.1.tgz`，下载入口为 [发布页](https://github.com/LiweiDonVee/dsh-rp-studio/releases)。先完全退出 dsh，再在终端执行：

```powershell
dsh plugin --profile desktop add ./dsh-rp-studio-1.5.1.tgz
```

Web 模式请把 `desktop` 改为 `web`。重新打开 dsh，进入任一会话，点击会话顶部的 RP 按钮。新故事沿用 dsh 自己的模型、权限审批和登录状态。

插件在 dsh 内运行，不启动额外服务，不需要复制访问令牌。所有内容通过宿主的认证接口读取；角色配置中的私有字段保持原有过滤规则。

Windows 找不到 `dsh` 命令时，可使用默认官方启动器：

```powershell
$dshCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $dshCli plugin --profile desktop add ./dsh-rp-studio-1.5.1.tgz
```

安装时核对同一发布页的 SHA256SUMS。完整使用、角色预设和插件搭配见 [原生指南](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/native-usage.md)。

## RP 助手

Studio 安装包同时提供真正的 `rp-companion` Agent Preset，无需另装助手包。在 `RP ▾ → RP 助手` 打开独立管理草稿，或在新会话的 Agent Preset 中选择“RP 助手”。入口只填入引导，不自动发送；检查目标故事 ID 与需求后发送即可。原故事会话继续使用 `rp-gm`。

完整使用时，将 Studio、Loop、Story Kit、Database、Context、GM 和 RP 最后一步七包安装到同一个 profile。助手复用各插件的公共业务服务，支持角色与身份创建/编辑、角色卡/世界书/资料/内容包导入、ST 写作预设导入与迁移、写作预设草稿调整、上下文与节点模型配置，以及经 Story Kit 审阅配置开局和读回。某个插件未启用时只报告该能力缺失，不伪造成功。

文件导入使用正式宿主文件服务读取原始 JSON/PNG/PDF 字节。原始导入留在所属插件；助手不直接改 owner 数据或宿主 profile。管理写入沿用 DSH 的权限审批；非完全访问模式可能出现一次原生批准请求。锁定、必用和默认关闭的模块策略保留，迁移仍交付待审阅草稿；故事事实审批继续默认关闭。更多约束见[助手操作合同](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/rp-companion.md)。

助手基于 rc.5 的创造模式组成，保留官方组成编辑、插件开发和 API 检查能力，并增加 RP skill 与固定的管理工具。此预设默认不挂载 web 工具。上游许可见随包的 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 从源码构建

在仓库根目录执行 `pnpm install`，然后 `pnpm plugin:package`。产物位于 `packages/plugin/artifacts/`。浏览器入口使用 dsh ModuleLoader，React 由宿主提供；发布包包含已打包的宿主和浏览器代码，无需另行安装仓库内的包。

TGZ 安装和外部目录的 `link:` 安装均受支持。发行包将宿主供应的依赖标为 optional peer，消费安装时不要求另装 DSH SDK；这里的 optional 是安装元数据，RP 助手仍要求宿主提供原生权限服务。

## 验证

`pnpm plugin:test` 运行宿主契约测试。`pnpm plugin:smoke` 使用官方 dsh 启动器及全新的 `.runtime/native-smoke-*` home，安装打包产物、创建合成 RP 预设和会话，并验证入口、全屏、档案导航、窄窗口与关闭重开。它不发送模型 prompt，也不读取现有用户会话。需要 Playwright Chromium（`pnpm exec playwright install chromium`）；可通过 `DSH_BIN` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定启动器及浏览器。测试截图位于 `.runtime/evidence/`。
