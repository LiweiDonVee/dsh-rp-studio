import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BookOpenText, HeartHandshake, KeyRound, LoaderCircle, LogOut, MapPin, ShieldCheck, Wifi, X } from 'lucide-react'
import { ProductApi, ProductApiError } from './ProductApi.js'
import type { ProductBootstrap, ProductLocation, ProductMemory, ProductNotification, ProductRelationship } from '@dsh-rp/protocol'

const NOTIFICATION_LIMIT = 100
type Connection = { api: ProductApi; roster: ProductBootstrap }
type StoryState = { memories: ProductMemory[]; relationships: ProductRelationship[]; locations: ProductLocation[] }

function message(error: unknown): string {
  return error instanceof ProductApiError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : String(error)
}
function authenticationFailed(error: unknown): boolean {
  return error instanceof ProductApiError && (error.status === 401 || error.status === 403 || error.code === 'unauthorized' || error.code === 'forbidden')
}
function latestNotifications(items: ProductNotification[]): ProductNotification[] {
  return [...new Map(items.map(item => [item.id, item])).values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, NOTIFICATION_LIMIT)
}
function Card({ title, icon: Icon, children }: { title: string; icon: typeof BookOpenText; children: ReactNode }) {
  return <section className="companion-card" aria-label={title}><h2><Icon aria-hidden="true" size={16} />{title}</h2>{children}</section>
}

function CompanionSession({ api, sessionId, onInvalidAuth }: { api: ProductApi; sessionId: string; onInvalidAuth(error: unknown): void }) {
  const [state, setState] = useState<StoryState | null>(null)
  const [notifications, setNotifications] = useState<ProductNotification[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(false)
  const generation = useRef(0)
  const pending = useRef<AbortController | null>(null)

  useEffect(() => {
    alive.current = true
    let active = true
    const stop = api.subscribeNotifications(sessionId, event => {
      if (!active) return
      setNotifications(current => latestNotifications(event.type === 'reset' ? event.items : [...current, event.item]))
    }, failure => {
      if (!active) return
      if (authenticationFailed(failure)) onInvalidAuth(failure)
      else setError(message(failure))
    })
    return () => {
      active = false
      alive.current = false
      generation.current++
      pending.current?.abort()
      stop()
    }
  }, [api, sessionId, onInvalidAuth])

  const loadState = async (event: FormEvent) => {
    event.preventDefault()
    if (pending.current || !alive.current) return
    const controller = new AbortController()
    pending.current = controller
    const requestGeneration = ++generation.current
    const current = () => alive.current && requestGeneration === generation.current && !controller.signal.aborted
    setBusy(true)
    setError(null)
    try {
      const [memories, relationships, locations] = await Promise.all([
        api.memories(sessionId, undefined, controller.signal),
        api.relationships(sessionId, undefined, controller.signal),
        api.locations(sessionId, undefined, controller.signal),
      ])
      if (current()) setState({ memories: memories.items, relationships: relationships.items, locations: locations.items })
    } catch (failure) {
      if (!current()) return
      if (authenticationFailed(failure)) onInvalidAuth(failure)
      else setError(message(failure))
    } finally {
      controller.abort()
      if (alive.current && requestGeneration === generation.current) {
        pending.current = null
        setBusy(false)
      }
    }
  }

  return <>
    <form className="companion-form companion-refresh" onSubmit={loadState}>
      <button className="companion-button" disabled={busy} type="submit">
        {busy ? <><LoaderCircle aria-hidden="true" size={15} />读取中…</> : '读取公开状态'}
      </button>
    </form>
    {error ? <div className="companion-error" role="alert"><X aria-hidden="true" size={15} />{error}</div> : null}
    <div className="companion-state">
      {state ? <>
        <Card icon={BookOpenText} title="公开记忆与情绪">
          {state.memories.length ? state.memories.map(item => <div className="companion-item" key={item.id}><strong>{item.text}</strong>{item.emotion ? <span>{item.emotion}</span> : null}</div>) : <p>暂无公开记忆</p>}
        </Card>
        <Card icon={HeartHandshake} title="关系">
          {state.relationships.length ? state.relationships.map(item => <div className="companion-item" key={item.id}><strong>{item.subject} → {item.object}</strong><span>{item.relation}</span></div>) : <p>暂无公开关系</p>}
        </Card>
        <Card icon={MapPin} title="虚构位置">
          {state.locations.length ? state.locations.map(item => <div className="companion-item" key={item.id}><strong>{item.world}</strong><span>{[item.region, item.scene, item.landmark].filter(Boolean).join(' / ') || '位置未细化'}</span></div>) : <p>暂无公开位置</p>}
        </Card>
      </> : null}
      {notifications.length ? <Card icon={Wifi} title="新通知">
        {notifications.map(item => <div className="companion-item" key={item.id}><strong>{item.title}</strong><span>{item.body}</span></div>)}
      </Card> : null}
    </div>
  </>
}

export function CompanionPage() {
  const [connection, setConnection] = useState<Connection | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [name, setName] = useState('我的手机')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeClient = useRef<ProductApi | null>(null)
  const pairingRequest = useRef<AbortController | null>(null)

  const disconnect = useCallback((failure?: unknown) => {
    activeClient.current?.clearBearer()
    activeClient.current = null
    pairingRequest.current?.abort()
    pairingRequest.current = null
    setConnection(null)
    setSessionId('')
    setCode('')
    setBusy(false)
    setError(failure === undefined ? null : message(failure))
  }, [])

  useEffect(() => () => {
    pairingRequest.current?.abort()
    activeClient.current?.clearBearer()
    activeClient.current = null
  }, [])

  const pair = async (event: FormEvent) => {
    event.preventDefault()
    if (pairingRequest.current || !code.trim() || !name.trim()) return
    const controller = new AbortController()
    pairingRequest.current = controller
    const client = new ProductApi()
    setBusy(true)
    setError(null)
    let connected = false
    try {
      const paired = await client.confirmPairing(code.trim(), name.trim(), controller.signal)
      if (controller.signal.aborted) return
      client.withBearer(paired.token)
      const roster = await client.bootstrap(controller.signal)
      if (controller.signal.aborted) return
      activeClient.current = client
      connected = true
      setConnection({ api: client, roster })
      setSessionId(roster.sessions[0]?.sessionId ?? '')
      setCode('')
    } catch (failure) {
      if (!controller.signal.aborted) setError(message(failure))
    } finally {
      if (!connected) client.clearBearer()
      if (!controller.signal.aborted) {
        pairingRequest.current = null
        setBusy(false)
      }
    }
  }
  const selected = connection?.roster.sessions.find(item => item.sessionId === sessionId)

  return <main className="companion-root">
    <header className="companion-header">
      <ShieldCheck aria-label="只读安全模式" size={22} />
      <div><span>DSH RP / COMPANION</span><h1>随身档案</h1></div>
      {connection ? <button className="icon-button" aria-label="断开配对连接" title="断开配对连接" onClick={() => disconnect()} type="button"><LogOut aria-hidden="true" size={18} /></button> : null}
    </header>
    <section className="companion-intro">
      <span className="product-eyebrow">{connection ? '已授权档案' : '手机配对'}</span>
      <div className="companion-status"><Wifi aria-hidden="true" size={14} />{connection ? '已建立只读连接' : '等待一次性短码'}</div>
    </section>
    {!connection ? <form className="companion-form" onSubmit={pair}>
      <label><span>客户端名称</span><input aria-label="companion 客户端名称" maxLength={100} onChange={event => setName(event.target.value)} value={name} /></label>
      <label><span>一次性短码</span><input aria-label="一次性配对短码" autoComplete="one-time-code" maxLength={200} onChange={event => setCode(event.target.value)} value={code} /></label>
      <button className="companion-button" disabled={busy || !code.trim() || !name.trim()} type="submit">
        {busy ? <><LoaderCircle aria-hidden="true" size={15} />配对中…</> : <><KeyRound aria-hidden="true" size={15} />确认配对</>}
      </button>
    </form> : <>
      <div className="companion-form">
        <label><span>已授权故事档案</span><select aria-label="已授权故事档案" onChange={event => {
          const nextId = event.target.value
          if (connection.roster.sessions.some(item => item.sessionId === nextId)) setSessionId(nextId)
        }} value={sessionId} disabled={!connection.roster.sessions.length}>
          {!connection.roster.sessions.length ? <option value="">暂无已授权故事档案</option> : connection.roster.sessions.map(item => <option key={item.sessionId} value={item.sessionId}>{item.title}</option>)}
        </select></label>
      </div>
      {selected ? <CompanionSession key={`${connection.roster.clientId}:${selected.sessionId}`} api={connection.api} sessionId={selected.sessionId} onInvalidAuth={disconnect} /> : null}
    </>}
    {error ? <div className="companion-error" role="alert"><X aria-hidden="true" size={15} />{error}</div> : null}
    <footer className="companion-footer">临时访问凭证 · 默认只读 · 仅限已授权档案</footer>
  </main>
}
