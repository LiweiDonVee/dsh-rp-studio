# DSH RP Studio

RP Studio 1.6.0 是面向 DSH 0.2.2-rc.1 的原生角色扮演工作区。在会话顶部或空白会话点击 `RP ▾`，从菜单打开故事页面、各插件的完整管理页或独立 RP 助手。支持宿主的拖动宽度、全屏和关闭操作。

- 角色与剧情：通用 GM 的当前场景与事实，以及旧预设的关系、任务、物品和记忆。
- 沉浸阅读：先展开最近八轮，向前加载保留当前位置。每轮可查阅冻结依据、比较其他写法，也可以保存下一轮作者注。事实审批和事实修订有独立入口。
- 开始新故事：用 Story Kit 选择保存的角色与玩家身份版本，试读备选开场，审阅初始场景、资料与写作预设后启动。
- 故事档案：旧预设故事导航、阅读稿和完整存档操作。

进入回合下方的「本轮依据」，可查该轮公开事实变化、选中的资料版本、历史引用和已记录的阶段模型。「问 RP 助手」将这个回合放进独立草稿，发送后由助手只读查阅。「其他写法」可直接比较已保存的候选。点击「生成候选稿」才会调用 Writer，点击「明确采用」才会替换正式正文。候选采用沿用原回合的事实。

可与独立的 [RP 最后一步 0.4](https://github.com/LiweiDonVee/dsh-rp-last-step) 联用：读取已确认的有效正文并接收原生正文流，候选采用不会重复事实结算。失败重试可能包含一次主模型受限调度及一次正文请求，沿用原冻结材料。旧故事及普通预设保留原有阅读方式。[Loop Studio 0.1](https://github.com/LiweiDonVee/dsh-loop-studio) 配置各阶段的实际模型。

当前组合使用 [RP GM 0.2](https://github.com/LiweiDonVee/dsh-rp-gm)、[Story Kit 0.2](https://github.com/LiweiDonVee/dsh-rp-story-kit)、[Database 0.3](https://github.com/LiweiDonVee/dsh-rp-database) 和最后一步 0.4；[Context 0.3](https://github.com/LiweiDonVee/dsh-rp-context) 管理有效历史材料、选材及下一轮作者注。资产、多库策略、作者注编辑与内容包组合使用各自原生面板，能力缺失只禁用对应操作。[使用与边界](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/agent-rp-integration.md) · [原生验证记录](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/native-acceptance.md)。

## 安装

1.4 新增每故事事实审批（默认关闭）、事实重生和只重新写作。新入口要求 GM 0.2、Database 0.3、RP 最后一步 0.4 的实际能力；Context 0.3 和 Story Kit 0.2 分别消费有效材料与阅读导出。旧版插件和预设路径继续按原能力提供。V6 七包组合的旧九场景回归与审批／两层重生五组实际功能断言均已通过，范围与发行验证边界见[当前原生证据](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/native-acceptance.md#v6-approval-and-regeneration)。

等待审批时先检查候选与当前事实，再选择通过、自定义、重试事实或取消。自定义精确采用场景、事实、摘要和公开方向，不调用事实模型改写；随后写作仍会请求模型。事实生效后供后续 GM 和 Context 使用，旧版保留审计；写作失败可独立继续，新事实尚无正文时显示等待写作。

事实重生只用于最近合格普通回合，沿用已捕获起点与实际工具证据，不重跑工具；没有捕获基线的旧回合不能使用。只重新写作沿用当前事实版本的完整冻结材料与当前写作路由，成功后追加新正文，原生日志不回退或覆盖。正文生成阶段只重跑 writer，原生调度可能另有主模型请求，两者分别计数；阅读稿仍交给 Story Kit 导出。

“继续审批结算”和“继续候选结算”均不调用模型，也不自动写作；结算完成后明确点击“继续已批准事实的写作”。完整步骤见[审批与重新生成用法](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/agent-rp-integration.md#事实审批与两层重新生成)。

将 `dsh-rp-studio-1.6.0.tgz` 放到当前目录。先完全退出 dsh，再在终端执行：

```powershell
dsh plugin --profile desktop add ./dsh-rp-studio-1.6.0.tgz
```

Web 模式请把 `desktop` 改为 `web`。重新打开 dsh，进入任一会话，点击会话顶部的 RP 按钮。新故事沿用 dsh 自己的模型、权限审批和登录状态。

插件在 dsh 内运行，不启动额外服务，不需要复制访问令牌。所有内容通过宿主的认证接口读取；角色配置中的私有字段保持原有过滤规则。

Windows 找不到 `dsh` 命令时，可使用默认官方启动器：

```powershell
$dshCli = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
& $dshCli plugin --profile desktop add ./dsh-rp-studio-1.6.0.tgz
```

安装时核对随包的 SHA256SUMS。完整使用、角色预设和插件搭配见 [原生指南](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/native-usage.md)。

DSH Go 可在已配对的同源网页打开指定故事、正文、事实、档案和所属插件页面。网页在实际显示目标后返回定位确认。RP 助手使用手机原生聊天、独立 `rp-companion` 预设以及 DSH 原生审批。

## RP 助手

Studio 安装包同时提供真正的 `rp-companion` Agent Preset，无需另装助手包。在 `RP ▾ → RP 助手` 打开独立管理草稿，或在新会话的 Agent Preset 中选择“RP 助手”。入口只填入引导，不自动发送；检查目标故事 ID 与需求后发送即可。原故事会话继续使用 `rp-gm`。

桌面助手使用原故事所在的 DSH 工作区。未分组的故事会查找同一目录的已注册工作区。首次打开且尚未注册时，DSH 会登记原有目录，以便启用助手草稿框。

完整使用时，将 Studio、Loop、Story Kit、Database、Context、GM 和 RP 最后一步七包安装到同一个 profile。助手复用各插件的公共业务服务，支持角色与身份创建/编辑、角色卡/世界书/资料/内容包导入、ST 写作预设导入与迁移、写作预设草稿调整、上下文与节点模型配置，以及经 Story Kit 审阅配置开局和读回。某个插件未启用时只报告该能力缺失，不伪造成功。

也可以把外部 RP 会话、SillyTavern JSONL 导出、TXT/Markdown 原文件路径或正文交给助手，例如“把这段会话整理成从最后一幕继续的故事，保留我的玩家身份，补全必要世界设定，先保存”。附件使用宿主实际提供的文件路径；助手只读原件，按需询问续写或重启、分支、玩家身份与补全范围，然后新建角色、身份、世界资料和故事模板。它会分别说明哪些来自原会话、外部资料和创作补全，并读回具名 ID、版本、原开场、初始场景与事实。保存完成不会自动开局，也不等于恢复外部会话的原生日志。原文件和已有资产保留。

文件导入使用正式宿主文件服务读取原始 JSON/PNG/PDF 字节。原始导入留在所属插件；助手不直接改 owner 数据或宿主 profile。管理写入沿用 DSH 的权限审批；非完全访问模式可能出现一次原生批准请求。锁定、必用和默认关闭的模块策略保留，迁移仍交付待审阅草稿；故事事实审批继续默认关闭。更多约束见[助手操作合同](https://github.com/LiweiDonVee/dsh-rp-studio/blob/main/docs/rp-companion.md)。

助手基于 rc.5 的创造模式组成，保留官方组成编辑、插件开发和 API 检查能力，并增加 RP skill、固定管理工具与宿主原生网页检索工具。检索取决于当前模型和实际配置的搜索服务；本地授权资料可先用于查证，公开查询只使用必要题材词，私有会话、原句和原创名称不会自动送往搜索服务。缺少可用检索或资料时会明确列出待补内容。上游许可见随包的 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 从源码构建

在仓库根目录执行 `pnpm install`，然后 `pnpm plugin:package`。产物位于 `packages/plugin/artifacts/`。浏览器入口使用 dsh ModuleLoader，React 由宿主提供；发布包包含已打包的宿主和浏览器代码，无需另行安装仓库内的包。

TGZ 安装和外部目录的 `link:` 安装均受支持。发行包将宿主供应的依赖标为 optional peer，消费安装时不要求另装 DSH SDK；这里的 optional 是安装元数据，RP 助手仍要求宿主提供原生权限服务。

## 验证

`pnpm plugin:test` 运行宿主契约测试。`pnpm plugin:smoke` 使用官方 dsh 启动器及全新的 `.runtime/native-smoke-*` home，安装打包产物、创建合成 RP 预设和会话，并验证入口、全屏、档案导航、窄窗口与关闭重开。它不发送模型 prompt，也不读取现有用户会话。需要 Playwright Chromium（`pnpm exec playwright install chromium`）；可通过 `DSH_BIN` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定启动器及浏览器。测试截图位于 `.runtime/evidence/`。
