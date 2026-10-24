# 通用 Agent Loop Studio

2026-10-24，用户确定第一版分析现有预设、显示真实 loop、配置已识别节点的模型；自由增删节点及连线保留到后续版本，内核现在就与执行适配和 UI 分离。产品是独立 dsh 插件，安装和运行不依赖 RP Studio。

## 第一版能力

从预设注册表读取任意预设的已声明组成和启用状态。通用宿主适配器展示“准备上下文 → 首个模型请求 → 工具执行 → 后续模型请求 → 回合结束”的真实循环；其他插件可以声明自己的模型、工具或程序节点。配置组成、声明的阶段和实际观测的调用分别标明来源，条件条目和未知驱动不猜测成已执行。

模型节点可继承 dsh 当前选择，或选择已注册的 provider/model、支持的推理强度及输出上限。用户可以保存当前会话的覆盖，或该预设的默认配置，且可以关闭接管恢复宿主选择。原始预设和宿主全局模型设置保持不变。首个请求与后续请求分别配置；不靠 step 数猜测“规划”“最终答案”等语义。

原生侧栏由会话入口或右侧导航打开，支持宿主全屏。图上的节点可点选，旁边编辑该节点模型；执行轨迹展示实际模型、步骤、工具名称、状态、耗时及已报告 token。程序和工具节点没有误导性的模型选择框。辅助 LLM 调用只有在能关联到会话和来源时才显示，无法接管的节点标明只观察。

## 内核与执行边界

图定义是有版本的节点/边数据，节点有稳定 ID、类型、来源、控制能力和扩展元数据。策略独立引用节点 ID，轨迹独立引用图版本、会话、回合和步骤。UI 不执行 agent；宿主执行适配器负责观测与公开模型选择扩展点。未来图编辑器可以产生同样的图定义，并由新的执行适配器解释；当前宿主图不接受会改变调度的任意连线。

内核不导入 RP 协议。其他插件可以通过参与接口注册阶段、解析某阶段模型并提交轨迹。RP“最后一步”作为可选参与方；不安装图插件时，RP 自己仍能使用默认配置独立运行。

## 模型接管

使用 agent 作用域的 prompt assembly 和 `agent/request` 瀑布：在装配阶段冻结策略选择，在请求阶段使用同一快照覆盖调用配置。切换提供方时清除不属于新模型的继承推理强度，再让 dsh 的能力解析器校验。不能只改变界面显示，或偷偷重写已经冻结的 loop 请求。

策略顺序为会话覆盖、预设默认、宿主原选择。会话显式关闭可覆盖已开启的预设默认。策略保存有 revision 校验；运行中修改从下一次请求的装配边界生效。插件卸载释放 listener，后续请求恢复原选择。未知驱动保留组成分析，不能标成已接管。

能力与故障继续由宿主验证和报告，第一版不做未经配置的自动模型替换，不复制账号密钥，不启动代理，不要求使用特定模型。所有真实模型调用都来自用户会话；自动验收使用模拟适配器。

## 宿主验证依据

官方 DSH 0.2.1-rc.2 的一次隔离、无密钥探针已在 `standard` 与自定义预设分别执行三个请求：接管到 `probe-cloud/fast`、切换到 `probe-local/quality`、关闭接管后恢复 `probe-cloud/configured`。6 个主 loop 请求的实际路由与 prompt 模型变量一致，日志 request header 同样一致。探针还观测到 2 个辅助标题调用，说明主 loop 路由不能等同于所有插件的 LLM 调用路由。这是扩展点的可行性证据，不是产品已完成的声明。

## 接口约定

独立包位于 `packages/loop-plugin`，包名 `dsh-loop-studio`。`src/core.mjs` 定义图、策略与阶段合并；`src/store.mjs` 保存策略；`src/host.mjs` 连接宿主和参与接口；`src/routes.mjs` 提供认证 API；客户端模块只消费公开 DTO。

`POST /api/loop-studio/request` 使用 `{ action, sessionId, ... }`：

- `inspect`：返回 `revision, selectedPresetId, presets, composition, graph, policies, effectivePolicy, models, trace, running, routingCapability, diagnostics`。
- `savePolicy`：携带 `scope: session|preset, presetId?, expectedRevision, policy`，保存成功后返回 `{revision}`。
- `resetPolicy`：删除该层覆盖，携带相同作用域和 revision，返回 `{revision}`。

`policy` 为 `{ enabled, routes }`，`routes` 按节点 ID 指向 `{provider, model, reasoningEffort?, maxTokens?}`。`host.first`、`host.continuation` 为内置可路由节点。`graph` 为 `{schemaVersion:1,id,nodes,edges}`；节点至少含 `id,label,kind,control,source,description?`，边含 `id,from,to,label?`。`control` 为 `route|observe`，`kind` 为 `model|tool|program`。

`GET /api/loop-studio/events?sessionId=...` 输出 metadata SSE，供当前侧栏刷新；关闭、切换会话和卸载释放订阅。API 由 dsh Connection 认证，读取会话通过 owner Remote 归属边界；不暴露任意 Remote 代理。DTO 不携带工具参数、工具原始输出、推理、密钥或完整提示词。

客户端提供方 `{provider,id,name,reasoning?}`；trace 项至少含 `{id,type,nodeId,timestamp,turn?,step?,seq?,provider?,model?,toolName?,status?,tokens?}`。客户端可以显示宿主未提供用量/时长，不填虚构数据。

## 验收

确定性测试验证策略优先级、revision 冲突、图节点/边 ID 稳定、模型选择和 prompt 变量同源、首步/续步、卸载恢复及跨会话隔离。组件验证点击节点、更改并保存模型、继承/关闭、未知驱动、切换会话晚到响应和事件释放。

实际官方宿主验证安装后的原生入口、标准与自定义预设组成、真实图与模拟模型请求对应、两种提供方之间切换、禁用恢复、全屏和窄窗口。测试不发送付费模型请求。新 tgz 自包含，单独安装不需要 RP Studio。
