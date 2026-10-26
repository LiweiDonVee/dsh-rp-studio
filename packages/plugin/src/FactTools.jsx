import React, { useEffect, useRef, useState } from 'react'

const errorText = error => `${error.code ? `${error.code}：` : ''}${error.message}`
const copy = value => structuredClone(value)
const lines = value => value ? value.split('\n') : []
const packetLists = { resolvedChanges: '已经解决的变化', visibleConsequences: '可见后果', openHooks: '未决线索', proseConstraints: '写作约束', publicFactRefs: '公开事实引用' }
const pendingReview = review => !!review?.latestRound?.pendingCandidateId || ['recorded', 'interrupted'].includes(review?.pendingDecision?.status) || review?.generation?.status === 'running'

function World({ value, compare }) {
  if (!value) return <p>未取得当前事实，请刷新所属服务。</p>
  return <><p>{value.scene.title} · {value.scene.location}{value.scene.time ? ` · ${value.scene.time}` : ''}</p><p>在场角色：{value.scene.presentActorIds.join('、') || '无'}</p>
    <ul>{value.facts.items.map(item => <li key={item.id}>{item.text}{compare && (compare.facts.items.find(old => old.id === item.id)?.text !== item.text) && <span className="rp-fact-change"> · {compare.facts.items.some(old => old.id === item.id) ? '已修改' : '新增'}</span>}</li>)}</ul>
    {compare?.facts.items.filter(item => !value.facts.items.some(next => next.id === item.id)).map(item => <p key={item.id} className="rp-fact-change">移除：{item.text}</p>)}
  </>
}

function CustomFields({ value, onChange, variables, onVariables }) {
  const scene = (key, next) => onChange({ ...value, scene: { ...value.scene, [key]: next } })
  const packet = (key, next) => onChange({ ...value, packet: { ...value.packet, [key]: next } })
  const items = next => onChange({ ...value, facts: { schemaVersion: 1, items: next } })
  const variable = (index, key, next) => onVariables(variables.map((entry, at) => at === index ? key === 'name' ? [next, entry[1]] : [entry[0], next] : entry))
  return <fieldset className="rp-custom-facts"><legend>自定义场景、事实与公开方向</legend>
    <label>场景标题<input aria-label="场景标题" value={value.scene.title} onChange={event => scene('title', event.target.value)} /></label>
    <label>场景地点<input aria-label="场景地点" value={value.scene.location} onChange={event => scene('location', event.target.value)} /></label>
    <label>场景时间<input aria-label="场景时间" value={value.scene.time ?? ''} onChange={event => scene('time', event.target.value)} /></label>
    <label>在场角色 ID（每行一项）<textarea aria-label="在场角色 ID" value={value.scene.presentActorIds.join('\n')} onChange={event => scene('presentActorIds', lines(event.target.value))} rows={2} /></label>
    <div className="rp-fact-items">{value.facts.items.map((item, index) => <section key={index}>
      <label>事实 {index + 1} 标识<input aria-label={`事实 ${index + 1} 标识`} value={item.id} onChange={event => items(value.facts.items.map((row, at) => at === index ? { ...row, id: event.target.value } : row))} /></label>
      <label>事实 {index + 1} 内容<textarea aria-label={`事实 ${index + 1} 内容`} value={item.text} onChange={event => items(value.facts.items.map((row, at) => at === index ? { ...row, text: event.target.value } : row))} rows={2} /></label>
      <button type="button" onClick={() => items(value.facts.items.filter((_row, at) => at !== index))}>移除事实 {index + 1}</button>
    </section>)}</div>
    <button type="button" onClick={() => items([...value.facts.items, { id: '', text: '' }])}>添加事实</button>
    <label>事实摘要<textarea aria-label="事实摘要" value={value.summary} onChange={event => onChange({ ...value, summary: event.target.value })} rows={2} /></label>
    <label>玩家行动<textarea aria-label="玩家行动" value={value.packet.playerAction} onChange={event => packet('playerAction', event.target.value)} rows={2} /></label>
    <label>场景方向<textarea aria-label="场景方向" value={value.packet.sceneInstruction ?? ''} onChange={event => packet('sceneInstruction', event.target.value)} rows={2} /></label>
    {Object.entries(packetLists).map(([key, label]) => <label key={key}>{label}（每行一项）<textarea aria-label={label} value={(value.packet[key] ?? []).join('\n')} onChange={event => packet(key, lines(event.target.value))} rows={2} /></label>)}
    {variables.map(([name, text], index) => <div className="rp-variable" key={index}><label>变量 {index + 1} 名称<input aria-label={`变量 ${index + 1} 名称`} value={name} onChange={event => variable(index, 'name', event.target.value)} /></label><label>变量 {index + 1} 内容<input aria-label={`变量 ${index + 1} 内容`} value={text} onChange={event => variable(index, 'text', event.target.value)} /></label><button type="button" onClick={() => onVariables(variables.filter((_entry, at) => at !== index))}>移除变量 {index + 1}</button></div>)}
    <button type="button" onClick={() => { let number = 1; const used = new Set(variables.map(([name]) => name)); while (used.has(`variable${number}`)) number++; onVariables([...variables, [`variable${number}`, '']]) }}>添加公开变量</button>
    <p className="rp-note">这些字段将按你的输入校验并采用。已经执行的工具结果保持固定。</p>
  </fieldset>
}

export function FactTools({ sessionId, client, running, currentWorld, ownerRevision = '', onPause, onChanged }) {
  const [data, setData] = useState({ flags: {}, review: null, latest: null, summaries: null })
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [cancelling, setCancelling] = useState(false)
  const [tick, setTick] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState(null), [custom, setCustom] = useState(null), [editing, setEditing] = useState(false)
  const [variableRows, setVariableRows] = useState([])
  const [factInstruction, setFactInstruction] = useState(''), [writerInstruction, setWriterInstruction] = useState('')
  const [retained, setRetained] = useState(null), [decisionResult, setDecisionResult] = useState(null)
  const live = useRef(true), operation = useRef(null), cancelOperation = useRef(null), selection = useRef(null), editVersion = useRef(0), loadVersion = useRef(0)
  useEffect(() => { live.current = true; return () => { live.current = false; operation.current?.abort(); cancelOperation.current?.abort() } }, [])
  useEffect(() => {
    if (typeof client.action !== 'function') { setLoading(false); return }
    const controller = new AbortController(), version = ++loadVersion.current
    const current = () => live.current && !controller.signal.aborted && version === loadVersion.current
    setLoading(true)
    void (async () => {
      try {
        const { actions: flags } = await client.action('capabilities', { sessionId }, controller.signal)
        const next = { flags, review: null, latest: null, summaries: null }
        const reads = ['reviewState', 'storyHistory', 'presentationSummaries'].filter(method => flags[method])
        const values = await Promise.allSettled(reads.map(method => client.action(method, { sessionId }, controller.signal)))
        if (!current()) return
        for (let index = 0; index < reads.length; index++) {
          if (values[index].status === 'rejected') { setError(errorText(values[index].reason)); continue }
          const value = values[index].value
          if (reads[index] === 'reviewState') next.review = value
          if (reads[index] === 'storyHistory') next.latest = value.records.at(-1) ?? null
          if (reads[index] === 'presentationSummaries') next.summaries = value
        }
        setData(next)
        const round = next.review?.latestRound
        if (!selection.current && round) {
          const candidate = round.candidates.find(item => item.id === round.pendingCandidateId && item.generationConfirmed !== false)
          if (candidate) { selection.current = candidate; setSelected(copy(candidate)); setCustom(copy(candidate.payload)); setVariableRows(Object.entries(candidate.payload.packet.variables ?? {})) }
        }
      } catch (cause) { if (current()) setError(errorText(cause)) }
      finally { if (current()) setLoading(false) }
    })()
    return () => controller.abort()
  }, [sessionId, client, running, ownerRevision, tick])
  const { flags, review, latest, summaries } = data
  const round = review?.latestRound, generation = review?.generation, intent = review?.pendingDecision
  const pending = pendingReview(review)
  const blocked = pending || busy || loading && !!currentWorld && typeof client.action === 'function'
  useEffect(() => { onPause?.(blocked); return () => onPause?.(false) }, [blocked, onPause])
  if (typeof client.action !== 'function') return null
  const refresh = () => { setTick(value => value + 1); onChanged?.() }
  function choose(candidate) { selection.current = candidate; editVersion.current++; setSelected(copy(candidate)); setCustom(copy(candidate.payload)); setVariableRows(Object.entries(candidate.payload.packet.variables ?? {})); setEditing(false); setNotice('') }
  const variableError = new Set(variableRows.map(([name]) => name)).size !== variableRows.length ? '公开变量名称重复。请为每一行使用不同名称；各行内容已保留。' : ''
  const matches = selected && round && selected.roundId === round.roundId && selected.id === round.pendingCandidateId
  const reserved = !!intent && ['recorded', 'interrupted'].includes(intent.status)
  const unavailable = busy || loading || running || generation?.status === 'running'
  const canDecide = matches && round.latest && !reserved && !unavailable && !!flags.decideFacts && selected.generationConfirmed !== false
  async function run(method, input, identity, prior) {
    if (operation.current) return
    const controller = new AbortController(), version = editVersion.current, candidateId = selection.current?.id
    const request = prior ?? { method, input: copy(input), kind: identity }
    operation.current = controller
    setRetained(request); setBusy(true); setError(''); setNotice('')
    try {
      const result = await client.action(method, input, controller.signal)
      if (!live.current || controller.signal.aborted) return
      setRetained(null)
      const decision = result.decision ?? (result.presentation ? result : null)
      if (decision) {
        setDecisionResult(decision)
        setNotice(decision.status === 'cancelled' ? '本次候选已取消，已生效事实保持当前状态。' : decision.presentation.status === 'complete' ? '事实已生效，正文已完成。' : `事实已生效，${decision.presentation.status === 'failed' ? '写作失败' : '等待继续写作'}${decision.presentation.errorCode ? `（${decision.presentation.errorCode}）` : ''}。`)
      } else if (method === 'configureReview') { setData(previous => previous.review && result.revision < previous.review.revision ? previous : { ...previous, review: { ...previous.review, ...result } }); setNotice(result.enabled ? '本故事事实审批已开启。' : '本故事事实审批已关闭；已等待的候选仍需处理。') }
      else if (method === 'regenerateProse') setNotice(result.status === 'complete' ? '新的正文已完成，旧版本保留审计。' : `写作${result.status === 'failed' ? '失败' : '中断'}；先前有效正文保留。${result.errorCode ?? ''}`)
      else setNotice(result.job?.status === 'cancelled' ? '事实生成已取消，当前事实保持不变。' : '候选操作已返回，请确认待审候选。')
      if (editVersion.current !== version || selection.current?.id !== candidateId) setNotice(previous => `${previous} 后续编辑与当前选择已保留。`)
      refresh()
    } catch (cause) { if (live.current && !controller.signal.aborted) { setError(`${errorText(cause)} 当前草稿与操作编号已保留。`); setTick(value => value + 1) } }
    finally { if (operation.current === controller) operation.current = null; if (live.current) setBusy(false) }
  }
  const operationId = () => globalThis.crypto.randomUUID()
  const decide = action => {
    if (action === 'custom' && variableError) return
    const payload = action === 'custom' ? copy(custom) : null
    if (payload && (payload.packet.variables !== undefined || variableRows.length > 0)) payload.packet.variables = Object.fromEntries(variableRows)
    void run('decideFacts', { sessionId, roundId: round.roundId, candidateId: selected.id, action, ...(payload ? { custom: payload } : {}), operationId: operationId(), expectedRoundVersion: round.version, expectedDatabaseRevision: review.databaseRevision }, 'decision')
  }
  const regenerate = () => void run('regenerateFacts', { sessionId, roundId: round.roundId, operationId: operationId(), expectedRoundVersion: round.version, ...(factInstruction ? { instruction: factInstruction } : {}) }, 'generation')
  const localApplied = decisionResult?.status === 'approved' && decisionResult.presentation.status !== 'complete' && decisionResult.roundId === round?.roundId && decisionResult.factReceiptId === round.activeReceiptId ? decisionResult : null
  const applied = intent?.status === 'applied' ? intent : localApplied
  async function cancelGeneration() {
    if (cancelOperation.current || !generation) return
    const controller = new AbortController(); cancelOperation.current = controller; setCancelling(true)
    try { await client.action('cancelFactGeneration', { sessionId, jobId: generation.id }, controller.signal); if (live.current) refresh() }
    catch (cause) { if (live.current && !controller.signal.aborted) setError(errorText(cause)) }
    finally { cancelOperation.current = null; if (live.current) setCancelling(false) }
  }
  const staged = generation && round?.candidates.find(candidate => candidate.id === generation.candidateId && candidate.roundId === generation.roundId && (candidate.operationId === undefined || candidate.operationId === generation.operationId))
  const currentJob = staged && round.latest && round.roundId === generation.roundId && !intent
  const unsettledJob = currentJob && (round.pendingCandidateId === staged.id || staged.generationConfirmed === false)
  const completeNeedsDecision = generation?.status === 'complete' && unsettledJob && staged.generationConfirmed !== false && round.pendingCandidateId === staged.id && round.approvalRequired === false && round.canRegenerate
  const recoverableJob = unsettledJob && ['interrupted', 'failed', 'cancelled'].includes(generation.status) || completeNeedsDecision
  const generationResume = recoverableJob ? generation.operationId : !generation && retained?.kind === 'generation' ? retained.input.operationId : null
  return <section className="rp-owner-tools rp-fact-tools" aria-label="事实审批与重新生成">
    <h3>事实审批与重新生成</h3>
    {loading && <p role="status">正在读取事实审批状态…</p>}
    {error && <p role="alert" className="rp-tool-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {retained && <p>保留操作：{retained.input.operationId || retained.method}{retained.input.candidateId ? ` · 原候选 ${retained.input.candidateId}` : ''}</p>}
    <label className="rp-review-toggle"><input type="checkbox" aria-label="本故事事实审批" checked={review?.enabled === true} disabled={!review || !flags.configureReview || unavailable} onChange={event => { if (review && !unavailable) void run('configureReview', { sessionId, enabled: event.target.checked, expectedRevision: review.revision }, 'settings') }} />本故事事实审批</label>
    <p className="rp-note">默认关闭。开启后先确认事实，再继续写作；已经等待审批的候选保留原审批策略。</p>
    {!flags.reviewState && !loading && <p>事实审批不可用，请检查 GM 与 Database 的对应能力。旧故事入口仍可使用。</p>}
    <button type="button" disabled={busy} onClick={() => { setError(''); setTick(value => value + 1) }}>刷新事实与写作状态</button>
    {round && <p>事实回合：{round.roundId} · 版本 {round.version} · {round.activeReceiptId ? `已生效回执 ${round.activeReceiptId}` : '尚无生效事实'}</p>}
    {round?.pendingCandidateId && <p role="status">候选事实 · 尚未写入</p>}
    {reserved && <p role="status">{intent.status === 'recorded' ? '审批已记录，等待确认或应用。' : '审批中断或失败，可继续原决定。'} 原操作：{intent.operationId}</p>}
    {intent?.status === 'failed' && <p role="status">原决定已失败：{intent.errorCode || '未记录原因'}。可明确提交新的决定或取消本次候选。</p>}
    {applied && <p role="status">事实已生效，等待完成当前事实的写作。</p>}
    {round && round.candidates.length > 0 && <div className="rp-draft-list">{round.candidates.map(candidate => <button type="button" key={candidate.id} aria-pressed={selected?.id === candidate.id} onClick={() => choose(candidate)}>{candidate.id}{candidate.id === round.pendingCandidateId ? ' · 待审候选' : ' · 审计候选'}{candidate.generationConfirmed === false ? ' · 尚未完成生成结算' : ''}</button>)}</div>}
    {selected && <>
      {!matches && round?.pendingCandidateId && <p role="status">候选已变化；当前选择和草稿已保留。请明确选择最新待审候选后再决定。</p>}
      <div className="rp-compare"><section><h3>当前已生效事实</h3><World value={currentWorld} /></section><section><h3>所选候选事实</h3><World value={selected.payload} compare={currentWorld} /><p>{selected.payload.summary}</p>{selected.model && <p>候选实际模型：{selected.model.provider} / {selected.model.model}</p>}</section></div>
      <div className="rp-action-row"><button type="button" disabled={!canDecide} onClick={() => decide('approve')}>通过并继续</button><button type="button" disabled={!matches || reserved} onClick={() => setEditing(value => !value)}>自定义事实</button><button type="button" disabled={!canDecide} onClick={() => decide('cancel')}>取消本次候选</button></div>
      {editing && custom && <><CustomFields value={custom} onChange={value => { editVersion.current++; setCustom(value) }} variables={variableRows} onVariables={value => { editVersion.current++; setVariableRows(value) }} />{variableError && <p role="alert">{variableError}</p>}<button type="button" disabled={!canDecide || !!variableError} onClick={() => decide('custom')}>采用自定义并继续</button></>}
    </>}
    {reserved && <><button type="button" disabled={unavailable || !flags.resumeFactDecision} onClick={() => void run('resumeFactDecision', { sessionId, operationId: intent.operationId }, 'decision')}>继续审批结算</button><p>继续审批结算只处理原决定；写作需要另行点击。</p></>}
    {applied && <button type="button" disabled={unavailable || !flags.resumeFactPresentation} onClick={() => void run('resumeFactPresentation', { sessionId, roundId: applied.roundId, operationId: applied.operationId }, 'presentation')}>继续已批准事实的写作</button>}
    {retained?.kind === 'decision' && !reserved && !(intent?.status === 'failed' && retained.input.operationId === intent.operationId) && <button type="button" disabled={unavailable} onClick={() => void run(retained.method, retained.input, retained.kind, retained)}>重试上次事实决定</button>}
    <section className="rp-tool-section"><h3>重新生成事实</h3><p>从冻结的回合起点与工具证据生成新候选。已执行的工具不重跑；新事实生效后再写作。</p>
      <label>事实重生要求<textarea aria-label="事实重生要求" value={factInstruction} onChange={event => setFactInstruction(event.target.value)} rows={2} /></label>
      <button type="button" disabled={unavailable || reserved || !flags.regenerateFacts || !round?.canRegenerate || !round.latest} onClick={regenerate}>{round?.pendingCandidateId ? '重试事实' : '重新生成事实'}</button>
      {round?.blockCode && <p>{round.blockCode}</p>}
      {!round && review && <p>{currentWorld?.lastFactReceipt?.kind === 'turn' && !currentWorld.lastFactReceipt.factRoundId ? `LEGACY_BASELINE_UNAVAILABLE：当前回执 ${currentWorld.lastFactReceipt.id} 没有已捕获的回合起点。` : currentWorld?.lastFactReceipt?.kind === 'opening' ? '固定开场不提供事实重新生成。' : '当前没有可重新生成的已捕获普通回合。'}</p>}
      {generation && <p>事实生成：{generation.status}{generation.errorCode ? ` · ${generation.errorCode}` : ''}{generation.model ? ` · ${generation.model.provider} / ${generation.model.model}` : ''}</p>}
      {generation?.status === 'running' && <button type="button" disabled={!flags.cancelFactGeneration || cancelling} onClick={() => void cancelGeneration()}>取消事实生成</button>}
      {generationResume && <button type="button" disabled={unavailable || !flags.resumeFactGeneration} onClick={() => void run('resumeFactGeneration', { sessionId, operationId: generationResume }, 'generation')}>继续候选结算（不重新生成）</button>}
      {generation && ['failed', 'interrupted', 'cancelled'].includes(generation.status) && !generation.candidateId && <p>没有已暂存的候选时，继续结算不会重新调用模型。请明确发起新的事实生成。</p>}
    </section>
    <section className="rp-tool-section"><h3>只重新写作</h3><p>沿用当前事实与已冻结的完整写作材料，只请求 writer；成功后旧正文折叠为审计。</p>
      <label>写作重生要求<textarea aria-label="写作重生要求" value={writerInstruction} onChange={event => setWriterInstruction(event.target.value)} rows={2} /></label>
      <button type="button" disabled={unavailable || pending || !flags.regenerateProse || !latest || summaries?.canRegenerate !== true || summaries?.capabilities?.regenerateDispatch !== true} onClick={() => void run('regenerateProse', { sessionId, basedOn: copy(latest.ref), operationId: operationId(), ...(writerInstruction ? { instruction: writerInstruction } : {}) }, 'writer')}>只重新写作</button>
      {summaries?.regenerateBlockCode && <p>{summaries.regenerateBlockCode}</p>}
      {retained?.kind === 'writer' && <button type="button" disabled={unavailable || pending} onClick={() => void run(retained.method, retained.input, retained.kind, retained)}>重试上次写作请求</button>}
    </section>
  </section>
}
