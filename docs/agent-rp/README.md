# Agent RP 冻结设计

这里记录 P1–P6 文本 Agent RP 的冻结公开接口与职责，供 RP Studio 1.3 和配套插件使用。原生验证使用官方 DSH 0.2.1-rc.3 与实际安装包；模型服务替身、静态 rc.2 参考源码及 live append 都不能替代冷恢复证据。具体受测字节与执行结果见[验证记录](../native-acceptance.md)。

- [范围与职责](spec.md)
- [版本和能力矩阵](versions.md)
- [Database 来源、事实与回执](contracts.md)
- [GM、正文、候选、作者注](contracts-runtime.md)
- [Story Kit 与内容包](contracts-story-kit.md)
- [文档、完整存档与恢复](contracts-transfer.md)
- [Studio 固定操作、能力和原生页签](contracts-studio.md)
- [Studio 1.3 使用与验证边界](../agent-rp-integration.md)

每个 owner 负责自己的存储、授权、修订冲突和因果投影。Studio 仅消费这些合同。公开副本保留方法签名、字段、错误码、版本、所有权和验收边界；产品能力必须按实际实现检测。
