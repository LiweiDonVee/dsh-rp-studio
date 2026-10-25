# 原生验收边界

以下记录冻结的证据要求；具体受测版本和实际结果见[验收记录](../native-acceptance.md)。

## 补充 A1 — 用公开证据验收 pending checkpoint 与身份冲突 [FROZEN]

不扩展 StoryKit journalAudit DTO。其公开行仍严格只有 {restoreId,fingerprint,sessionIds,status}；验收不读取私有 journal，也不伪造 createdIds/imported/plugins 或用这些不存在的公开字段作断言。

### 同一任务冷续跑

下列组合足够支持本轮 checkpoint 边界的行为验收：

1. pending 后通过真实 exportState 获得同 restoreId 的审计行，核对完整精确 Session 集合、稳定 fingerprint 与 pending 状态，并保存此次实际输入 snapshot 的字节/内容摘要。公开宿主读取确认目标 Session 已存在且前缀正确；公开 GM binding 仍为 restoring，未报告激活成功。若采集 Agent metadata，区分真实 Agent 存在/idle 与 GM binding.status=restoring，不能造一个 Agent restoring 枚举。
2. 停止旧进程并启动同 home 的新进程；使用完全相同 snapshot 与 restoreId 调用真实 restoreSavedStory。实际 owner/Loop 校验、激活和 complete 均成功，公开目标前缀/绑定正确，直到明确玩家行动前历史模型及事实工具执行为零。
3. 该判断依赖已审查的 T15/T18 产品门：既有 Session 无持久创建归属必须冲突、不能按相同内容认领。因此上述真实冷续跑成功，是已跨过必要持久归属门的行为证据；pending 审计行或 matching prefix 单独都不够。

准确报告用语：“同一恢复任务在目标 Session 已存在且故事仍 gated 的 pending 状态后，跨真实进程重启完成；在已审查的归属门下证明可继续的创建归属已持久化。”不得写成“直接读取 createdIds checkpoint”或据此断言 imported/plugins 的内部进度。此验收不证明 T15 的未记录窗口可自动恢复，也不精确定位内部每一步落盘时刻。

### 新任务遇到占用身份

真实新 restoreId 返回 RESTORE_ID_CONFLICT；其前后公开 journalAudit 均没有该 restoreId；所有被占用目标的 header/events、相关 owner binding/revision 与历史执行计数保持不变。这组证据足够表述：“该新任务未建立可观察的恢复归属或改写占用故事。”审计无行本身不是单独证明，须与实际拒绝及目标不变结合；不声称读取了私有 ownership map。

沿用既有真实公开方法与只读 metadata 载体即可。无需新增 owner API/字段，也无需为观察 checkpoint 改产品实现。已成立任务的 snapshot/fingerprint 不可变规则照常适用。

## 补充 A2 — 回退后的冷继续只结算新行动 [FROZEN]

R25 验收除 cold resume 历史调用为零外，必须发送一次明确新行动，检查实际新增 rp_commit_turn 和接受正文各一次；被撤行动的 MessageId/source.rpcId 不得再次被领取或成为新的 user/message。实例 seq174 的 inbox insertion 必须在 fork 前缀之外，不能只检查 turn/start 被排除。多队列/提前排队无法用单个合法前缀隔离时，ROLLBACK_UNAVAILABLE 且不创建 child 是正确结果。不得削减计数、清私有 inbox 或改 fixture 消除真实重复。
