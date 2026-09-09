import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductBootstrap, ProductMemory, ProductNotification } from '@dsh-rp/protocol'
import { CompanionPage } from './CompanionPage.js'
import { ProductApi, ProductApiError, type ProductPage } from './ProductApi.js'

const roster: ProductBootstrap = {
  clientId: 'phone-1', clientName: '手机', scopes: ['product:read'],
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  sessions: [
    { sessionId: 'A', cardId: 'card-1', title: '故事 A' },
    { sessionId: 'B', cardId: 'card-1', title: '故事 B' },
  ],
}
type Stream = {
  sessionId: string
  event: Parameters<ProductApi['subscribeNotifications']>[1]
  error: Parameters<ProductApi['subscribeNotifications']>[2]
  stop: ReturnType<typeof vi.fn>
}
let streams: Stream[]

function memory(sessionId: string, text = `记忆 ${sessionId}`): ProductPage<ProductMemory> {
  return { items: [{ id: `${sessionId}-memory`, sessionId, branchId: sessionId, sourceSeq: 1, text }], nextCursor: null }
}
function notification(index: number): ProductNotification {
  return { id: `n-${index}`, cursor: `c-${index}`, type: 'story', title: `通知 ${index}`, body: `消息 ${index}`, acknowledged: false, createdAt: new Date(1_800_000_000_000 + index * 1000).toISOString() }
}
async function pair() {
  fireEvent.change(screen.getByLabelText('一次性配对短码'), { target: { value: 'one-time-code-123456789' } })
  fireEvent.click(screen.getByRole('button', { name: '确认配对' }))
  await screen.findByLabelText('已授权故事档案')
}
function select(sessionId: string) {
  fireEvent.change(screen.getByLabelText('已授权故事档案'), { target: { value: sessionId } })
}

beforeEach(() => {
  streams = []
  vi.spyOn(ProductApi.prototype, 'confirmPairing').mockResolvedValue({ clientId: roster.clientId, token: 'a'.repeat(48), sessionIds: ['A', 'B'], scopes: ['product:read'], expiresAt: roster.expiresAt })
  vi.spyOn(ProductApi.prototype, 'bootstrap').mockResolvedValue(roster)
  vi.spyOn(ProductApi.prototype, 'memories').mockImplementation(async id => memory(id))
  vi.spyOn(ProductApi.prototype, 'relationships').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(ProductApi.prototype, 'locations').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(ProductApi.prototype, 'subscribeNotifications').mockImplementation((sessionId, event, error) => {
    const stop = vi.fn(); streams.push({ sessionId, event, error, stop }); return stop
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('companion session isolation', () => {
  it('clears old content on selection, cancels pending reads and ignores inverse responses and old stream events', async () => {
    render(<CompanionPage />); await pair()
    fireEvent.click(screen.getByRole('button', { name: '读取公开状态' }))
    await screen.findByText('记忆 A')
    const oldStream = streams[0]!
    act(() => oldStream.event({ type: 'notification', item: notification(1) }))
    expect(screen.getByText('通知 1')).toBeInTheDocument()
    let resolveA!: (value: ProductPage<ProductMemory>) => void
    vi.mocked(ProductApi.prototype.memories).mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '读取公开状态' }))
    const signal = vi.mocked(ProductApi.prototype.memories).mock.calls.at(-1)?.[2]
    select('B')
    expect(screen.queryByText('记忆 A')).not.toBeInTheDocument()
    expect(screen.queryByText('通知 1')).not.toBeInTheDocument()
    expect(signal?.aborted).toBe(true)
    expect(oldStream.stop).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '读取公开状态' }))
    await screen.findByText('记忆 B')
    await act(async () => { resolveA(memory('A', '迟到的 A')); await Promise.resolve() })
    act(() => { oldStream.event({ type: 'notification', item: notification(2) }); oldStream.error(new ProductApiError('旧连接断开', 'unauthorized', 401)) })
    expect(screen.getByText('记忆 B')).toBeInTheDocument()
    expect(screen.queryByText('迟到的 A')).not.toBeInTheDocument()
    expect(screen.queryByText('通知 2')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['http', 'stream'] as const)('removes authenticated content and stops work after %s revocation', async source => {
    render(<CompanionPage />); await pair()
    fireEvent.click(screen.getByRole('button', { name: '读取公开状态' }))
    await screen.findByText('记忆 A')
    act(() => streams[0]!.event({ type: 'notification', item: notification(1) }))
    const revoked = new ProductApiError('访问已撤销，请重新配对。', 'unauthorized', 401)
    if (source === 'http') {
      vi.mocked(ProductApi.prototype.memories).mockRejectedValueOnce(revoked)
      fireEvent.click(screen.getByRole('button', { name: '读取公开状态' }))
    } else act(() => streams[0]!.error(revoked))
    await screen.findByRole('button', { name: '确认配对' })
    expect(screen.getByRole('alert')).toHaveTextContent('unauthorized')
    expect(screen.queryByLabelText('已授权故事档案')).not.toBeInTheDocument()
    expect(screen.queryByText('记忆 A')).not.toBeInTheDocument()
    expect(screen.queryByText('通知 1')).not.toBeInTheDocument()
    expect(screen.getByLabelText('一次性配对短码')).toHaveValue('')
    expect(streams[0]!.stop).toHaveBeenCalledOnce()
    act(() => streams[0]!.event({ type: 'notification', item: notification(2) }))
    expect(screen.queryByText('通知 2')).not.toBeInTheDocument()
  })

  it('bounds and deduplicates reset snapshots and incoming notifications to the newest 100', async () => {
    render(<CompanionPage />); await pair()
    const stream = streams[0]!
    const items = Array.from({ length: 110 }, (_, index) => notification(index))
    act(() => stream.event({ type: 'reset', items: [...items, notification(109)] }))
    await waitFor(() => expect(screen.getAllByText(/^通知 \d+$/u)).toHaveLength(100))
    expect(screen.queryByText('通知 9')).not.toBeInTheDocument()
    act(() => stream.event({ type: 'notification', item: notification(110) }))
    expect(screen.getAllByText(/^通知 \d+$/u)).toHaveLength(100)
    expect(screen.queryByText('通知 10')).not.toBeInTheDocument()
    expect(screen.getByText('通知 110')).toBeInTheDocument()
  })

  it('aborts all reads and closes the stream when the page unmounts', async () => {
    const view = render(<CompanionPage />); await pair()
    vi.mocked(ProductApi.prototype.memories).mockImplementationOnce(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: '读取公开状态' }))
    const signals = [ProductApi.prototype.memories, ProductApi.prototype.relationships, ProductApi.prototype.locations].map(method => vi.mocked(method).mock.calls.at(-1)?.[2])
    view.unmount()
    expect(signals.every(signal => signal?.aborted)).toBe(true)
    expect(streams[0]!.stop).toHaveBeenCalledOnce()
  })
})
