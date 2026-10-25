import React, { useEffect, useRef, useState } from 'react'
import { TransferTools } from './TransferTools.jsx'

const json = value => JSON.stringify(value, null, 2)
const errorText = error => `${error.code ? `${error.code}：` : ''}${error.message}`
const noteStatus = { pending: '待下一次选材', claimed: '已认领，失败重试沿用原快照', consumed: '已由正式正文采用' }

function Material({ value }) {
  return <section className="rp-material" aria-label="实际冻结材料">
    <h3>实际冻结材料 · {value.presentationId}</h3><p>状态：{value.status} · 事实回执：{value.factReceiptRef || '未记录'}</p>
    <p className="rp-note">这是所属插件保存的输入快照；不会从当前资料库重新拼装。</p>
    <details open><summary>固定来源上下文</summary>{value.storySnapshot == null ? <p>未记录固定来源</p> : <pre>{json(value.storySnapshot)}</pre>}</details>
    {typeof value.compiled?.text === 'string' && <p>模块文本长度：{value.compiled.text.length}（UTF-16 计数）。选材上限不代表包含系统、方向和固定来源的完整请求上限。</p>}
    <details open><summary>公开方向与事实</summary><pre>{json(value.packet ?? '尚未冻结')}</pre></details>
    <details open><summary>记录的候选池</summary><pre>{json(value.contextPreparation?.candidates ?? '未记录候选池')}</pre></details>
    <details><summary>选材与历史表示</summary><pre>{json(value.contextPreparation ?? '未记录')}</pre></details>
    <details open><summary>冻结模块与正文输入</summary><pre>{json(value.compiled ?? '尚未完成编译')}</pre></details>
    <details><summary>实际模型</summary><pre>{json(value.models ?? {})}</pre></details>
  </section>
}

function OwnerButton({ kind, children, openOwner, hasOwnerTab }) {
  if (!openOwner || !hasOwnerTab?.(kind)) return null
  return <button type="button" onClick={() => openOwner(kind)}>{children}</button>
}

function Capabilities({ value }) {
  if (!value) return null
  const names = { gm: '故事 GM', storyKit: 'Story Kit', database: 'RP Database', context: 'RP Context', lastStep: 'RP 最后一步', loop: 'Loop Studio' }
  return <details className="rp-service-status" open><summary>插件能力与要求</summary><ul>{Object.entries(names).map(([key, name]) => <li key={key}>{name}：{value.services[key]?.available ? `已连接${value.services[key].apiVersion !== null ? `（API ${value.services[key].apiVersion}）` : ''}` : '未连接'}</li>)}</ul>
    {!value.actions.createDraft && <p className="rp-note">候选与采用需要 RP 最后一步 0.3 对应能力。旧故事阅读仍可使用。</p>}
    {!value.actions.retryPresentation && <p className="rp-note">当前会话未开放受限正文重试；请在所属插件查看资格与依赖。</p>}
    <p className="rp-note">阅读稿：{value.actions.exportReading ? '可用' : '不可用'}；完整存档导出：{value.actions.exportSavedStory ? '可用' : '不可用'}；恢复预检：{value.actions.previewSavedStory ? '可用' : '不可用'}；恢复执行：{value.actions.restoreSavedStory ? '可用' : '不可用'}。</p>
    <p className="rp-note">通用开局需要 GM 0.1、Database 0.2、RP 最后一步 0.3；Context 0.2 可选。服务连接不代表某一稿件已满足操作条件。</p>
  </details>
}

export function StoryTools({ sessionId, client, running = false, narrativeRevision = '', mode = 'story', onAdopt, openOwner, hasOwnerTab, onOpenSession }) {
  const [data, setData] = useState({ capabilities: null, records: [], drafts: [], presentations: [], retryDispatch: false, note: null })
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState(null)
  const [edit, setEdit] = useState('')
  const [instruction, setInstruction] = useState('')
  const [material, setMaterial] = useState(null)
  const mounted = useRef(true), operation = useRef(null), editor = useRef(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort() } }, [])
  useEffect(() => {
    if (typeof client.action !== 'function') return
    const controller = new AbortController()
    const current = () => mounted.current && !controller.signal.aborted
    const args = sessionId ? { sessionId } : {}
    setLoading(true)
    void (async () => {
      try {
        const capabilities = await client.action('capabilities', args, controller.signal)
        const result = { capabilities, records: [], drafts: [], presentations: [], retryDispatch: false, note: null }
        if (sessionId && mode === 'story') {
          const reads = ['narratives', 'drafts', 'presentationSummaries', 'authorNote'].filter(action => capabilities.actions[action])
          const values = await Promise.allSettled(reads.map(action => client.action(action, { sessionId }, controller.signal)))
          for (let index = 0; index < reads.length; index++) {
            const value = values[index]
            if (value.status === 'rejected') { if (current()) setError(errorText(value.reason)); continue }
            if (reads[index] === 'narratives') result.records = value.value.records
            if (reads[index] === 'drafts') result.drafts = value.value.drafts
            if (reads[index] === 'presentationSummaries') { result.presentations = value.value.presentations; result.retryDispatch = value.value.capabilities.retryDispatch === true }
            if (reads[index] === 'authorNote') result.note = value.value
          }
        }
        if (current()) setData(result)
      } catch (cause) { if (current()) setError(errorText(cause)) }
      finally { if (current()) setLoading(false) }
    })()
    return () => controller.abort()
  }, [sessionId, client, mode, tick, running, narrativeRevision])

  async function run(action, input, accept) {
    if (busy || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await client.action(action, input, controller.signal)
      if (mounted.current && !controller.signal.aborted) await accept?.(result)
    } catch (cause) { if (mounted.current && !controller.signal.aborted) setError(`${errorText(cause)}${cause.code === 'DRAFT_VERSION_CONFLICT' ? ' 请刷新并重新预览候选；当前编辑已保留。' : ''}`) }
    finally { operation.current = null; if (mounted.current) setBusy(false) }
  }
  function choose(draft) { setSelected({ ...draft }); setEdit(draft.text); requestAnimationFrame(() => editor.current?.focus()) }
  const latest = data.records.at(-1), flags = data.capabilities?.actions ?? {}
  const dirty = selected && edit !== selected.text
  const currentFamily = selected && latest && selected.basedOn.sessionId === sessionId && selected.basedOn.presentationId === latest.ref.presentationId && selected.basedOn.baseResultSeq === latest.ref.baseResultSeq
  const unavailable = busy || running || loading
  const scoped = input => ({ sessionId, ...input })
  const create = kind => run('createDraft', scoped({ basedOn: latest.ref, kind, ...(kind === 'writer' && instruction.trim() ? { instruction: instruction.trim() } : {}) }), draft => { choose(draft); setTick(value => value + 1) })
  if (typeof client.action !== 'function') return null
  const owners = { openOwner, hasOwnerTab }
  const transfer = <section className="rp-section rp-tool-section"><h3>内容与存档</h3>
    <OwnerButton kind="rp-story-kit" {...owners}>角色、玩家身份、开场与内容包</OwnerButton>
    <p className="rp-note">内容包用于分享创作资料；阅读稿仅含当前正式正文；完整存档恢复保留原会话 ID，目标环境需要自行配置模型。</p>
    {mode === 'library' && <p className="rp-note">{data.capabilities?.services.storyKit.available ? 'Story Kit 服务已连接；开局与内容包需求由其原生面板检查。' : 'Story Kit 未连接；旧预设故事仍可使用。'}</p>}
    <TransferTools sessionId={sessionId} actions={flags} disabled={unavailable} run={run} onOpenSession={onOpenSession} />
  </section>
  if (mode === 'library') return <div className="rp-owner-tools">{loading && <p role="status">正在检查插件能力…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<Capabilities value={data.capabilities} />{transfer}</div>
  return <details className="rp-owner-tools"><summary>正文与材料</summary>
    {loading && <p role="status">正在读取所属插件…</p>}
    {error && <p role="alert" className="rp-tool-error">{error}</p>}{notice && <p role="status" className="rp-tool-notice">{notice}</p>}
    <Capabilities value={data.capabilities} />
    <div className="rp-action-row"><button type="button" disabled={busy} onClick={() => { setError(''); setTick(value => value + 1) }}>刷新正文操作</button><OwnerButton kind="rp-last-step" {...owners}>打开 RP 最后一步</OwnerButton><OwnerButton kind="rp-database" {...owners}>管理多库与文件资料</OwnerButton></div>
    <section className="rp-tool-section"><h3>当前正式正文</h3>{latest ? <p>版本 {latest.ref.resultSeq}{latest.ref.resultSeq !== latest.ref.baseResultSeq ? ' · 已采用修订' : ' · 原始稿'}</p> : <p className="rp-note">尚无可操作的正式正文；原有故事可继续阅读。</p>}
      <label>候选写作要求<textarea aria-label="候选写作要求" value={instruction} onChange={event => setInstruction(event.target.value)} rows={2} /></label>
      <div className="rp-action-row"><button type="button" disabled={unavailable || !flags.createDraft || !latest} onClick={() => void create('writer')}>生成候选</button><button type="button" disabled={unavailable || !flags.createDraft || !latest} onClick={() => void create('manual')}>手改当前正文</button><button type="button" disabled={unavailable || !flags.material || !latest} onClick={() => void run('material', scoped({ presentationId: latest.ref.presentationId }), setMaterial)}>查看当前正文材料</button></div>
      <p className="rp-note">候选只调整表达，采用前不影响故事。事实变化请回退或分支。</p>
    </section>
    {data.drafts.length > 0 && <section className="rp-tool-section"><h3>候选与历史草稿</h3><div className="rp-draft-list">{data.drafts.map(draft => <button type="button" key={draft.id} aria-pressed={selected?.id === draft.id} onClick={() => choose(draft)}>{draft.kind === 'manual' ? '手改' : '写作'} · {draft.status} · v{draft.version}{latest && draft.basedOn.presentationId !== latest.ref.presentationId ? ' · 历史回合' : ''}</button>)}</div></section>}
    {selected && <section className="rp-tool-section"><label>候选正文<textarea ref={editor} aria-label="候选正文" value={edit} onChange={event => setEdit(event.target.value)} rows={7} /></label>{selected.models?.render && <p className="rp-note">{selected.kind === 'manual' ? '原始生成模型' : '候选生成模型'}：{selected.models.render.provider} / {selected.models.render.model}</p>}
      <details><summary>比较当前正式稿与候选</summary><div className="rp-compare"><section><h3>当前正式稿</h3><pre>{latest?.text || '无正式稿'}</pre></section><section><h3>候选</h3><pre>{edit}</pre></section></div></details>
      <div className="rp-action-row"><button type="button" disabled={unavailable || !flags.editDraft || !dirty || !edit.trim()} onClick={() => void run('editDraft', scoped({ draftId: selected.id, text: edit, expectedDraftVersion: selected.version }), draft => { choose(draft); setNotice('候选修改已保存。'); setTick(value => value + 1) })}>保存候选修改</button><button type="button" disabled={unavailable || !flags.adoptDraft || !currentFamily || dirty || !['ready', 'draft'].includes(selected.status)} onClick={() => void run('adoptDraft', scoped({ draftId: selected.id, expectedDraftVersion: selected.version, expectedNarrative: latest.ref }), async result => { if (!result.narrative?.ref || result.narrative.ref.sessionId !== sessionId) throw new Error('未收到有效的采用确认。'); setData(previous => ({ ...previous, records: [...previous.records.slice(0, -1), result.narrative] })); setNotice('采用已确认。宿主维护回合可能显示 blocked；这不代表故事动作失败，宿主诊断仍保留。'); await onAdopt?.(result.narrative); if (mounted.current) setTick(value => value + 1) })}>采用这个候选</button></div>
    </section>}
    <section className="rp-tool-section"><h3>生成记录与失败重试</h3>{data.presentations.map(item => <article key={item.presentationId} className="rp-receipt"><p>{item.presentationId} · {item.status}{item.errorCode ? ` · ${item.errorCode}` : ''}</p>{item.retryBlockCode && <p>{item.retryBlockCode}</p>}<div className="rp-action-row">{['failed', 'cancelled'].includes(item.status) && <button type="button" disabled={unavailable || !flags.retryPresentation || !data.retryDispatch || !item.canRetry} onClick={() => void run('retryPresentation', scoped({ presentationId: item.presentationId }), () => { setNotice('已提交受限正文重试；可能包含一次主模型调度，不会重新结算事实或选材。'); setTick(value => value + 1) })}>重试该次正文</button>}<button type="button" disabled={unavailable || !flags.material} onClick={() => void run('material', scoped({ presentationId: item.presentationId }), setMaterial)}>查看该次材料</button></div></article>)}<p className="rp-note">记录是操作档案；rendered 尚不表示已进入正式历史。重试资格由所属插件再次检查。</p></section>
    {material && <Material value={material} />}
    <section className="rp-tool-section"><h3>下一轮作者注</h3>{data.note ? <><p>{noteStatus[data.note.status] || data.note.status} · v{data.note.version}</p><p>{data.note.text}</p></> : <p className="rp-note">没有已保存的下一轮作者注。</p>}<OwnerButton kind="rp-context" {...owners}>编辑下一轮作者注</OwnerButton><p className="rp-note">请从上下文原生入口编辑。作者注不是事实；已冻结的材料保留当时版本。</p></section>
    {transfer}
  </details>
}
