import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card, PromptSession, PublicGameState, SessionDetail, SessionSummary, StreamEvent } from '@dsh-rp/protocol'
import { App } from './App.js'
import { api, connectEvents } from './api.js'
import { useStudio } from './store.js'

vi.mock('./api.js', () => ({
  api: {
    cards: vi.fn(), sessions: vi.fn(), session: vi.fn(), create: vi.fn(),
    prompt: vi.fn(), cancel: vi.fn(), rollback: vi.fn(), fork: vi.fn(), autoplay: vi.fn(),
    promptSettings: vi.fn(), applyPromptSettings: vi.fn(), resetPromptSettings: vi.fn(),
  },
  connectEvents: vi.fn(),
}))

const card: Card = {
  id: 'zombie-world', title: '世界模拟器', description: '档案', world: '2005 · 洛杉矶末日第七天', protagonist: '伊莱亚斯·诺伦', art: 'zombie-world', accent: 'crimson',
}
const state: PublicGameState = {
  started: true,
  currentDate: '2005-09-17',
  scene: { location: 'MDC D 区' },
  protagonist: { name: '伊莱亚斯·诺伦', conditions: [], resources: { 体力: 76, 饮水: 2 } },
  relationships: [], faction: [], inventory: [], memories: [], quests: [], eventLog: [],
  statusLines: ['D 区走廊仍然安静。'], extensions: {}, checkpoints: { count: 2, canRollback: true, activeTurn: 2 },
}
const summary: SessionSummary = {
  id: 'session-1', cardId: card.id, title: 'D 区封锁线', updatedAt: 1_723_000_000_000, running: false, blank: false, state,
}
const promptSettings: PromptSession = {
  available: true,
  revision: 4,
  coreProfileIds: ['rp-narrative-base', 'zombie-world'],
  optionalProfiles: [{
    id: 'dreamwhale-v3-agent',
    name: '梦鲸思客 V3 · Agent 特调',
    description: 'optional',
    version: 1,
    entries: [
      { id: 'dream-style', name: '梦鲸·实验文风（Agent）', slot: 'render-style', group: 'style', selection: 'single', tags: ['rp'], enabledByDefault: false, renderOnly: true },
      { id: 'dream-slow', name: '梦鲸·缓慢推进（Agent）', slot: 'render-style', group: 'pacing', selection: 'single', tags: ['rp'], enabledByDefault: false, renderOnly: true },
    ],
  }],
  enabledEntryIds: [],
  appliesFromNextTurn: false,
}
const detail: SessionDetail = {
  session: summary,
  card,
  messages: [{ id: 'm1', seq: 1, role: 'gm', text: '冷风穿过 D 区铁门。<script>LEAK</script>', createdAt: 1_723_000_000_000, status: 'complete' }],
  state,
  prompt: promptSettings,
}

let streamListener: ((event: StreamEvent) => void) | undefined
let streamDisconnect: (() => void) | undefined

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(api.cards).mockResolvedValue([card])
  vi.mocked(api.sessions).mockResolvedValue([summary])
  vi.mocked(api.session).mockResolvedValue(detail)
  vi.mocked(api.create).mockResolvedValue(detail)
  vi.mocked(api.prompt).mockResolvedValue({ accepted: true })
  vi.mocked(api.cancel).mockResolvedValue({ accepted: true })
  vi.mocked(api.rollback).mockResolvedValue({ accepted: true })
  vi.mocked(api.fork).mockResolvedValue(detail)
  vi.mocked(api.autoplay).mockResolvedValue({ accepted: true })
  vi.mocked(api.promptSettings).mockResolvedValue(promptSettings)
  vi.mocked(api.applyPromptSettings).mockImplementation(async (_id, enabledEntryIds, expectedRevision) => ({
    ...promptSettings, revision: expectedRevision + 1, enabledEntryIds, appliesFromNextTurn: true,
  }))
  vi.mocked(api.resetPromptSettings).mockImplementation(async (_id, expectedRevision) => ({
    ...promptSettings, revision: expectedRevision + 1, enabledEntryIds: [], appliesFromNextTurn: true,
  }))
  vi.mocked(connectEvents).mockImplementation((_id, onEvent, onDisconnect) => {
    streamListener = onEvent
    streamDisconnect = onDisconnect
    return vi.fn()
  })
  useStudio.setState({
    cards: [], sessions: [], current: null, streaming: {}, loading: true,
    connected: false, error: null, sheet: null, inspectorTab: 'status',
    promptDraftEntryIds: [], promptBusy: false, promptNotice: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.clearAllMocks()
  streamListener = undefined
  streamDisconnect = undefined
})

describe('DSH RP Studio', () => {
  it('shows a loading state while the initial public snapshot is pending', () => {
    vi.mocked(api.cards).mockReturnValue(new Promise(() => {}))
    vi.mocked(api.sessions).mockReturnValue(new Promise(() => {}))
    render(<App />)
    expect(screen.getByLabelText('正在载入 RP Studio')).toBeInTheDocument()
  })

  it('loads a persisted session, sanitizes narrative HTML, and sends a player action', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'D 区封锁线' })).toBeInTheDocument()
    expect(screen.getByText('冷风穿过 D 区铁门。')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()

    const input = screen.getByLabelText('玩家行动')
    fireEvent.change(input, { target: { value: '查看铁门旁的脚印' } })
    fireEvent.click(screen.getByRole('button', { name: '发送行动' }))
    expect(await screen.findByText('查看铁门旁的脚印')).toBeInTheDocument()
    expect(api.prompt).toHaveBeenCalledWith('session-1', '查看铁门旁的脚印')
  })

  it('assembles streaming deltas and replaces them with the completed message', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    act(() => {
      streamListener?.({ type: 'message.delta', sessionId: 'session-1', messageId: 'stream-2-0', text: '夜色' })
      streamListener?.({ type: 'message.delta', sessionId: 'session-1', messageId: 'stream-2-0', text: '降临。' })
    })
    expect(screen.getByText('夜色降临。')).toBeInTheDocument()
    act(() => {
      streamListener?.({
        type: 'message.completed', sessionId: 'session-1',
        message: { id: 'm2', seq: 2, role: 'gm', text: '夜色降临。', createdAt: 1_723_000_001_000, status: 'complete' },
      })
    })
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
    expect(screen.getByText('夜色降临。')).toBeInTheDocument()
  })

  it('reloads the public snapshot after an SSE reconnect', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    expect(api.session).toHaveBeenCalledTimes(1)
    act(() => streamDisconnect?.())
    act(() => streamListener?.({ type: 'connected', sessionId: 'session-1' }))
    await waitFor(() => expect(api.session).toHaveBeenCalledTimes(2))
  })

  it('marks the event stream connected and invokes rollback from the narrative header', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    act(() => streamListener?.({ type: 'connected', sessionId: 'session-1' }))
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '回退上一轮' }))
    await waitFor(() => expect(api.rollback).toHaveBeenCalledWith('session-1'))
  })

  it('retries initial loading with bounded backoff after DSH is unavailable', async () => {
    vi.useFakeTimers()
    vi.mocked(api.cards)
      .mockRejectedValueOnce(new Error('DSH 当前不可用'))
      .mockResolvedValue([card])
    render(<App />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('alert')).toHaveTextContent('DSH 当前不可用')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('heading', { name: 'D 区封锁线' })).toBeInTheDocument()
    expect(api.cards).toHaveBeenCalledTimes(2)
  })

  it('disables destructive controls while a turn is running', async () => {
    vi.mocked(api.sessions).mockResolvedValue([{ ...summary, running: true }])
    vi.mocked(api.session).mockResolvedValue({ ...detail, session: { ...summary, running: true } })
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    expect(screen.getByRole('button', { name: '回退上一轮' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '从当前档案创建分支' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '停止当前回合' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '停止当前回合' }))
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('session-1'))
  })

  it('starts with every optional narrative method off and applies profile entries to the next turn', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    fireEvent.click(screen.getByRole('tab', { name: '方法' }))

    expect(screen.getByText('Agent runtime core')).toBeInTheDocument()
    expect(screen.getByText(/当前没有启用任何叙事方法/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '梦鲸·实验文风（Agent）' })).not.toBeChecked()

    fireEvent.click(screen.getByRole('checkbox', { name: '梦鲸思客 V3 · Agent 特调全部方法' }))
    expect(screen.getByRole('checkbox', { name: '梦鲸·实验文风（Agent）' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '梦鲸·缓慢推进（Agent）' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '应用到下一轮' }))

    await waitFor(() => expect(api.applyPromptSettings).toHaveBeenCalledWith('session-1', ['dream-style', 'dream-slow'], 4))
    expect(await screen.findByText('叙事方法已保存，将从下一轮生效。')).toBeInTheDocument()
    expect(screen.getByText(/NEXT TURN/)).toBeInTheDocument()
  })

  it('keeps the composer usable when optional prompt methods are unavailable', async () => {
    vi.mocked(api.session).mockResolvedValue({
      ...detail,
      prompt: { ...promptSettings, available: false, message: '叙事方法服务暂不可用；Agent runtime 核心仍保持启用。', optionalProfiles: [] },
    })
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    fireEvent.click(screen.getByRole('tab', { name: '方法' }))
    expect(screen.getByText(/叙事方法服务暂不可用/)).toBeInTheDocument()
    expect(screen.getByLabelText('玩家行动')).toBeEnabled()
  })

  it('does not apply a stale prompt response to a newly selected session', async () => {
    let resolveApply!: (value: PromptSession) => void
    vi.mocked(api.applyPromptSettings).mockReturnValueOnce(new Promise(resolve => { resolveApply = resolve }))
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    act(() => useStudio.getState().togglePromptEntry('dream-style', true))
    let applying!: Promise<void>
    act(() => { applying = useStudio.getState().applyPromptSettings() })
    expect(screen.getByLabelText('玩家行动')).toBeDisabled()

    const secondPrompt = { ...promptSettings, revision: 9, enabledEntryIds: ['dream-slow'] }
    vi.mocked(api.session).mockResolvedValueOnce({
      ...detail,
      session: { ...summary, id: 'session-2', title: '第二档案' },
      prompt: secondPrompt,
    })
    await act(async () => { await useStudio.getState().selectSession('session-2') })
    await act(async () => {
      resolveApply({ ...promptSettings, revision: 5, enabledEntryIds: ['dream-style'], appliesFromNextTurn: true })
      await applying
    })

    expect(useStudio.getState().current?.session.id).toBe('session-2')
    expect(useStudio.getState().promptDraftEntryIds).toEqual(['dream-slow'])
    expect(useStudio.getState().promptNotice).toBeNull()
  })

  it('opens the campaign sheet for compact navigation', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    const trigger = screen.getByRole('button', { name: '打开世界与会话' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: '世界与会话' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭世界与会话' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '世界与会话' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('shows the card selection state when no sessions exist', async () => {
    vi.mocked(api.sessions).mockResolvedValue([])
    render(<App />)
    expect(await screen.findByRole('heading', { name: '选择世界档案' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '新建档案' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('zombie-world'))
  })

  it('prefers a started campaign over an external maintenance session', async () => {
    vi.mocked(api.sessions).mockResolvedValue([
      { ...summary, id: 'maintenance-new', title: '维护档案', updatedAt: summary.updatedAt + 1, state: { ...state, started: false } },
      summary,
    ])
    render(<App />)
    await screen.findByRole('heading', { name: 'D 区封锁线' })
    expect(api.session).toHaveBeenCalledWith('session-1')
  })

  it('keeps the last selected campaign when session loads resolve out of order', async () => {
    const secondSummary = { ...summary, id: 'session-2', title: '第二档案' }
    const resolvers = new Map<string, (value: SessionDetail) => void>()
    vi.mocked(api.session).mockImplementation(id => new Promise(resolve => resolvers.set(id, resolve)))
    useStudio.setState({ current: detail, sessions: [summary, secondSummary], loading: false, connected: true })

    const first = useStudio.getState().selectSession('session-1')
    const second = useStudio.getState().selectSession('session-2')
    resolvers.get('session-2')?.({ ...detail, session: secondSummary })
    await second
    resolvers.get('session-1')?.(detail)
    await first

    expect(useStudio.getState().current?.session.id).toBe('session-2')
    expect(useStudio.getState().connected).toBe(false)
  })
})
