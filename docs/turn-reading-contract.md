# 已确认回合的只读投影

Studio 的固定 `POST /api/rp-studio/actions` 操作继续使用现有会话授权。`readingPage` 与 `turnDetails` 共享 `packages/plugin/src/turn-reading.mjs`，需要 LastStep API 1、`narrativeRevisions:1` 和真实 `storyHistory` 方法；详情还需要 `material`。能力由 `capabilities.actions` 返回。

`readingPage({sessionId,before?,limit?})` 默认读取最近 8 个已确认回合，单次最多 20 个。limit 为正安全整数，超过 20 时取 20。before 只有三个字段 `{projectionKey,callSeq,presentationId}`，表示不含该回合的前一页。响应：

```js
{
  schemaVersion: 1,
  projectionKey,
  records, // 本页按旧到新，保留完整已确认正文
  hasOlder,
  nextBefore: null, // 或下一页的 before
  totalCount
}
```

records 只取 LastStep 有效历史中已选择的版本，保留 `id,ref,turn?,action,text,actionSource?,factReceiptId?,createdAt?,narrativeVersion?` 的已知字段。不会加载草稿或折叠版本来补页。游标必须同时匹配当前 projectionKey 与完整位置；投影改变或位置消失返回 `409 STALE_READING`。

`turnDetails({sessionId,basedOn})` 要求完整的 LastStep NarrativeRef：

```js
{
  sessionId,
  presentationId,
  assistantMessageId,
  callSeq,
  baseResultSeq,
  resultSeq
}
```

basedOn.sessionId 必须等于显式目标 sessionId，callSeq < baseResultSeq <= resultSeq。宿主先验证该完整引用仍在有效历史内，才读取对应 material；等待后再次验证，拒绝已被改写、回退或替换的引用。子故事必须使用子故事自己的已验证 ref；材料中的真实祖先历史来源仍按原值保留。失败为 `409 NARRATIVE_CONFLICT`。

响应为：

```js
{
  schemaVersion: 1, projectionKey, ref,
  record: { id, ref, turn?, action, text, createdAt?, textTruncated, actionTruncated },
  publicChanges: {
    source: 'frozen-packet', available,
    resolvedChanges, visibleConsequences, openHooks, publicFactRefs,
    factReceiptRef?, truncated
  },
  context: { available, entries, history, entriesCount, historyCount, truncated },
  provenance: { status?, models, contextModels, steps?, chars? }
}
```

详情正文最多 2,000 字符、行动最多 1,000 字符；公开变化每组最多 20 项，每项 500 字符。entries/history 各最多 32 项，并报告原始数量。entries 仅包含 `id?,key?,title?,version?,mode?,readOnly?,ref?`，title 最多 160 字符，ref 仅 `sourceKey?,databaseId?,entryId?,databaseVersion?,version?`。history 仅 `id,mode,source`，source 仅 `sessionId?,assistantMessageId?,callId?,presentationId?,callSeq?,baseResultSeq?,resultSeq?`。不传资料或历史正文、备注、检索候选、编译提示词、作者注、guidance 或任意源扩展字段。

provenance.models 只有冻结 assemble/render 配置，contextModels 只有 prepare/summarize 配置，各自仅 provider/model/reasoningEffort?/maxTokens?。没有记录的时间、token 或推理过程不补造。冻结 receipt 缺失时，保留已验证的正文摘录，publicChanges.available 和 context.available 为 false，不读取当前 GM/数据库来补齐。

独立助手固定 inspect 操作 `story.turnDetails` 使用相同 `{sessionId,basedOn}` 与相同响应投影，外层仍为 `{domain,operation,target,result}`。它保留真实 rp-companion composition 作用域检查与目标会话授权。读取不调用 apply、模型、审批或写入；建议与明确应用保持独立。

`authorNoteState({sessionId})` 返回 `{schemaVersion:1,revision,note}`，只投影 Context 当前 state 的 revision 与 authorNote。保存时 `setAuthorNote` 的 expectedRevision 使用此 aggregate revision，不能使用 note.version。旧 authorNote 操作继续返回原始 note/null。

`forkStory({sessionId})` 只调用 GM 的固定公开 forkStory，返回原 owner `{sessionId,binding}`。不接受任意 atSeq。仅开放给已打开、非 running、active、无待审核事实且当前事实已有有效正文的故事；冷故事或未完成状态明确拒绝。原 owner 继续校验真实父子来源和继承前缀。这个写操作没有加入 Companion apply。

`forkStoryAtReading({sessionId,basedOn})` 是独立写操作，要求 GM API 1、`capabilities.forkStoryAtReading:1` 和真实同名方法。它仍走相同的会话授权与完整六字段引用校验，不接受 `atSeq`，不回落到旧 `forkStory`。GM 返回 `{sessionId,binding,parentSessionId,basedOn,branchRef}`；branchRef 只把 basedOn.sessionId 换成新 sessionId。阅读器只对当前有效历史中已采用的正式正文显示“从这一幕另走”，核对源会话、binding.sessionId、basedOn 和 branchRef 后才导航。所选正文过期、切换故事或回执不符时不导航；旧版“分支”入口保留原语义。GM 的 `INVALID_NARRATIVE_REF`、`NARRATIVE_CONFLICT`、`READING_FORK_UNAVAILABLE` 等稳定错误由 UI 展示。

`suggestPlayerActions({sessionId,basedOn,instruction?})` 是可选操作，响应严格为 `{sessionId,basedOn,options:[{text},{text}]}`。能力要求有效正文与冻结材料读取、当前故事已解析模型和宿主公开 LLM 服务。只在用户点击“陪我想下一步”时执行一次 `prepareCall` / `prepared.stream`，沿当前故事请求配置叠加已有 `rp-last-step.render` 路由；不新建模型设置，不回落全局默认模型。每次输出上限 1,024 tokens，两个不同的行动文本各最多 500 字符。输入只包含所选正式正文最后 5,000 字符、冻结公开后果与线索，以及可选用户要求，不读取私有资料、作者注或宿主对话历史，也不提供工具。生成前取一次有效历史与对应公开材料，生成后再次验证所选引用仍为最新正式正文；过期返回 `409 NARRATIVE_CONFLICT`，模型失败不自动重试。

工作区只在行动输入附近提供一个建议入口，复用阅读器已读到的最新正式正文引用与能力，不为移动入口增加后台取材。按钮由用户明确点击，显示两个可编辑选项。选择只追加当前故事的行动草稿，保留已有文字；Enter 发送与 Shift+Enter 换行不变。响应、编辑后的选项与当前六字段引用必须一致；跨故事、正文修订或在途请求失效后不能写入草稿。“问 RP 助手”继续保留独立的依据查询路径。

每幕的操作条位于正文前，在该幕阅读范围内停留于视口上沿。依据与其他写法在阅读视口旁的同一个面板中打开，只在用户点击后挂载对应读取组件，不在长正文末尾插入面板。打开、切换和关闭工具保留阅读位置，关闭使用 preventScroll 恢复原按钮焦点；工具固定完整所选引用，正文变化后不暗中换成其他版本。历史旁支确认后明确打开子故事的沉浸阅读，原有回退、旧分支和显式移动端定位维持其原去向。

桌面归档先展示继续故事，再展示新开局和旧角色预设。同一 RP Studio 客户端挂载期间，成功打开沉浸阅读会记下该故事 ID；归档仅在现有候选列表仍包含该 ID 时提供“继续上次故事”。这份记忆只在当前挂载期间存在，不写入浏览器持久键，不额外读取主机。其余故事按真实更新时间标注“最近更新”，同名故事展示候选中可区分的会话标识与父故事关系。所有继续操作都需要用户点击；当前会话、明确的视图导航与移动端深链不会被记忆自动替换。空白会话中的“开始新故事”直接打开现有 Story Kit 的 start 页面。
