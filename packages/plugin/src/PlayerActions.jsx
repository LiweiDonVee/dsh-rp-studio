import React, { useEffect, useRef, useState } from 'react'
import { fullNarrativeRef, refKey, sameRef } from './reading-state.mjs'

const message = cause => `${cause.code ? `${cause.code}：` : ''}${cause.message}`

export function PlayerActions({ source, client, disabled = false, onAppendAction }) {
  const [suggestions, setSuggestions] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const request = useRef(null), current = useRef(null), live = useRef(true)
  current.current = { source, disabled }
  const selected = refKey(source?.basedOn)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => () => request.current?.abort(), [client, source?.sessionId, source?.revision, selected])
  const validSource = captured => live.current && !current.current.disabled && current.current.source?.available
    && !current.current.source.refreshing && current.current.source.sessionId === captured.sessionId
    && current.current.source.revision === captured.revision && sameRef(current.current.source.basedOn, captured.basedOn)
  async function generate() {
    if (request.current || !source?.basedOn || !validSource(source)) return
    const captured = { sessionId: source.sessionId, basedOn: fullNarrativeRef(source.basedOn), revision: source.revision }, controller = new AbortController()
    request.current = controller; setBusy(true); setError(''); setNotice('')
    try {
      const result = await client.action('suggestPlayerActions', { sessionId: captured.sessionId, basedOn: captured.basedOn }, controller.signal)
      if (controller.signal.aborted) return
      if (!validSource(captured)) throw new Error('正文依据已变化，请重新生成行动建议。')
      if (result?.sessionId !== captured.sessionId || !sameRef(result.basedOn, captured.basedOn) || !Array.isArray(result.options) || result.options.length !== 2
        || result.options.some(option => typeof option?.text !== 'string' || !option.text.trim() || option.text.length > 500)) throw new Error('行动建议与当前正文不一致，请重新生成。')
      setSuggestions({ ...captured, options: result.options.map(option => ({ text: option.text })) })
    } catch (cause) { if (live.current && !controller.signal.aborted) setError(message(cause)) }
    finally { if (request.current === controller) { request.current = null; if (live.current) setBusy(false) } }
  }
  function append(option) {
    setError(''); setNotice('')
    if (!validSource(suggestions)) { setError('正文依据已变化，请重新生成行动建议。'); return }
    try {
      onAppendAction({ sessionId: suggestions.sessionId, basedOn: fullNarrativeRef(suggestions.basedOn), text: option.text.trim() })
      setNotice('已加入行动草稿，可继续修改后发送。')
    } catch (cause) { setError(message(cause)) }
  }
  if (!source?.available || !source.basedOn || source.basedOn.sessionId !== source.sessionId || !onAppendAction) return null
  const shown = suggestions && suggestions.sessionId === source.sessionId && suggestions.revision === source.revision && sameRef(suggestions.basedOn, source.basedOn)
  return <section className="rp-composer-help" aria-label="下一步行动建议">
    <button type="button" disabled={disabled || source.refreshing || busy} onClick={() => void generate()}>{busy ? '正在想下一步…' : '陪我想下一步'}</button>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {shown && <div className="rp-player-options"><p>下一步由你决定。可以先改文字，再加入行动草稿。</p>{suggestions.options.map((option, index) => <div key={index}><label>选项 {index + 1}<textarea aria-label={`行动建议 ${index + 1}`} rows={2} maxLength={500} value={option.text} onChange={event => { const text = event.target.value; setSuggestions(previous => ({ ...previous, options: previous.options.map((item, position) => position === index ? { text } : item) })) }} /></label><button type="button" disabled={disabled || source.refreshing || busy || !option.text.trim()} onClick={() => append(option)}>将选项 {index + 1} 加入行动草稿</button></div>)}</div>}
  </section>
}
