import React, { useEffect, useRef, useState } from 'react'

const statuses = { pending: '待下一次选材', claimed: '已被本轮认领，失败重试沿用原快照', consumed: '已由正式正文采用' }
const message = cause => `${cause.code ? `${cause.code}：` : ''}${cause.message}`

export function AuthorNote({ sessionId, client, actions, running }) {
  const [opened, setOpened] = useState(false), [state, setState] = useState(null), [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [tick, setTick] = useState(0)
  const expected = useRef(null), dirty = useRef(false), live = useRef(true), save = useRef(null)
  useEffect(() => { live.current = true; return () => { live.current = false; save.current?.abort() } }, [])
  useEffect(() => {
    if (!opened || !actions.authorNoteState) return
    const controller = new AbortController()
    setLoading(true); setError('')
    void client.action('authorNoteState', { sessionId }, controller.signal).then(value => {
      if (controller.signal.aborted) return
      if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)) throw new Error('未取得作者注的当前版本，请在上下文面板编辑。')
      setState(value); expected.current = value.revision
      if (!dirty.current) setDraft(value.note?.text || '')
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [client, sessionId, opened, tick, actions.authorNoteState])
  async function submit() {
    if (save.current || !Number.isSafeInteger(expected.current)) return
    const controller = new AbortController(), submitted = draft
    save.current = controller; setBusy(true); setError(''); setNotice('')
    try {
      const value = await client.action('setAuthorNote', { sessionId, text: submitted, expectedRevision: expected.current }, controller.signal)
      if (!live.current || controller.signal.aborted) return
      if (!Number.isSafeInteger(value?.revision)) throw new Error('未取得作者注保存确认。')
      expected.current = value.revision; setState({ schemaVersion: 1, ...value })
      setDraft(current => { dirty.current = current !== submitted; return current })
      setNotice('作者注已保存，将用于下一次选材与正文。')
    } catch (cause) { if (live.current && !controller.signal.aborted) setError(`${message(cause)} 你的文字已保留；重读当前版本后可再次明确保存。`) }
    finally { if (save.current === controller) save.current = null; if (live.current) setBusy(false) }
  }
  return <details className="rp-next-note rp-owner-tools" onToggle={event => setOpened(event.currentTarget.open)}><summary>下一轮作者注</summary>{opened && <>
    <p className="rp-note">仅影响下一次选材与正文。保存不会启动模型。</p>
    {!actions.authorNoteState && <p>当前版本未提供作者注版本读取，请从上下文面板编辑。</p>}
    {loading && <p role="status">正在读取作者注…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {state && <><p>{state.note ? `${statuses[state.note.status] || state.note.status} · v${state.note.version}` : '没有已保存的下一轮作者注。'}</p><label>作者注文字<textarea aria-label="下一轮作者注文字" rows={3} value={draft} onChange={event => { dirty.current = true; setDraft(event.target.value) }} /></label><div className="rp-action-row"><button type="button" disabled={busy || loading || running || !actions.setAuthorNote || !dirty.current} onClick={() => void submit()}>保存下一轮作者注</button><button type="button" disabled={busy || loading} onClick={() => { setTick(value => value + 1); setNotice('将保留编辑文字，读取当前版本作为下一次保存依据。') }}>保留文字并重读当前版本</button></div></>}
  </>}</details>
}
