import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRenderer } from 'dsh-tavern-renderer/core'
import { createNativeApi } from './api.js'
import { StoryTools } from './StoryTools.jsx'

const api = createNativeApi()
const tabs = [['state', '角色与剧情'], ['story', '沉浸阅读'], ['archive', '故事档案']]
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const title = item => ['name', 'title', 'label', 'npcName', 'npc', 'item', 'id'].map(key => text(item[key])).find(Boolean) || '未命名'
const describe = item => ['description', 'summary', 'status', 'objective', 'location', 'role'].map(key => text(item[key])).filter(Boolean).join(' · ')

export function BookIcon({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14M6 9h3m-3 4h3m6-4h3m-3 4h3" /></svg>
}

export function HeaderEntry({ openRp }) {
  return <button className="dsh-rp-entry" type="button" aria-label="打开 RP Studio" title="打开 RP Studio" onClick={openRp}><BookIcon /><span>RP</span></button>
}

function Group({ label, items = [] }) {
  if (!items.length) return null
  return <section className="rp-section"><h3>{label}<span>{items.length}</span></h3><div className="rp-items">{items.map((item, index) => <article key={item.id ?? index}><strong>{title(item)}</strong>{describe(item) && <p>{describe(item)}</p>}</article>)}</div></section>
}

function StateView({ detail }) {
  const state = detail.state
  const scene = state.scene
  const gm = state.extensions?.gm
  if (gm) return <div className="rp-state">
    <section className="rp-scene"><span className="rp-eyebrow">通用 GM</span><h2>{gm.scene.location}</h2><p>{[gm.scene.title, gm.scene.time].filter(Boolean).join(' · ')}</p></section>
    <section className="rp-section"><h3>当前事实</h3>{gm.facts.items.length ? <ul>{gm.facts.items.map(item => <li key={item.id}>{item.text}</li>)}</ul> : <p className="rp-note">尚无事实条目。</p>}</section>
    <section className="rp-section"><h3>故事角色</h3><p>{detail.card.description}</p><p className="rp-note">玩家身份：{detail.card.protagonist}</p></section>
  </div>
  return <div className="rp-state">
    <section className="rp-scene"><span className="rp-eyebrow">此刻 · {detail.card.world}</span><h2>{scene?.location || scene?.region || '故事即将开始'}</h2><p>{[state.currentDate, state.currentTime, scene?.weather].filter(Boolean).join(' · ') || '发出第一条行动，开启这一幕。'}</p>{scene?.currentBeat?.title && <div className="rp-beat">{scene.currentBeat.title}</div>}</section>
    <section className="rp-section"><h3>你的角色</h3><h2>{state.protagonist?.name || detail.card.protagonist}</h2>{state.statusLines.map((line, index) => <p className="rp-status" key={index}>{line}</p>)}{state.protagonist?.conditions?.length > 0 && <div className="rp-tags">{state.protagonist.conditions.map((item, index) => <span key={index}>{item.label}</span>)}</div>}</section>
    {scene?.currentBeat?.objectives?.length > 0 && <section className="rp-section"><h3>眼前目标</h3><ul>{scene.currentBeat.objectives.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    <Group label="人物关系" items={state.relationships} /><Group label="当前任务" items={state.quests} /><Group label="随身物品" items={state.inventory} /><Group label="记忆" items={state.memories} /><Group label="剧情记录" items={state.eventLog} />
    {!state.started && <p className="rp-note">剧情状态由角色卡提供，随对话更新。</p>}
  </div>
}

function Story({ detail, streaming, children }) {
  const renderer = useMemo(() => createRenderer(), [])
  const viewport = useRef(null)
  const follow = useRef(true)
  const messages = [...detail.messages, ...Object.entries(streaming).map(([id, value]) => ({ id, role: 'gm', text: value, status: 'streaming' }))]
  useEffect(() => { if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight }, [detail.messages, streaming])
  return <div className="rp-story" ref={viewport} onScroll={event => { const view = event.currentTarget; follow.current = view.scrollHeight - view.scrollTop - view.clientHeight < 80 }}>
    <div className="rp-story-title"><BookIcon size={28} /><h2>{detail.card.title}</h2><p>{detail.card.world}</p></div>
    {children}
    {messages.filter(message => message.role !== 'system').map(message => <article key={message.id} className={`rp-message rp-message-${message.role}`}><span className="rp-eyebrow">{message.role === 'player' ? detail.card.protagonist : '叙事'}</span>{message.role === 'player' ? <p>{message.text}</p> : <div data-dsh-tavern-renderer dangerouslySetInnerHTML={{ __html: renderer.render(message.text, { role: 'assistant', char: detail.card.protagonist, user: '玩家', streaming: message.status === 'streaming' }).html }} />}</article>)}
    {!messages.length && <p className="rp-note">这一页还空着。写下你的第一步。</p>}
  </div>
}

export function Workspace({ sessionId, visible = true, openSession, client = api, extraActions = null, openOwner, hasOwnerTab }) {
  const [detail, setDetail] = useState(null)
  const [cards, setCards] = useState([])
  const [sessions, setSessions] = useState([])
  const [tab, setTab] = useState('state')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [streaming, setStreaming] = useState({})
  const [revision, setRevision] = useState(0)
  const alive = useRef(true)
  const scope = useRef(sessionId)
  scope.current = sessionId
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setBusy(false); setDraft(''); setNotice('') }, [sessionId, client])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let unsubscribe = () => {}
    setLoading(true); setDetail(null); setStreaming({}); setError(''); setConnected(false)
    const load = async () => {
      try {
        const [available, archive] = await Promise.all([client.cards(controller.signal), client.sessions(controller.signal)])
        if (controller.signal.aborted) return
        setCards(available); setSessions(archive)
        if (!archive.some(item => item.id === sessionId)) { setLoading(false); return }
        const current = await client.session(sessionId, controller.signal)
        if (controller.signal.aborted) return
        setDetail(current); setLoading(false)
        let syncing = false
        let buffered = []
        const applyEvent = event => {
          if (event.type === 'message.delta') setStreaming(previous => ({ ...previous, [event.messageId]: (previous[event.messageId] || '') + event.text }))
          if (event.type === 'message.completed') { setDetail(previous => previous && ({ ...previous, messages: [...previous.messages.filter(item => item.id !== event.message.id), event.message] })); setStreaming({}) }
          if (event.type === 'state.updated') setDetail(previous => previous && ({ ...previous, state: event.state }))
          if (event.type === 'session.status') setDetail(previous => previous && ({ ...previous, session: { ...previous.session, running: event.running } }))
          if (event.type === 'session.rebased') void resync()
          if (event.type === 'error') { setError(event.error.message); if (event.error.upstreamCode?.startsWith('rp-last-step-')) setStreaming({}) }
        }
        const resync = async () => {
          if (syncing) return
          syncing = true
          try { const next = await client.session(sessionId, controller.signal); if (!controller.signal.aborted) { setDetail(next); setStreaming({}) } }
          catch (cause) { if (!controller.signal.aborted) setError(cause.message) }
          finally {
            syncing = false
            const pending = buffered
            buffered = []
            if (!controller.signal.aborted) for (const event of pending) applyEvent(event)
          }
        }
        unsubscribe = client.subscribe(sessionId, event => {
          if (controller.signal.aborted) return
          // Subscribe first, then reconcile even on the first connection. Replay changes
          // received while loading so the snapshot cannot overwrite a completed turn.
          if (event.type === 'connected') { setConnected(true); void resync(); return }
          if (syncing) buffered.push(event)
          else applyEvent(event)
        }, () => { if (!controller.signal.aborted) setConnected(false) })
      } catch (cause) { if (!controller.signal.aborted) { setError(cause.message); setLoading(false) } }
    }
    void load()
    return () => { controller.abort(); unsubscribe() }
  }, [sessionId, visible, client, revision])

  async function act(operation) {
    if (busy) return
    setBusy(true); setError('')
    const current = () => alive.current && scope.current === sessionId
    try { await operation(current) } catch (cause) { if (current()) setError(cause.message) }
    finally { if (current()) setBusy(false) }
  }
  const open = async id => { await openSession(id) }
  const send = event => {
    event.preventDefault()
    if (!draft.trim() || !detail || detail.session.running || busy) return
    const submitted = draft
    void act(async current => { await client.send(sessionId, submitted.trim()); if (current()) setDraft(value => value === submitted ? '' : value) })
  }
  const gm = detail?.state.extensions?.gm
  const narrativeRevision = detail?.messages.filter(message => message.role === 'gm').map(message => JSON.stringify([message.id, message.seq])).join('|') ?? ''
  return <div className="dsh-rp-workspace" data-rp-session={sessionId}>
    <header className="rp-heading"><div><span className="rp-eyebrow">RP STUDIO</span><h1>{detail?.card.title || '让故事发生'}</h1></div><div className="rp-heading-actions">{extraActions}<button type="button" className="rp-icon" aria-label="刷新 RP 工作区" title="刷新" onClick={() => setRevision(value => value + 1)} disabled={loading}>↻</button></div></header>
    <nav className="rp-tabs" aria-label="RP 工作区视图">{tabs.map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {error && <div role="alert" className="rp-error"><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
    {notice && <p role="status" className="rp-tool-notice">{notice}</p>}
    {loading ? <div className="rp-empty" role="status">正在翻开故事…</div> : tab === 'archive' || !detail ? <div className="rp-scroll">
      {!detail && <div className="rp-intro"><BookIcon size={32} /><h2>为这次冒险留个位置</h2><p>当前未读到可用的 RP 故事绑定。可在 Story Kit 选择角色、身份和开场，使用旧角色预设，或继续已有旅程。</p></div>}
      {visible && <StoryTools key={`${sessionId}-library`} sessionId={detail?.session.id} client={client} mode="library" running={detail?.session.running} openOwner={openOwner} hasOwnerTab={hasOwnerTab} onOpenSession={open} />}
      <section className="rp-section"><h3>旧角色预设开局</h3>{cards.length ? <div className="rp-card-grid">{cards.map(card => <button type="button" key={card.id} className="rp-card" disabled={busy} onClick={() => void act(async current => { const created = await client.create(card.id); if (current()) await open(created.session.id) })}><span className="rp-eyebrow">{card.world}</span><strong>{card.title}</strong><p>{card.description || card.protagonist}</p><span className="rp-card-action">开启故事 →</span></button>)}</div> : <p className="rp-note">旧角色预设列表为空。可安装兼容 RP 预设后刷新；通用故事也可从 Story Kit 开始，无需为每个角色编写预设。</p>}</section>
      {sessions.length > 0 && <section className="rp-section"><h3>继续旅程</h3>{sessions.map(item => <button type="button" key={item.id} className="rp-archive" disabled={busy} onClick={() => void act(() => open(item.id))}><span>{item.title}</span><small>{item.id === sessionId ? '当前故事' : item.running ? '正在演绎' : '继续 →'}</small></button>)}</section>}
    </div> : <>
      <div className="rp-content">{tab === 'story' ? <Story detail={detail} streaming={streaming}>{visible && <StoryTools key={sessionId} sessionId={sessionId} client={client} running={detail.session.running} narrativeRevision={narrativeRevision} openOwner={openOwner} hasOwnerTab={hasOwnerTab} onOpenSession={open} onAdopt={narrative => { setNotice(`已采用正式正文版本 ${narrative.ref.resultSeq}。宿主 blocked 维护状态仍保留；采用操作已确认。`); setRevision(value => value + 1) }} />}</Story> : <div className="rp-scroll"><StateView detail={detail} /></div>}</div>
      <footer className="rp-footer"><div className="rp-tools"><span className={`rp-connection ${connected ? 'is-online' : ''}`}>{detail.session.running ? '正在演绎…' : connected ? '故事已同步' : '正在重连…'}</span><div><button type="button" disabled={busy || detail.session.running || (gm ? !gm.capabilities.rollback : !detail.state.checkpoints.canRollback)} onClick={() => void act(async current => { const result = await client.rollback(sessionId); if (!current()) return; if (result.sessionId) await open(result.sessionId); else setRevision(value => value + 1) })}>回退</button><button type="button" disabled={busy || detail.session.running || gm && !gm.capabilities.fork} onClick={() => void act(async current => { const branch = await client.fork(sessionId); if (current()) await open(branch.session.id) })}>分支</button><button type="button" disabled={busy || !!gm || detail.session.running && !detail.state.driver?.armed} aria-pressed={detail.state.driver?.armed === true} onClick={() => void act(async current => { await client.autoplay(sessionId, detail.state.driver?.armed === true); if (current()) setRevision(value => value + 1) })}>{detail.state.driver?.armed ? '停止续写' : '自动续写'}</button></div></div>
      {gm && <p className="rp-control-note">回退与分支会打开子故事，保留原故事。通用 GM 暂不支持自动续写。</p>}
      <form onSubmit={send}><label className="rp-sr" htmlFor={`rp-input-${sessionId}`}>写下你的行动</label><textarea id={`rp-input-${sessionId}`} value={draft} maxLength={20000} onChange={event => setDraft(event.target.value)} placeholder="你接下来想做什么？" rows={2} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(event) } }} /><div className="rp-compose-bottom"><small>Enter 发送 · Shift + Enter 换行</small>{detail.session.running ? <button type="button" className="rp-primary" disabled={busy} onClick={() => void act(() => client.cancel(sessionId))}>停止生成</button> : <button type="submit" className="rp-primary" disabled={busy || !draft.trim()}>{busy ? '发送中…' : '发送行动 ↑'}</button>}</div></form></footer>
    </>}
  </div>
}
