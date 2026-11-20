import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRenderer } from 'dsh-tavern-renderer/core'
import { StoryTools } from './StoryTools.jsx'
import { TurnBasis } from './TurnBasis.jsx'
import { ProseVersions } from './ProseVersions.jsx'
import { AuthorNote } from './AuthorNote.jsx'
import { fullNarrativeRef, refKey, roundKey, sameRef, validReadingPage } from './reading-state.mjs'

const errorText = cause => `${cause.code ? `${cause.code}：` : ''}${cause.message}`
const messageKey = message => `message:${message.id}`

export function StoryReader({ sessionId, detail, streaming, client, narrativeRevision, presentationId, factReviewPending, onOpenCompanion, companionReason, onEditPlot, onAdopt, openOwner, hasOwnerTab, onOpenSession, onReadingSource, onReadingOpened }) {
  const renderer = useMemo(() => createRenderer(), [])
  const viewport = useRef(null), follow = useRef(true), anchor = useRef(null), initial = useRef(true)
  const [page, setPage] = useState(null), [capabilities, setCapabilities] = useState(null), [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false), [readingNotice, setReadingNotice] = useState('')
  const [olderBusy, setOlderBusy] = useState(false), [error, setError] = useState(''), [tick, setTick] = useState(0), [legacyCount, setLegacyCount] = useState(8)
  const [tool, setTool] = useState(null), [newer, setNewer] = useState(false)
  const toolTrigger = useRef(null), toolPanel = useRef(null)
  const [companionBusy, setCompanionBusy] = useState(null), [companionError, setCompanionError] = useState('')
  const [actionBusy, setActionBusy] = useState(null), [actionError, setActionError] = useState('')
  const actionRequest = useRef(null), actionScope = useRef(null)
  actionScope.current = { sessionId, narrativeRevision, refreshing }
  const companionOpening = useRef(false)
  const olderRequest = useRef(null), live = useRef(true), loaded = useRef(false)
  const currentPage = useRef(page), pendingLocate = useRef(null)
  currentPage.current = page
  const reader = detail.state.extensions?.reader, flags = capabilities?.actions || {}
  useEffect(() => { live.current = true; return () => { live.current = false; olderRequest.current?.abort() } }, [])
  useEffect(() => () => actionRequest.current?.abort(), [sessionId, client, narrativeRevision])
  useEffect(() => {
    if (presentationId !== undefined || typeof client.action !== 'function') { setLoading(false); return }
    const controller = new AbortController()
    olderRequest.current?.abort(); olderRequest.current = null; setOlderBusy(false)
    if (!loaded.current) setLoading(true)
    else setRefreshing(true)
    void (async () => {
      try {
        const available = await client.action('capabilities', { sessionId }, controller.signal)
        if (controller.signal.aborted) return
        setCapabilities(available)
        if (available.actions?.readingPage) {
          let next = await client.action('readingPage', { sessionId, limit: 8 }, controller.signal)
          if (controller.signal.aborted) return
          if (!validReadingPage(next, sessionId)) throw new Error('正文分页响应无效，请检查插件版本。')
          const previous = currentPage.current
          if (previous?.projectionKey !== next.projectionKey) {
            const earliest = previous?.records[0]?.ref
            if (earliest && (previous.records.length > 8 || !follow.current)) {
              const newest = previous.records.at(-1).ref.callSeq
              const desired = previous.records.length + next.records.filter(item => item.ref.callSeq > newest).length
              const budget = previous.records.length + 8
              // Rebuild the already opened span from the new projection. Old
              // bodies are never spliced into newly confirmed reading pages.
              while (next.hasOlder && next.records[0]?.ref.callSeq > earliest.callSeq && next.records.length < budget) {
                const older = await client.action('readingPage', { sessionId, before: next.nextBefore, limit: Math.min(20, budget - next.records.length, Math.max(1, desired - next.records.length)) }, controller.signal)
                if (controller.signal.aborted) return
                if (!validReadingPage(older, sessionId) || older.projectionKey !== next.projectionKey) throw new Error('正文分页已经变化，请重新读取最近正文。')
                next = { ...older, records: [...older.records, ...next.records.filter(item => !older.records.some(old => roundKey(old.ref) === roundKey(item.ref)))] }
              }
              setReadingNotice(next.hasOlder && next.records[0]?.ref.callSeq > earliest.callSeq ? '本次更新超过保留窗口；可继续加载更早正文。' : '')
            }
            if (previous && !follow.current) captureAnchor()
          }
          setPage(previous => {
            // Repeated connection snapshots do not replace already loaded pages.
            if (previous?.projectionKey === next.projectionKey) return previous
            return next
          })
        } else setPage(null)
        loaded.current = true
      } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)) }
      finally { if (!controller.signal.aborted) { setLoading(false); setRefreshing(false) } }
    })()
    return () => controller.abort()
  }, [sessionId, client, narrativeRevision, presentationId, tick])
  const legacy = detail.messages.filter(message => message.role !== 'system')
  const visibleLegacy = legacy.slice(-legacyCount)
  const records = page?.records || []
  const displayedProse = presentationId === undefined && detail.session.id === sessionId && (page
    ? records.some(record => record.ref.sessionId === sessionId && record.text.trim())
    : visibleLegacy.some(message => message.role === 'gm' && (message.status === undefined || message.status === 'complete') && message.text.trim()))
  useEffect(() => { if (displayedProse) onReadingOpened?.(sessionId) }, [displayedProse, sessionId, onReadingOpened])
  const streamRecords = Object.entries(streaming).map(([id, text]) => ({ id, text, role: 'gm', status: 'streaming' }))
  const latest = !reader?.pendingFacts && reader?.status !== 'unavailable' ? records.at(-1) : null
  const readingSource = { sessionId, basedOn: latest ? fullNarrativeRef(latest.ref) : null, revision: narrativeRevision, available: flags.suggestPlayerActions === true, refreshing: loading || refreshing }
  useEffect(() => { onReadingSource?.(readingSource) }, [sessionId, latest, narrativeRevision, flags.suggestPlayerActions, loading, refreshing, onReadingSource])
  useEffect(() => { if (tool) toolPanel.current?.focus({ preventScroll: true }) }, [tool])
  const toolRecord = tool && records.find(record => sameRef(record.ref, tool.basedOn))
  const contentVersion = JSON.stringify([records.map(record => refKey(record.ref)), visibleLegacy.map(message => [message.id, message.seq, message.text]), streamRecords.map(message => [message.id, message.text])])
  function captureAnchor() {
    const view = viewport.current
    if (!view) return
    const top = view.getBoundingClientRect().top
    const item = [...view.querySelectorAll('[data-rp-reading-key]')].find(node => node.getBoundingClientRect().bottom > top)
    anchor.current = item ? { key: item.getAttribute('data-rp-reading-key'), top: item.getBoundingClientRect().top, scrollTop: view.scrollTop } : { scrollTop: view.scrollTop, height: view.scrollHeight }
  }
  useLayoutEffect(() => {
    const view = viewport.current
    if (!view) return
    if (pendingLocate.current) {
      const target = [...view.querySelectorAll('[data-rp-reading-key]')].find(node => node.getAttribute('data-rp-reading-key') === roundKey(pendingLocate.current))
      if (target) { view.scrollTop += target.getBoundingClientRect().top - view.getBoundingClientRect().top; pendingLocate.current = null; anchor.current = null; initial.current = false; return }
    }
    if (anchor.current) {
      const saved = anchor.current
      const item = [...view.querySelectorAll('[data-rp-reading-key]')].find(node => node.getAttribute('data-rp-reading-key') === saved.key)
      view.scrollTop = item ? saved.scrollTop + item.getBoundingClientRect().top - saved.top : saved.scrollTop + view.scrollHeight - (saved.height ?? view.scrollHeight)
      if (saved.key && !item) setReadingNotice('正文版本已更新，原阅读位置不在当前有效正文中。')
      anchor.current = null
    } else if (initial.current || follow.current) {
      view.scrollTop = view.scrollHeight
      initial.current = false; setNewer(false)
    } else setNewer(true)
  }, [contentVersion])
  useEffect(() => { if (loading) initial.current = true }, [loading])
  async function loadOlder() {
    if (olderRequest.current || refreshing) return
    if (!page) { captureAnchor(); setLegacyCount(value => value + 8); return }
    if (!page.hasOlder || !page.nextBefore) return
    const controller = new AbortController(), projection = page.projectionKey
    olderRequest.current = controller; setOlderBusy(true); setError('')
    try {
      const older = await client.action('readingPage', { sessionId, limit: 8, before: page.nextBefore }, controller.signal)
      if (!live.current || controller.signal.aborted) return
      if (!validReadingPage(older, sessionId) || older.projectionKey !== projection) throw new Error('正文分页已经变化，请重新读取最近正文。')
      captureAnchor()
      setPage(previous => previous?.projectionKey === projection ? { ...older, records: [...older.records, ...previous.records.filter(item => !older.records.some(old => roundKey(old.ref) === roundKey(item.ref)))] } : previous)
    } catch (cause) { if (live.current && !controller.signal.aborted) setError(`${errorText(cause)} 已载入的正文与阅读位置保留。`) }
    finally { if (olderRequest.current === controller) { olderRequest.current = null; if (live.current) setOlderBusy(false) } }
  }
  function reveal(ref) {
    const view = viewport.current
    const item = [...(view?.querySelectorAll('[data-rp-reading-key]') || [])].find(node => node.getAttribute('data-rp-reading-key') === roundKey(ref))
    if (!item || !view) return false
    follow.current = false; view.scrollTop += item.getBoundingClientRect().top - view.getBoundingClientRect().top
    return true
  }
  async function locate(ref) {
    const available = currentPage.current
    if (available?.records.some(item => sameRef(item.ref, ref))) { reveal(ref); return }
    if (!available || ref.sessionId !== sessionId) throw new Error('该历史依据没有可载入的本故事正文。')
    if (olderRequest.current || refreshing) throw new Error('正在同步正文，请稍后再次定位。')
    const controller = new AbortController(), projection = available.projectionKey
    olderRequest.current = controller; setOlderBusy(true); follow.current = false
    let collected = available
    try {
      while (collected.hasOlder && ref.callSeq < collected.records[0]?.ref.callSeq) {
        const older = await client.action('readingPage', { sessionId, limit: 8, before: collected.nextBefore }, controller.signal)
        if (!live.current || controller.signal.aborted || currentPage.current?.projectionKey !== projection) throw new Error('故事已变化，本次历史定位已停止。')
        if (!validReadingPage(older, sessionId) || older.projectionKey !== projection) throw new Error('正文分页已变化，请重新读取最近正文。')
        collected = { ...older, records: [...older.records, ...collected.records.filter(item => !older.records.some(old => roundKey(old.ref) === roundKey(item.ref)))] }
        captureAnchor()
        if (collected.records.some(item => sameRef(item.ref, ref))) pendingLocate.current = ref
        setPage(collected)
        if (pendingLocate.current) return
      }
      throw new Error('该引用已折叠或不在当前有效正文中，无法定位。')
    } finally {
      if (olderRequest.current === controller) { olderRequest.current = null; if (live.current) setOlderBusy(false) }
    }
  }
  async function adopted(narrative) {
    setPage(previous => previous && ({ ...previous, records: previous.records.map(item => roundKey(item.ref) === roundKey(narrative.ref) ? narrative : item) }))
    setTool(previous => previous && roundKey(previous.basedOn) === roundKey(narrative.ref) ? { ...previous, basedOn: fullNarrativeRef(narrative.ref) } : previous)
    await onAdopt?.(narrative); setTick(value => value + 1)
  }
  async function askCompanion(record) {
    if (companionOpening.current || !onOpenCompanion) return
    companionOpening.current = true; setCompanionBusy(refKey(record.ref)); setCompanionError('')
    try { await onOpenCompanion({ operation: 'story.turnDetails', basedOn: fullNarrativeRef(record.ref) }) }
    catch (cause) { if (live.current) setCompanionError(errorText(cause)) }
    finally { companionOpening.current = false; if (live.current) setCompanionBusy(null) }
  }
  function sourceCurrent(basedOn, revision) {
    const current = actionScope.current, available = currentPage.current?.records
    return live.current && current.sessionId === basedOn.sessionId && current.narrativeRevision === revision && !current.refreshing
      && available?.some(record => sameRef(record.ref, basedOn))
  }
  async function forkReading(record) {
    if (actionRequest.current) return
    const basedOn = fullNarrativeRef(record.ref), revision = narrativeRevision
    if (!sourceCurrent(basedOn, revision)) return
    const controller = new AbortController()
    actionRequest.current = controller; setActionBusy('forkStoryAtReading'); setActionError('')
    try {
      const result = await client.action('forkStoryAtReading', { sessionId, basedOn }, controller.signal)
      if (controller.signal.aborted) return
      if (!sourceCurrent(basedOn, revision)) throw new Error('正文依据已变化，请重新选择这一幕。')
      const child = result?.sessionId
      if (typeof child !== 'string' || !child.trim() || child === sessionId || result.parentSessionId !== sessionId || result.binding?.sessionId !== child
        || !sameRef(result.basedOn, basedOn) || Object.keys(result.branchRef ?? {}).length !== 6 || !sameRef(result.branchRef, { ...basedOn, sessionId: child })) throw new Error('未收到与这一幕一致的分支确认，请检查故事列表后重试。')
      await onOpenSession(child, 'story')
    } catch (cause) { if (live.current && !controller.signal.aborted) setActionError(errorText(cause)) }
    finally { if (actionRequest.current === controller) { actionRequest.current = null; if (live.current) setActionBusy(null) } }
  }
  function closeTool() {
    setTool(null)
    if (toolTrigger.current?.isConnected) toolTrigger.current.focus({ preventScroll: true })
  }
  function openTool(record, view, trigger) {
    if (tool?.view === view && sameRef(tool.basedOn, record.ref)) { closeTool(); return }
    toolTrigger.current = trigger
    setTool({ basedOn: fullNarrativeRef(record.ref), view })
  }
  const renderText = (text, streaming = false) => renderer.render(text, { role: 'assistant', char: detail.card.protagonist, user: '玩家', streaming }).html
  const hasOlder = page ? page.hasOlder : legacy.length > legacyCount
  return <div className="rp-reader-shell" onKeyDown={event => { if (tool && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeTool() } }}><div className="rp-story" ref={viewport} data-rp-reader="" aria-label="故事阅读" onScroll={event => { const view = event.currentTarget; follow.current = view.scrollHeight - view.scrollTop - view.clientHeight < 80; if (follow.current) setNewer(false) }}>
    <div className="rp-story-title"><h2>{detail.card.title}</h2><p>{detail.card.world}</p></div>
    {presentationId !== undefined ? <StoryTools sessionId={sessionId} client={client} running={detail.session.running} readerStatus={reader} narrativeRevision={narrativeRevision} presentationId={presentationId} expanded onAdopt={onAdopt} openOwner={openOwner} hasOwnerTab={hasOwnerTab} onOpenSession={onOpenSession} /> : <>
      {error && <div className="rp-reader-error"><p role="alert">{error}</p><button type="button" onClick={() => { setError(''); setTick(value => value + 1) }}>重新读取最近正文</button></div>}
      {companionError && <p role="alert" className="rp-reader-error">{companionError}</p>}
      {readingNotice && <p role="status" className="rp-note">{readingNotice}</p>}
      {loading && <p role="status">正在读取最近正文…</p>}
      {hasOlder && <div className="rp-reader-paging"><button type="button" disabled={olderBusy || refreshing} onClick={() => void loadOlder()}>{olderBusy ? '正在加载更早正文…' : '加载更早'}</button><span>{page ? `已载入 ${records.length} / ${page.totalCount} 轮` : `已载入 ${visibleLegacy.length} / ${legacy.length} 条`}</span></div>}
      {reader?.status === 'unavailable' && <p role="status">{reader.message || 'EFFECTIVE_HISTORY_UNAVAILABLE：有效正文暂不可用。'}</p>}
      {reader?.pendingFacts && <p role="status">当前事实已生效，等待写作。</p>}
      {page ? records.map(record => {
        const key = roundKey(record.ref), exactKey = refKey(record.ref)
        const eligible = latest && refKey(latest.ref) === exactKey
        const editBusy = detail.session.running || factReviewPending || refreshing
        return <article key={key} className="rp-message rp-message-gm rp-confirmed-turn" data-rp-reading-key={key} data-rp-reading-presentation={record.ref.presentationId}>
          <div className="rp-turn-actions rp-reading-actions"><span>{record.turn === undefined ? '这一幕' : `第 ${record.turn} 轮`}</span><button type="button" disabled={!flags.turnDetails} aria-expanded={tool?.view === 'basis' && sameRef(tool.basedOn, record.ref)} onClick={event => openTool(record, 'basis', event.currentTarget)}>本轮依据</button><button type="button" disabled={!onOpenCompanion || companionBusy !== null} title={!onOpenCompanion ? companionReason : undefined} onClick={() => void askCompanion(record)}>{companionBusy === exactKey ? '正在打开 RP 助手…' : '问 RP 助手'}</button><button type="button" aria-expanded={tool?.view === 'versions' && sameRef(tool.basedOn, record.ref)} onClick={event => openTool(record, 'versions', event.currentTarget)}>其他写法</button>{eligible && detail.state.extensions?.gm && <button type="button" disabled={editBusy} onClick={onEditPlot}>改这轮剧情</button>}{flags.forkStoryAtReading && onOpenSession && <button type="button" disabled={refreshing || actionBusy !== null} onClick={() => void forkReading(record)}>从这一幕另走</button>}</div>
          {record.action && <div className="rp-turn-action"><span className="rp-eyebrow">{detail.card.protagonist}</span><p>{record.action}</p></div>}
          <span className="rp-eyebrow">{record.turn === undefined ? '叙事' : `第 ${record.turn} 轮`} · 正式正文</span><div data-dsh-tavern-renderer dangerouslySetInnerHTML={{ __html: renderText(record.text) }} />
        </article>
      }) : visibleLegacy.map(message => <article key={message.id} className={`rp-message rp-message-${message.role}`} data-rp-reading-key={messageKey(message)}><span className="rp-eyebrow">{message.role === 'player' ? detail.card.protagonist : '叙事'}</span>{message.role === 'player' ? <p>{message.text}</p> : <div data-dsh-tavern-renderer dangerouslySetInnerHTML={{ __html: renderText(message.text) }} />}</article>)}
      {streamRecords.map(message => <article key={message.id} className="rp-message rp-message-gm rp-streaming-turn" data-rp-reading-key={messageKey(message)}><span className="rp-eyebrow">正在写作</span><div data-dsh-tavern-renderer dangerouslySetInnerHTML={{ __html: renderText(message.text, true) }} /></article>)}
      {!loading && !(page ? records.length : visibleLegacy.length) && !streamRecords.length && !reader?.pendingFacts && reader?.status !== 'unavailable' && <p className="rp-note">这一页还空着。写下你的第一步。</p>}
      {newer && <button type="button" className="rp-reader-tail" onClick={() => { follow.current = true; viewport.current.scrollTop = viewport.current.scrollHeight; setNewer(false) }}>回到最新正文</button>}
      <AuthorNote sessionId={sessionId} client={client} actions={flags} running={detail.session.running} />
      <StoryTools sessionId={sessionId} client={client} running={detail.session.running} narrativeRevision={narrativeRevision} readerStatus={reader} factReviewPending={factReviewPending} onAdopt={adopted} openOwner={openOwner} hasOwnerTab={hasOwnerTab} onOpenSession={onOpenSession} />
    </>}
  </div>{tool && <aside ref={toolPanel} tabIndex={-1} className="rp-reading-panel" role="region" aria-label="本轮阅读工具" data-rp-tool-presentation={tool.basedOn.presentationId}>
    <header><strong>{toolRecord?.turn === undefined ? '所选这一幕' : `第 ${toolRecord.turn} 轮`} · 正式正文</strong><button type="button" onClick={closeTool}>关闭阅读工具</button></header>
    {toolRecord ? <><div className="rp-turn-actions"><button type="button" disabled={!flags.turnDetails} aria-pressed={tool.view === 'basis'} onClick={() => setTool(previous => ({ ...previous, view: 'basis' }))}>本轮依据</button><button type="button" aria-pressed={tool.view === 'versions'} onClick={() => setTool(previous => ({ ...previous, view: 'versions' }))}>其他写法</button>{flags.forkStoryAtReading && onOpenSession && <button type="button" disabled={refreshing || actionBusy !== null} onClick={() => void forkReading(toolRecord)}>从这一幕另走</button>}</div>
    {tool.view === 'basis' ? <TurnBasis key={refKey(toolRecord.ref)} sessionId={sessionId} record={toolRecord} client={client} records={records} onLocate={locate} openOwner={openOwner} hasOwnerTab={hasOwnerTab} /> : <ProseVersions key={roundKey(toolRecord.ref)} sessionId={sessionId} record={toolRecord} latest={latest} eligible={latest && sameRef(latest.ref, toolRecord.ref)} disabled={detail.session.running || factReviewPending || refreshing} client={client} actions={flags} onAdopt={adopted} />}</> : <p role="status">所选正文已变化，请在阅读中重新选择这一幕。</p>}
  </aside>}{actionError && <div className="rp-reading-feedback"><p role="alert">{actionError}</p><button type="button" onClick={() => setActionError('')}>关闭提示</button></div>}</div>
}
