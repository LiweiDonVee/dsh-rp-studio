import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { Card, PromptSession, PublicGameState, SessionSummary, TranscriptMessage } from '@dsh-rp/protocol'
import {
  Activity,
  Boxes,
  AlertTriangle,
  Archive,
  Backpack,
  BookOpenText,
  Bot,
  CalendarDays,
  ChevronRight,
  CircleStop,
  Clock3,
  GitFork,
  History,
  LockKeyhole,
  MapPin,
  Menu,
  PanelRight,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  Send,
  ShieldCheck,
  Square,
  Sparkles,
  SlidersHorizontal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { RenderedNarrative } from './renderer.js'
import { useStudio } from './store.js'

type InspectorTab = 'status' | 'relationships' | 'quests' | 'timeline' | 'methods'
type UnknownRecord = Record<string, unknown>

function primitive(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  return undefined
}

function itemTitle(item: UnknownRecord, fallback: string): string {
  for (const key of ['name', 'title', 'label', 'npcName', 'npc', 'item', 'id']) {
    const value = primitive(item[key])
    if (value) return value
  }
  return fallback
}

function itemDetails(item: UnknownRecord): string[] {
  const preferred = ['description', 'summary', 'status', 'objective', 'location', 'reason', 'role', 'stage']
    .flatMap(key => {
      const value = primitive(item[key])
      return value ? [value] : []
    })
  if (preferred.length > 0) return [...new Set(preferred)].slice(0, 3)
  return Object.entries(item)
    .filter(([key]) => !['id', 'name', 'title', 'label'].includes(key))
    .flatMap(([, value]) => {
      const text = primitive(value)
      return text ? [text] : []
    })
    .slice(0, 3)
}

function formatUpdatedAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '未记录'
  const time = value < 10_000_000_000 ? value * 1000 : value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(time))
}

function IconButton(props: {
  label: string
  icon: LucideIcon
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  tone?: 'normal' | 'danger' | 'accent'
  type?: 'button' | 'submit'
  className?: string
}) {
  const Icon = props.icon
  return (
    <button
      aria-label={props.label}
      aria-pressed={props.active}
      className={`icon-button tone-${props.tone ?? 'normal'} ${props.className ?? ''}`}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.label}
      type={props.type ?? 'button'}
    >
      <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
    </button>
  )
}

function useModalFocus(open: boolean, panelRef: RefObject<HTMLElement>, onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? [])]
    focusable()[0]?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]!
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previousFocus?.focus()
    }
  }, [open, panelRef])
}

function CardArtwork({ card, compact = false }: { card: Card; compact?: boolean }) {
  return (
    <div className={`card-artwork ${compact ? 'is-compact' : ''} ${card.kind === 'template' ? 'is-template' : ''}`} data-accent={card.accent}>
      <Boxes aria-hidden="true" size={compact ? 26 : 42} strokeWidth={1.5} />
      <span aria-hidden="true" className="art-index">RP</span>
    </div>
  )
}

function CampaignRail(props: {
  cards: Card[]
  sessions: SessionSummary[]
  currentId: string | undefined
  connected: boolean
  onCreate(cardId: string): void
  onSelect(sessionId: string): void
  mobile?: boolean
}) {
  return (
    <aside className={`campaign-rail ${props.mobile ? 'is-mobile' : ''}`} aria-label="世界与会话">
      <header className="studio-brand">
        <div className="brand-mark" aria-hidden="true"><Archive size={18} /></div>
        <div>
          <strong>DSH RP</strong>
          <span>叙事档案室</span>
        </div>
        <span className={`connection-lamp ${props.connected ? 'is-online' : ''}`} title={props.connected ? '事件流已连接' : '事件流未连接'} />
      </header>

      <section className="rail-section" aria-labelledby={props.mobile ? 'mobile-card-heading' : 'card-heading'}>
        <div className="section-kicker">
          <span id={props.mobile ? 'mobile-card-heading' : 'card-heading'}>世界档案</span>
          <span>{String(props.cards.length).padStart(2, '0')}</span>
        </div>
        <div className="card-roster">
          {props.cards.map(card => (
            <article className="roster-card" data-accent={card.accent} key={card.id}>
              <CardArtwork card={card} compact />
              <div className="roster-card-copy">
                <strong>{card.title}</strong>
                <span>{card.world}</span>
              </div>
              <IconButton label={`以${card.title}创建档案`} icon={Plus} onClick={() => props.onCreate(card.id)} tone="accent" />
            </article>
          ))}
          {props.cards.length === 0 ? <p className="rail-empty">未发现 RP 卡片</p> : null}
        </div>
      </section>

      <section className="rail-section session-section" aria-labelledby={props.mobile ? 'mobile-session-heading' : 'session-heading'}>
        <div className="section-kicker">
          <span id={props.mobile ? 'mobile-session-heading' : 'session-heading'}>进行中的档案</span>
          <span>{String(props.sessions.length).padStart(2, '0')}</span>
        </div>
        <nav className="session-list" aria-label="RP 会话">
          {props.sessions.map(session => (
            <button
              aria-current={session.id === props.currentId ? 'page' : undefined}
              className="session-entry"
              key={session.id}
              onClick={() => props.onSelect(session.id)}
              type="button"
            >
              <span className={`session-status ${session.running ? 'is-running' : ''}`} aria-hidden="true" />
              <span className="session-entry-copy">
                <strong>{session.title}</strong>
                <small>{formatUpdatedAt(session.updatedAt)}</small>
              </span>
              <ChevronRight aria-hidden="true" size={15} />
            </button>
          ))}
          {props.sessions.length === 0 ? <p className="rail-empty">暂无会话</p> : null}
        </nav>
      </section>

      <footer className="rail-footer">
        <ShieldCheck aria-hidden="true" size={15} />
        <span>PLAYER-SAFE PROJECTION</span>
      </footer>
    </aside>
  )
}

function EmptyStage({ cards, onCreate }: { cards: Card[]; onCreate(cardId: string): void }) {
  return (
    <main className="empty-stage">
      <div className="empty-stage-heading">
        <span>ARCHIVE / SELECT</span>
        <h1>选择世界档案</h1>
      </div>
      <div className="empty-card-grid">
        {cards.map(card => (
          <article className="empty-card" data-accent={card.accent} key={card.id}>
            <CardArtwork card={card} />
            <div className="empty-card-copy">
              <span>{card.world}</span>
              <h2>{card.title}</h2>
              <p>{card.protagonist}</p>
              <button className="command-button" onClick={() => onCreate(card.id)} type="button">
                <Plus aria-hidden="true" size={17} />
                新建档案
              </button>
            </div>
          </article>
        ))}
        {cards.length === 0 ? (
          <div className="empty-docket">
            <Archive aria-hidden="true" size={28} />
            <strong>未发现可用的 RP 预设</strong>
            <p>RP Studio 不附带卡片、故事或角色。请先在 DSH 中安装你自己的用户预设，并在预设目录添加 rp-card.json。</p>
            <p>Gateway 的 DSH_HOME 应指向该 DSH 数据目录；连接由 DSH_BASE_URL 和 DSH_WEB_TOKEN 配置。清单与运行时要求见项目 README。</p>
            <button className="command-button" onClick={() => void useStudio.getState().load()} type="button">
              <RefreshCw aria-hidden="true" size={16} />重新加载预设
            </button>
          </div>
        ) : null}
      </div>
    </main>
  )
}

function NarrativeMessage({ message, card }: { message: TranscriptMessage; card: Card }) {
  const roleLabel = message.role === 'player' ? '玩家' : message.role === 'gm' ? 'GM' : '系统'
  return (
    <article className={`narrative-message role-${message.role}`} data-message-id={message.id}>
      <header>
        <span>{roleLabel}</span>
        <time>{formatUpdatedAt(message.createdAt)}</time>
      </header>
      {message.role === 'player'
        ? <p className="player-prose">{message.text}</p>
        : <RenderedNarrative text={message.text} char={card.title} />}
    </article>
  )
}

function Transcript(props: {
  card: Card
  messages: TranscriptMessage[]
  streaming: Record<string, string>
  blank: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const streamText = Object.values(props.streaming).join('')
  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }, [props.messages.length, streamText])

  return (
    <div className="transcript-scroll" ref={scrollRef}>
      <div className="transcript" aria-live="polite">
        {props.messages.map(message => <NarrativeMessage card={props.card} key={message.id} message={message} />)}
        {Object.entries(props.streaming).map(([id, text]) => (
          <article className="narrative-message role-gm is-streaming" key={id}>
            <header><span>GM</span><span className="live-label"><Radio aria-hidden="true" size={12} /> LIVE</span></header>
            <RenderedNarrative text={text} char={props.card.title} streaming />
          </article>
        ))}
        {props.messages.length === 0 && !streamText ? (
          <div className="blank-transcript">
            <BookOpenText aria-hidden="true" size={27} />
            <strong>{props.blank ? '新档案' : '叙事尚未开始'}</strong>
            <span>{props.card.world}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Composer(props: {
  running: boolean
  promptBusy: boolean
  sessionId: string
  onSend(text: string): Promise<void>
  onCancel(): Promise<void>
}) {
  const [draft, setDraft] = useState('')
  useEffect(() => setDraft(''), [props.sessionId])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || props.running || props.promptBusy) return
    setDraft('')
    void props.onSend(text)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        aria-label="玩家行动"
        disabled={props.running || props.promptBusy}
        maxLength={20_000}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={props.running ? 'GM 正在推进本轮…' : props.promptBusy ? '正在应用叙事方法…' : '写下你的行动…'}
        rows={2}
        value={draft}
      />
      {props.running
        ? <IconButton className="composer-submit" icon={Square} label="停止当前回合" onClick={() => void props.onCancel()} tone="danger" />
        : <IconButton className="composer-submit" disabled={props.promptBusy || !draft.trim()} icon={Send} label="发送行动" tone="accent" type="submit" />}
    </form>
  )
}

function StoryHeader(props: {
  card: Card
  title: string
  connected: boolean
  running: boolean
  canRollback: boolean
  autoplay: boolean
  onCampaigns(): void
  onInspector(): void
  onRollback(): void
  onFork(): void
  onAutoplay(): void
}) {
  return (
    <header className="story-header" data-accent={props.card.accent}>
      <div className="mobile-header-button">
        <IconButton icon={Menu} label="打开世界与会话" onClick={props.onCampaigns} />
      </div>
      <div className="story-title">
        <span>{props.card.world}</span>
        <h1>{props.title}</h1>
      </div>
      <div className="story-actions">
        <span className={`stream-state ${props.connected ? 'is-connected' : ''}`} title={props.connected ? '事件流已连接' : '事件流未连接'}>
          <Radio aria-hidden="true" size={14} />
          <span>{props.connected ? 'LIVE' : 'OFFLINE'}</span>
        </span>
        <IconButton disabled={props.running || !props.canRollback} icon={RotateCcw} label="回退上一轮" onClick={props.onRollback} />
        <IconButton disabled={props.running} icon={GitFork} label="从当前档案创建分支" onClick={props.onFork} />
        <IconButton active={props.autoplay} disabled={props.running} icon={props.autoplay ? CircleStop : Play} label={props.autoplay ? '管理自动续跑' : '启动自动续跑'} onClick={props.onAutoplay} tone={props.autoplay ? 'danger' : 'accent'} />
      </div>
      <div className="mobile-header-button">
        <IconButton icon={PanelRight} label="打开公开状态" onClick={props.onInspector} />
      </div>
    </header>
  )
}

function AutoplayDialog(props: {
  open: boolean
  armed: boolean
  onClose(): void
  onApply(input: { rounds: number; objective?: string }): Promise<void>
  onStop(): Promise<void>
}) {
  const [rounds, setRounds] = useState(8)
  const [objective, setObjective] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  useModalFocus(props.open, panelRef, props.onClose)
  if (!props.open) return null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = objective.trim()
    void props.onApply({ rounds, ...(trimmed ? { objective: trimmed } : {}) }).then(props.onClose)
  }
  return (
    <div className="autoplay-popover" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="autoplay-title">
      <header>
        <div>
          <span>AUTONOMOUS DRIVER</span>
          <strong id="autoplay-title">自动续跑</strong>
        </div>
        <IconButton icon={X} label="关闭自动续跑面板" onClick={props.onClose} />
      </header>
      <form onSubmit={submit}>
        <label>
          <span>轮数</span>
          <input max={64} min={1} onChange={event => setRounds(Number(event.target.value))} type="number" value={rounds} />
        </label>
        <label>
          <span>目标</span>
          <input autoFocus maxLength={2_000} onChange={event => setObjective(event.target.value)} placeholder="推进当前主线" value={objective} />
        </label>
        <div className="dialog-actions">
          {props.armed ? (
            <button className="command-button is-danger" onClick={() => void props.onStop().then(props.onClose)} type="button">
              <CircleStop aria-hidden="true" size={16} />停止
            </button>
          ) : null}
          <button className="command-button" type="submit"><Play aria-hidden="true" size={16} />启动</button>
        </div>
      </form>
    </div>
  )
}

function DossierList({ items, empty }: { items: UnknownRecord[]; empty: string }) {
  if (items.length === 0) return <p className="inspector-empty">{empty}</p>
  return (
    <div className="dossier-list">
      {items.map((item, index) => (
        <article key={`${itemTitle(item, 'entry')}-${index}`}>
          <span className="dossier-index">{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{itemTitle(item, `记录 ${index + 1}`)}</strong>
            {itemDetails(item).map(detail => <p key={detail}>{detail}</p>)}
          </div>
        </article>
      ))}
    </div>
  )
}

function MetricGrid({ values }: { values: UnknownRecord | undefined }) {
  if (!values) return null
  const entries = Object.entries(values).flatMap(([key, value]) => {
    const text = primitive(value)
    return text ? [[key, text] as const] : []
  })
  if (entries.length === 0) return null
  return (
    <dl className="metric-grid">
      {entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
    </dl>
  )
}

function PromptMethodsPanel(props: {
  prompt: PromptSession | undefined
  draftEntryIds: string[]
  busy: boolean
  notice: string | null
  onEntry(entryId: string, checked: boolean): void
  onProfile(profileId: string, checked: boolean): void
  onApply(): void
  onReset(): void
}) {
  const selected = new Set(props.draftEntryIds)
  const empty = selected.size === 0
  const prompt = props.prompt
  return (
    <div className="prompt-methods">
      <section className="inspector-section prompt-core-section">
        <div className="section-title"><Sparkles aria-hidden="true" size={15} /><span>叙事方法</span></div>
        <div className="prompt-core-row">
          <span className="prompt-lock"><LockKeyhole aria-hidden="true" size={16} /></span>
          <span><strong>Agent runtime core</strong><small>工具、状态、回滚与知识边界</small></span>
          <span className="prompt-core-state">LOCKED</span>
        </div>
      </section>

      {!prompt?.available ? (
        <section className="inspector-section prompt-unavailable" role="status">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{prompt?.message ?? '叙事方法数据暂不可用；Agent runtime 核心仍保持启用。'}</span>
        </section>
      ) : (
        <>
          {empty ? (
            <div className="prompt-empty-warning" role="alert">
              <AlertTriangle aria-hidden="true" size={15} />
              <span>当前没有启用任何叙事方法；仅使用 Agent runtime 核心与卡片底座。</span>
            </div>
          ) : null}
          {props.notice ? <div className="prompt-notice" role="status">{props.notice}</div> : null}
          {prompt.optionalProfiles.map(profile => {
            const profileSelected = profile.entries.length > 0 && profile.entries.every(entry => selected.has(entry.id))
            return (
              <section className="prompt-profile" key={profile.id}>
                <label className="prompt-profile-toggle">
                  <input
                    aria-label={`${profile.name}全部方法`}
                    checked={profileSelected}
                    disabled={props.busy}
                    onChange={event => props.onProfile(profile.id, event.target.checked)}
                    type="checkbox"
                  />
                  <span><strong>{profile.name}</strong><small>v{profile.version} · {profile.entries.length} 项</small></span>
                </label>
                <div className="prompt-entry-list">
                  {profile.entries.map(entry => (
                    <label className="prompt-entry" key={entry.id}>
                      <input
                        aria-label={entry.name}
                        checked={selected.has(entry.id)}
                        disabled={props.busy}
                        onChange={event => props.onEntry(entry.id, event.target.checked)}
                        type="checkbox"
                      />
                      <span><strong>{entry.name}</strong><small>{entry.renderOnly ? 'RENDER' : entry.slot.toUpperCase()}</small></span>
                    </label>
                  ))}
                </div>
              </section>
            )
          })}
          {prompt.optionalProfiles.length === 0 ? <p className="inspector-empty">该卡片没有可选叙事方法</p> : null}
          <div className="prompt-actions">
            <button className="command-button" disabled={props.busy} onClick={props.onApply} type="button">
              <Save aria-hidden="true" size={15} />{props.busy ? '保存中' : '应用到下一轮'}
            </button>
            <IconButton disabled={props.busy || empty} icon={RotateCcw} label="清空可选叙事方法" onClick={props.onReset} />
          </div>
          {prompt.appliesFromNextTurn ? <div className="prompt-next-turn">NEXT TURN · 下一轮生效</div> : null}
        </>
      )}
    </div>
  )
}

function InspectorPanel(props: {
  card: Card
  state: PublicGameState
  prompt: PromptSession | undefined
  promptDraftEntryIds: string[]
  promptBusy: boolean
  promptNotice: string | null
  tab: InspectorTab
  onTab(tab: InspectorTab): void
  onPromptEntry(entryId: string, checked: boolean): void
  onPromptProfile(profileId: string, checked: boolean): void
  onPromptApply(): void
  onPromptReset(): void
  mobile?: boolean
}) {
  const protagonist = props.state.protagonist
  const relationships = props.state.relationships.map(item => item as UnknownRecord)
  const faction = props.state.faction.map(item => item as UnknownRecord)
  const quests = props.state.quests.map(item => item as UnknownRecord)
  const inventory = props.state.inventory.map(item => item as UnknownRecord)
  const timeline = [...props.state.eventLog].reverse().map(item => item as UnknownRecord)
  const memories = [...props.state.memories].reverse().map(item => item as UnknownRecord)
  const tabs: { id: InspectorTab; label: string; icon: LucideIcon }[] = [
    { id: 'status', label: '状态', icon: Activity },
    { id: 'relationships', label: '关系', icon: Users },
    { id: 'quests', label: '任务', icon: ScrollText },
    { id: 'timeline', label: '时间线', icon: History },
    { id: 'methods', label: '方法', icon: SlidersHorizontal },
  ]
  return (
    <aside className={`inspector ${props.mobile ? 'is-mobile' : ''}`} aria-label="公开状态">
      <div className="inspector-cover">
        <CardArtwork card={props.card} />
        <div>
          <span>ACTIVE DOSSIER</span>
          <strong>{props.card.protagonist}</strong>
          <small>{props.card.world}</small>
        </div>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="状态视图">
        {tabs.map(tab => {
          const Icon = tab.icon
          return (
            <button aria-selected={props.tab === tab.id} key={tab.id} onClick={() => props.onTab(tab.id)} role="tab" type="button">
              <Icon aria-hidden="true" size={15} />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>
      <div className="inspector-scroll" role="tabpanel">
        {props.tab === 'status' ? (
          <>
            <section className="inspector-section scene-strip">
              <div><CalendarDays aria-hidden="true" size={15} /><span>{props.state.currentDate ?? '日期未定'}</span></div>
              <div><Clock3 aria-hidden="true" size={15} /><span>{props.state.currentTime ?? '时间未定'}</span></div>
              <div><MapPin aria-hidden="true" size={15} /><span>{props.state.scene?.location ?? props.state.scene?.region ?? '地点未定'}</span></div>
            </section>
            <section className="inspector-section">
              <div className="section-title"><Bot aria-hidden="true" size={15} /><span>主角状态</span></div>
              <h2>{protagonist?.name ?? props.card.protagonist}</h2>
              {protagonist?.background ? <p className="muted-copy">{protagonist.background}</p> : null}
              <MetricGrid values={protagonist?.attributes} />
              <MetricGrid values={protagonist?.resources} />
              {protagonist?.conditions.length ? (
                <div className="condition-row">
                  {protagonist.conditions.map((condition, index) => <span key={condition.id ?? `${condition.label}-${index}`}>{condition.label}</span>)}
                </div>
              ) : null}
            </section>
            <section className="inspector-section">
              <div className="section-title"><Activity aria-hidden="true" size={15} /><span>当前摘要</span></div>
              {props.state.statusLines.length > 0
                ? <ul className="status-lines">{props.state.statusLines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>
                : <p className="inspector-empty">暂无状态摘要</p>}
            </section>
            <section className="inspector-section">
              <div className="section-title"><Backpack aria-hidden="true" size={15} /><span>随身物品</span></div>
              <DossierList empty="暂无公开物品" items={inventory} />
            </section>
          </>
        ) : null}
        {props.tab === 'relationships' ? (
          <>
            <section className="inspector-section">
              <div className="section-title"><Users aria-hidden="true" size={15} /><span>人物关系</span></div>
              <DossierList empty="暂无公开关系" items={relationships} />
            </section>
            <section className="inspector-section">
              <div className="section-title"><ShieldCheck aria-hidden="true" size={15} /><span>阵营</span></div>
              <DossierList empty="暂无公开阵营" items={faction} />
            </section>
          </>
        ) : null}
        {props.tab === 'quests' ? (
          <section className="inspector-section">
            <div className="section-title"><ScrollText aria-hidden="true" size={15} /><span>任务与驱动</span></div>
            {props.state.driver?.armed ? (
              <div className="driver-banner"><Play aria-hidden="true" size={14} /><span>{props.state.driver.objective ?? '自动续跑已启动'}</span></div>
            ) : null}
            <DossierList empty="暂无公开任务" items={quests} />
          </section>
        ) : null}
        {props.tab === 'timeline' ? (
          <>
            <section className="inspector-section">
              <div className="section-title"><History aria-hidden="true" size={15} /><span>事件记录</span></div>
              <DossierList empty="暂无公开事件" items={timeline} />
            </section>
            <section className="inspector-section">
              <div className="section-title"><BookOpenText aria-hidden="true" size={15} /><span>公开记忆</span></div>
              <DossierList empty="暂无公开记忆" items={memories} />
            </section>
          </>
        ) : null}
        {props.tab === 'methods' ? (
          <PromptMethodsPanel
            busy={props.promptBusy}
            draftEntryIds={props.promptDraftEntryIds}
            notice={props.promptNotice}
            onApply={props.onPromptApply}
            onEntry={props.onPromptEntry}
            onProfile={props.onPromptProfile}
            onReset={props.onPromptReset}
            prompt={props.prompt}
          />
        ) : null}
      </div>
      <footer className="checkpoint-footer">
        <Archive aria-hidden="true" size={14} />
        <span>{props.state.checkpoints.count} 个关键快照</span>
        <span>TURN {props.state.checkpoints.activeTurn ?? '—'}</span>
      </footer>
    </aside>
  )
}

function MobileSheet(props: { open: boolean; side: 'left' | 'right'; label: string; onClose(): void; children: ReactNode }) {
  const panelRef = useRef<HTMLElement>(null)
  useModalFocus(props.open, panelRef, props.onClose)
  if (!props.open) return null
  return (
    <div className="sheet-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}>
      <section aria-label={props.label} aria-modal="true" className={`mobile-sheet from-${props.side}`} ref={panelRef} role="dialog">
        <IconButton className="sheet-close" icon={X} label={`关闭${props.label}`} onClick={props.onClose} />
        {props.children}
      </section>
    </div>
  )
}

function LoadingStage() {
  return (
    <main className="loading-stage" aria-label="正在载入 RP Studio">
      <div className="loading-rule" />
      <Archive aria-hidden="true" size={25} />
      <strong>正在整理档案</strong>
    </main>
  )
}

export function App() {
  const studio = useStudio()
  const [autoplayOpen, setAutoplayOpen] = useState(false)
  useEffect(() => { void studio.load() }, [studio.load])
  useEffect(() => {
    document.body.dataset.sheetOpen = studio.sheet ? 'true' : 'false'
    return () => { delete document.body.dataset.sheetOpen }
  }, [studio.sheet])

  const current = studio.current
  const sortedSessions = useMemo(() => [...studio.sessions].sort((a, b) => b.updatedAt - a.updatedAt), [studio.sessions])
  const rail = (
    <CampaignRail
      cards={studio.cards}
      connected={studio.connected}
      currentId={current?.session.id}
      onCreate={cardId => void studio.createCampaign(cardId)}
      onSelect={sessionId => void studio.selectSession(sessionId)}
      sessions={sortedSessions}
    />
  )

  return (
    <div className="studio-shell">
      <div className="desktop-rail">{rail}</div>
      {studio.loading && !current && studio.cards.length === 0 ? <LoadingStage /> : current ? (
        <main className="story-workspace">
          <StoryHeader
            autoplay={current.state.driver?.armed === true}
            canRollback={current.state.checkpoints.canRollback}
            card={current.card}
            connected={studio.connected}
            onAutoplay={() => setAutoplayOpen(value => !value)}
            onCampaigns={() => studio.setSheet('campaigns')}
            onFork={() => void studio.fork()}
            onInspector={() => studio.setSheet('inspector')}
            onRollback={() => void studio.rollback()}
            running={current.session.running}
            title={current.session.title}
          />
          <Transcript blank={current.session.blank} card={current.card} messages={current.messages} streaming={studio.streaming} />
          <Composer onCancel={studio.cancel} onSend={studio.send} promptBusy={studio.promptBusy} running={current.session.running} sessionId={current.session.id} />
          <AutoplayDialog
            armed={current.state.driver?.armed === true}
            onApply={input => studio.autoplay(input)}
            onClose={() => setAutoplayOpen(false)}
            onStop={() => studio.autoplay({ off: true })}
            open={autoplayOpen}
          />
        </main>
      ) : <EmptyStage cards={studio.cards} onCreate={cardId => void studio.createCampaign(cardId)} />}

      <div className="desktop-inspector">
        {current
          ? <InspectorPanel
              card={current.card}
              onPromptApply={() => void studio.applyPromptSettings()}
              onPromptEntry={studio.togglePromptEntry}
              onPromptProfile={studio.togglePromptProfile}
              onPromptReset={() => void studio.resetPromptSettings()}
              onTab={studio.setInspectorTab}
              prompt={current.prompt}
              promptBusy={studio.promptBusy}
              promptDraftEntryIds={studio.promptDraftEntryIds}
              promptNotice={studio.promptNotice}
              state={current.state}
              tab={studio.inspectorTab}
            />
          : <aside className="inspector-placeholder" aria-label="公开状态"><PanelRight aria-hidden="true" size={23} /><span>未选择档案</span></aside>}
      </div>

      <MobileSheet label="世界与会话" onClose={() => studio.setSheet(null)} open={studio.sheet === 'campaigns'} side="left">
        <CampaignRail
          cards={studio.cards}
          connected={studio.connected}
          currentId={current?.session.id}
          mobile
          onCreate={cardId => void studio.createCampaign(cardId)}
          onSelect={sessionId => void studio.selectSession(sessionId)}
          sessions={sortedSessions}
        />
      </MobileSheet>
      <MobileSheet label="公开状态" onClose={() => studio.setSheet(null)} open={studio.sheet === 'inspector'} side="right">
        {current ? <InspectorPanel
          card={current.card}
          mobile
          onPromptApply={() => void studio.applyPromptSettings()}
          onPromptEntry={studio.togglePromptEntry}
          onPromptProfile={studio.togglePromptProfile}
          onPromptReset={() => void studio.resetPromptSettings()}
          onTab={studio.setInspectorTab}
          prompt={current.prompt}
          promptBusy={studio.promptBusy}
          promptDraftEntryIds={studio.promptDraftEntryIds}
          promptNotice={studio.promptNotice}
          state={current.state}
          tab={studio.inspectorTab}
        /> : null}
      </MobileSheet>

      {studio.error ? (
        <div className="error-banner" role="alert">
          <span>{studio.error}</span>
          <IconButton icon={RefreshCw} label="重新连接" onClick={() => void studio.load()} />
          <IconButton icon={X} label="关闭错误提示" onClick={studio.dismissError} />
        </div>
      ) : null}
    </div>
  )
}
