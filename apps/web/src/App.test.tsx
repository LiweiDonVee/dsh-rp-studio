import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card, PublicGameState, SessionDetail, SessionSummary, StreamEvent } from '@dsh-rp/protocol'
import { App } from './App.js'
import { api, connectEvents } from './api.js'
import { useStudio } from './store.js'

vi.mock('./api.js', () => ({
  api: {
    cards: vi.fn(), sessions: vi.fn(), session: vi.fn(), create: vi.fn(),
    prompt: vi.fn(), cancel: vi.fn(), rollback: vi.fn(), fork: vi.fn(), autoplay: vi.fn(),
  },
  connectEvents: vi.fn(),
}))

const card: Card = {
  id: 'rp-runtime', title: '魔药宗师', description: '档案', world: '1994 · 世界杯营地', protagonist: '加斯帕', art: 'potion-master', accent: 'jade',
}
const state: PublicGameState = {
  started: true,
  currentDate: '1994-08-20',
  scene: { location: '营地' },
  protagonist: { name: '加斯帕', conditions: [], resources: { 金加隆: 12 } },
  relationships: [], faction: [], inventory: [], memories: [], quests: [], eventLog: [],
  statusLines: ['营火仍亮着。'], extensions: {}, checkpoints: { count: 2, canRollback: true, activeTurn: 2 },
}
const summary: SessionSummary = {
  id: 'session-1', cardId: card.id, title: '营地余烬', updatedAt: 1_723_000_000_000, running: false, blank: false, state,
}
const detail: SessionDetail = {
  session: summary,
  card,
  messages: [{ id: 'm1', seq: 1, role: 'gm', text: '冷风卷过营地。<script>LEAK</script>', createdAt: 1_723_000_000_000, status: 'complete' }],
  state,
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
  vi.mocked(connectEvents).mockImplementation((_id, onEvent, onDisconnect) => {
    streamListener = onEvent
    streamDisconnect = onDisconnect
    return vi.fn()
  })
  useStudio.setState({
    cards: [], sessions: [], current: null, streaming: {}, loading: true,
    connected: false, error: null, sheet: null, inspectorTab: 'status',
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
    expect(await screen.findByRole('heading', { name: '营地余烬' })).toBeInTheDocument()
    expect(screen.getByText('冷风卷过营地。')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()

    const input = screen.getByLabelText('玩家行动')
    fireEvent.change(input, { target: { value: '查看营火旁的脚印' } })
    fireEvent.click(screen.getByRole('button', { name: '发送行动' }))
    expect(await screen.findByText('查看营火旁的脚印')).toBeInTheDocument()
    expect(api.prompt).toHaveBeenCalledWith('session-1', '查看营火旁的脚印')
  })

  it('assembles streaming deltas and replaces them with the completed message', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: '营地余烬' })
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
    await screen.findByRole('heading', { name: '营地余烬' })
    expect(api.session).toHaveBeenCalledTimes(1)
    act(() => streamDisconnect?.())
    act(() => streamListener?.({ type: 'connected', sessionId: 'session-1' }))
    await waitFor(() => expect(api.session).toHaveBeenCalledTimes(2))
  })

  it('marks the event stream connected and invokes rollback from the narrative header', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: '营地余烬' })
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
    expect(screen.getByRole('heading', { name: '营地余烬' })).toBeInTheDocument()
    expect(api.cards).toHaveBeenCalledTimes(2)
  })

  it('disables destructive controls while a turn is running', async () => {
    vi.mocked(api.sessions).mockResolvedValue([{ ...summary, running: true }])
    vi.mocked(api.session).mockResolvedValue({ ...detail, session: { ...summary, running: true } })
    render(<App />)
    await screen.findByRole('heading', { name: '营地余烬' })
    expect(screen.getByRole('button', { name: '回退上一轮' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '从当前档案创建分支' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '停止当前回合' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '停止当前回合' }))
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('session-1'))
  })

  it('opens the campaign sheet for compact navigation', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: '营地余烬' })
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
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('rp-runtime'))
  })

  it('prefers a started campaign over an external maintenance session', async () => {
    vi.mocked(api.sessions).mockResolvedValue([
      { ...summary, id: 'maintenance-new', title: '维护档案', updatedAt: summary.updatedAt + 1, state: { ...state, started: false } },
      summary,
    ])
    render(<App />)
    await screen.findByRole('heading', { name: '营地余烬' })
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
