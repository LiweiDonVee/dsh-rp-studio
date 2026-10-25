# 原生 RP Studio 使用指南

## 安装与升级

已验证 DSH 0.2.1-rc.2。下载 [RP Studio 1.2](https://github.com/LiweiDonVee/dsh-rp-studio/releases/tag/v1.2.0) 中的 tgz，完全退出 DSH 后用 `dsh plugin --profile desktop add ./dsh-rp-studio-1.2.0.tgz` 安装，再重新启动。Web 模式改为 `--profile web`，升级时安装新版本。

发布包自包含，无需构建本仓库、安装 Electron、启动 Gateway 或复制 token。主 README 给出了找不到 `dsh` 命令时的 Windows 启动器路径。校验文件与安装包位于同一 Release。

## 打开工作区

已有会话点击顶部 **RP**，空白会话在输入区上方找到 RP。也可通过右侧新增页签导航打开 **RP Studio**。宽度拖动、全屏和关闭由 DSH 管理，界面沿用宿主主题。

| 页面 | 用途 |
| --- | --- |
| 角色与剧情 | 查看公开场景、主角、目标、关系、任务、物品与记忆 |
| 沉浸阅读 | 阅读玩家与 GM 内容，发送行动、停止、回退、分支与自动续写 |
| 故事档案 | 从已安装的可玩 RP 预设开始故事，或继续已有旅程 |

Studio 展示已有 RP 数据，不生成角色卡或补建模拟引擎。没有角色预设的新安装可以是空白状态，不会自动下载私人世界或角色。

## 为什么档案里没有角色

安装并启用兼容的可玩 RP 预设后，档案才能列出角色。Studio 从宿主读取可用预设及 bundle，通过受支持的 RP 运行时标记或兼容的 RP 元数据识别；损坏、不可读或无 RP 标记的普通预设不会作为故事卡展示。基础 `rp-runtime` 模板不作为新故事卡展示，但可用于恢复已有历史。新版原生路径不要求 Studio 直接扫描本地 `rp-card.json`。

仅安装提示词模块库或最后一步插件不等于安装可玩角色。请保留现有 RP 预设的事实与状态工具，或另行安装自己的角色预设。

## 插件如何搭配

各项目在不同仓库开发，版本化安装包分别下载：

```powershell
dsh plugin --profile desktop add ./dsh-rp-studio-1.2.0.tgz
dsh plugin --profile desktop add ./dsh-loop-studio-0.1.0.tgz
dsh plugin --profile desktop add ./dsh-rp-last-step-0.2.0.tgz
dsh plugin --profile desktop add ./dsh-rp-database-0.1.0.tgz
dsh plugin --profile desktop add ./dsh-rp-context-0.1.0.tgz
```

按需安装，安装前退出 DSH，完成后重启。需要联动的包必须装在实际使用的同一 profile。

- **RP Studio** 负责阅读和已安装 RP 预设的故事入口。
- [**Loop Studio**](https://github.com/LiweiDonVee/dsh-loop-studio) 负责通用流程观察与节点模型配置，普通 Agent 也能使用。
- [**RP 最后一步**](https://github.com/LiweiDonVee/dsh-rp-last-step) 负责 ST 预设适配、用户锁、热组装和最终正文，不接管既有模拟/结算。
- [**RP Database**](https://github.com/LiweiDonVee/dsh-rp-database) 负责可复用资料、会话覆盖、人类策略，以及关键词／向量／重排检索；人物知情使用叙事备注。
- [**RP Context**](https://github.com/LiweiDonVee/dsh-rp-context) 让中间 GM 搜索候选之外的资料并整理历史材料，默认近轮全文、旧轮摘要，能主动展开或折叠原文。

安装最后一步后，Studio 故事页增加“故事预设”入口。导入、自建、迁移、保存并应用可用模块版本后，主 Agent 处理本轮事实，再以唯一终止工具 `rp_present` 进入独立正文调用。终止呈现要求原生工具模式，纯 PTC 仍可迁移和预览。

绑定最后一步期间，主 Agent 的处理文字不会成为 GM 旁白；Studio 接收安全正文流，规范结果确认后成为可回放叙事。历史普通故事继续按原有方式显示。独立生成记录页保存稿件档案，当前分支以 Studio 故事页为准。

Loop 页可分别配置迁移、热组装和最终正文所用模型，包括已经在 DSH 接入的本地模型。模型配置的详细作用域、继承和运行边界见 Loop 文档。

安装 Context 后，还可分别路由中间 GM 和历史摘要模型。数据库的 embedding/rerank 是类型化检索接口，按 Database 文档配置本地或远程兼容服务；未配置时明确显示降级。当前历史窗口作用于中间 GM 和 writer，不改写 DSH 主 Agent 的冻结请求。

## 常见问题与数据

**入口不见了**：先确认安装 profile 与当前启动 profile 相同，完全重启，再看新增页签导航。

**故事页没有状态**：检查原有 RP 预设是否提供支持的公开状态；Studio 不通过正文猜测私有数值。

**最后一步失败后正文消失**：失败的临时稿不作为已提交叙事。检查预设编译和模型，不要为重写正文重复运行已完成的状态工具。

**原生插件需要备份什么**：故事会话由 DSH 管理，使用 DSH 的备份/导出路径。最后一步的预设与稿件另在 `app-data/rp-last-step`，Loop 策略在 `app-data/loop-studio`。先退出 DSH 再备份，不直接修改 Session 日志。

报告问题时提供 DSH/插件版本、profile、可复现步骤和合成示例。去掉访问 token、密钥、私有角色卡和会话。测试边界见 [原生验收](native-acceptance.md) 与 [联动验收](rp-last-step-acceptance.md)。
