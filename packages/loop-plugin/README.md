# DSH Loop Studio

独立的 DSH 0.2.1-rc.2 原生插件，用图形查看预设的组成和实际 agent loop，并为支持的模型节点配置不同 provider/model。无需安装 RP Studio。

## 安装

完全退出 dsh 后执行：

```powershell
dsh plugin --profile desktop add ./dsh-loop-studio-0.1.0.tgz
```

Web 模式将 `desktop` 换为 `web`。重新启动后，从会话的 Loop 按钮或右侧新增页签导航打开。空白会话也有入口。侧栏的宽度和全屏由宿主管理。

## 查看与配置

- 查看预设声明的插件、启用状态和已观测的请求/工具轨迹。
- 点选模型节点，为首个请求和后续请求分别选择提供方、模型及支持的参数。
- 将配置保存为当前会话覆盖或所选预设默认；恢复继承或关闭接管。
- 轨迹展示实际使用模型和已报告的用量；程序与工具节点只观察。

原始预设与宿主全局默认模型不会被改写。当前版本接管经过验证的 dsh 内置 agent-loop；未识别驱动仍可分析组成，界面标明模型接管能力。标题生成等辅助调用使用自己的宿主机制，不能把主循环的路由当成所有 LLM 调用的路由。

模型来自 dsh 已注册的 provider，包括已接入的本地模型。插件不复制密钥，不另起代理，不根据名字猜测价格或质量，也不在失败后擅自切换模型。

第一版保留宿主执行顺序。图定义、策略、轨迹与执行适配分离，为后续可编辑流程做准备；当前图上的连线用于解释实际 loop，不会改写原预设的调度。

## 构建和验证

仓库根目录使用 Node 24 / pnpm 11：

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
pnpm install
pnpm loop:test
pnpm loop:package
pnpm loop:smoke
```

产物：`packages/loop-plugin/artifacts/dsh-loop-studio-0.1.0.tgz`。真实宿主验收使用官方 dsh 启动器、隔离测试 home 和模拟模型适配器，不发送付费请求，不修改已有用户配置。Playwright 需要 Chromium，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定已有浏览器；`DSH_BIN` 可指定 dsh 启动器。截图与验收结果位于 `.runtime/loop-evidence/`。

## 架构

`src/core.mjs` 负责可序列化图和策略；`store.mjs` 负责配置版本；`host.mjs` 负责宿主适配和参与接口；`routes.mjs` 负责经过宿主认证的 API；React 视图只消费公开元数据。RP“最后一步”是独立部分，可作为阶段参与方联动。

## 给其他插件接入节点

使用可选的 `ctx.get('loopStudio')`，无需引入 RP 包：

```js
const studio = ctx.get('loopStudio')
const unregister = studio?.registerParticipant({
  id: 'example',
  nodes: [{ id: 'review', label: '复核', kind: 'model', control: 'route' }],
  edges: [{ id: 'finish', from: 'review', to: 'host.end' }],
})
const route = studio?.resolveRoute({ sessionId, nodeId: 'example.review' })
// 在自己的实际调用边界消费 route；为空时使用该插件原配置。
studio?.recordTrace({ sessionId, nodeId: 'example.review', provider, model, status: 'completed' })
// 插件卸载时调用 unregister。
```

节点 ID 自动加参与方命名空间。注册连线只声明来源，不代替插件执行；开放模型配置的参与方需要在真实调用中消费该路由。

运行中卸载会停止接收新工作，并让已装配的调用按其冻结配置收尾。原请求配置在当前 agent 空闲后有条件恢复；到达空闲边界前，已经排队的工作可能沿用上一配置。用户在此期间做出新模型选择或修改配置时，插件不覆盖新选择。
