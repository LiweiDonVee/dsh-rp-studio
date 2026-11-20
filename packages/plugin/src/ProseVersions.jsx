import React, { useEffect, useRef, useState } from 'react'
import { familyKey, fullNarrativeRef, refKey, sameRef } from './reading-state.mjs'

const message = cause => `${cause.code ? `${cause.code}：` : ''}${cause.message}`

export function ProseVersions({ sessionId, record, latest, eligible, disabled = false, client, actions, onAdopt }) {
  const [records, setRecords] = useState([]), [drafts, setDrafts] = useState([]), [selected, setSelected] = useState(null)
  const [instruction, setInstruction] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [tick, setTick] = useState(0)
  const live = useRef(true), request = useRef(null), selection = useRef(0)
  const selectedKey = refKey(record.ref), family = familyKey(record.ref)
  useEffect(() => { live.current = true; return () => { live.current = false; request.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const reads = ['narratives', 'drafts'].filter(action => actions[action])
    void Promise.all(reads.map(action => client.action(action, { sessionId }, controller.signal))).then(values => {
      if (controller.signal.aborted) return
      const result = Object.fromEntries(reads.map((action, index) => [action, values[index]]))
      setRecords((result.narratives?.records || []).filter(item => familyKey(item.ref) === family))
      setDrafts((result.drafts?.drafts || []).filter(item => familyKey(item.basedOn) === family))
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [client, sessionId, selectedKey, family, tick, actions.narratives, actions.drafts])
  const choose = draft => { selection.current++; setSelected(draft); setNotice('') }
  async function run(action, input, accept) {
    if (request.current) return
    const controller = new AbortController(), version = selection.current
    request.current = controller; setBusy(true); setError(''); setNotice('')
    try {
      const result = await client.action(action, input, controller.signal)
      if (live.current && !controller.signal.aborted) await accept(result, version)
    } catch (cause) { if (live.current && !controller.signal.aborted) setError(`${message(cause)} 所选候选与写作要求已保留，请重新读取版本后决定。`) }
    finally { if (request.current === controller) { request.current = null; if (live.current) setBusy(false) } }
  }
  const current = latest && familyKey(latest.ref) === family ? latest : null
  const canAdopt = eligible && current && selected && familyKey(selected.basedOn) === family && ['ready', 'draft'].includes(selected.status)
  return <section className="rp-prose-versions rp-owner-tools" aria-label="其他写法">
    <h3>本轮其他写法</h3><p className="rp-note">打开和查看版本只读取已保存内容。候选稿会先展示，明确采用后才替换正式正文。</p>
    {loading && <p role="status">正在读取已保存版本…</p>}{error && <p role="alert" className="rp-tool-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="button" disabled={busy} onClick={() => setTick(value => value + 1)}>重新读取版本</button>
    {records.filter(item => !sameRef(item.ref, record.ref)).map(item => <details key={refKey(item.ref)}><summary>已保存正文 · 版本 {item.ref.resultSeq}</summary><p className="rp-presentation-body">{item.text}</p><p className="rp-note">此版本仅供阅读。</p></details>)}
    {drafts.length > 0 && <div className="rp-draft-list">{drafts.map(draft => <button key={draft.id} type="button" aria-pressed={selected?.id === draft.id} onClick={() => choose(draft)}>{draft.kind === 'writer' ? '写作候选' : '手改候选'} · {draft.status} · v{draft.version}</button>)}</div>}
    {selected && <section className="rp-tool-section"><h4>所选候选稿</h4><p className="rp-presentation-body">{selected.text}</p>{eligible && <button type="button" disabled={disabled || busy || loading || !actions.adoptDraft || !canAdopt} onClick={() => void run('adoptDraft', { sessionId, draftId: selected.id, expectedDraftVersion: selected.version, expectedNarrative: fullNarrativeRef(current.ref) }, async result => {
      if (!result.narrative?.ref || result.narrative.ref.sessionId !== sessionId) throw new Error('未收到有效的采用确认。')
      setNotice('采用已确认。'); await onAdopt(result.narrative); if (live.current) setTick(value => value + 1)
    })}>明确采用</button>}</section>}
    {eligible ? <section className="rp-tool-section"><label>候选稿写作要求<textarea aria-label="候选稿写作要求" value={instruction} rows={2} onChange={event => setInstruction(event.target.value)} /></label><button type="button" disabled={disabled || loading || busy || !actions.createDraft || !current} onClick={() => void run('createDraft', { sessionId, basedOn: fullNarrativeRef(current.ref), kind: 'writer', ...(instruction.trim() ? { instruction: instruction.trim() } : {}) }, (draft, version) => {
      setDrafts(previous => [...previous.filter(item => item.id !== draft.id), draft]); if (selection.current === version) choose(draft); setNotice('候选稿已保存，请阅读后决定是否采用。')
    })}>生成候选稿</button>{busy && <button type="button" onClick={() => { request.current?.abort(); request.current = null; setBusy(false); setNotice('已停止等待；重新读取版本可确认是否已有保存结果。') }}>停止等待候选操作</button>}</section> : <p className="rp-note">历史回合可浏览已保存版本；生成与采用仅对当前可修订的最新正文开放。</p>}
  </section>
}
