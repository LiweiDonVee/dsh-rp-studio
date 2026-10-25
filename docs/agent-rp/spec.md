> Public copy of the frozen development design. See [status and versions](README.md); complete native acceptance is a separate gate.

# P1–P6 approved implementation design

范围：P1–P6 文本 Agent RP；P7 媒体排除。这是冻结的开发合同，新接口不代表已发布或已通过完整原生验收。

## 产品结果

1. 普通用户在原生侧栏导入/创建角色与persona，选择开场和资料版本，经一个通用GM开始故事，不编写每卡runtime。
2. 主GM读取资料并一次提交事实；中间模型只整理材料；writer只呈现。人类锁、来源版本、回退与分支一致。
3. 用户能查看真实冻结输入、写下一轮作者注、重试失败正文、生成/编辑末轮候选并采用。采用必须同时改变有效主历史和后续材料，不能仅UI换字。
4. 多库和文件资料有来源限定引用，持久索引可重建。内容包可分享，正式阅读稿可导出。
5. 完整存档使用当前宿主已证明的公开精确ID恢复路径，完成跨home冷读/重启/分支测试后才声称支持；冲突不覆盖，不发明自动重映射。

## 数据所有者

Database：不可变来源、多库绑定、会话事实/工作资料、因果覆盖、事实回执、文档与索引。
GM：通用运行协议、启动/绑定元数据、事实提交语义；没有第二份世界真值。
StoryKit：原始角色/PNG/persona/开场/创作模板、导入诊断、内容包/恢复协调。
Context：正式历史表示、摘要缓存、选材计划、作者注；不是第二个事实裁判。
LastStep：模块权限/冻结输入、原始正文receipt、候选稿、合法采用与材料检查。
Studio：统一原生游玩/阅读/操作入口，兼容旧故事；Loop继续已有模型路由，无新增执行器。

## 硬边界

不做NPC知识ACL、每NPC多Agent、全世界数值模拟、自由graph、执行导入脚本、擅自改主请求或私有日志。任意自然语言事实正确性仍由GM/人类判断；程序只承诺实际实现的结构、权限、来源与事务保证。

Database中的gm.scene/gm.facts是少量阶段所有权保护条目，不是知识分级。材料阶段不能改这些refs，仍能改其他获准资料/备注。事实批次和回执同事务持久化，正文失败后不重复结算。

## 现有与新增

现有源库/原件/用户锁、ST世界书JSON兼容、现有失败冻结重试、原生reader、Loop路由、Context摘要窗口全部保留。新项目补通用GM、完整角色资产、草稿采用、多库/文件索引、作者注与可迁移内容；不重复实现已发布能力。

## 当前宿主约束

实测官方DSH为0.2.1-rc.3；参考源码为rc.2。动态共享preset、真实第一轮开场、公开commands/execute与精确IDpersistence恢复已有探针证据。

两条负例不得使用：空Session直接user/message开场冷恢复缺protected system head；idle直接tool/result替换冷恢复失败outside open turn。

采用方案使用公开followup启动真实维护回合，在限定pre-step里content-only replacement后reject结束，事实/模型不重跑。宿主把这个无生成维护回合记为blocked，这个事实保留，产品的采用成功另行确认。保留旧meta，通过有效content和规范来源读取当前稿；必须跨home冷恢复通过。

## UI与依赖

所有功能在原生可拉出面板，单包自身面板可用；Studio只是统一入口。必需服务缺失时仅阻止对应动作，不能让整个库面板不可用。依赖版本与发布号见 [版本矩阵](versions.md)。

## 验收出口

公开合成故事：导入PNG→persona/开场→正常首轮→事实一次提交→真实HTTP检索与候选外搜索→准备/写作→失败仅writer重试→候选采用→下轮摘要使用采用稿→fork/rollback/restart一致→文件增量索引→内容包新环境开局→存档精确恢复后继续/回退。

每项必须提供实际调用/状态证据；mock证明工程合同，不宣称真实模型文学质量。无媒体目录/仓库/隐藏scope。完整原生验收与正式发布分别记录。
