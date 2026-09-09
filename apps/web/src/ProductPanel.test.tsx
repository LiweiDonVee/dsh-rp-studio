import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductPanel, usePagedProduct, useProductPage } from './ProductPanel.js'
import { ProductApiError, productApi } from './ProductApi.js'
import { api as studioApi } from './api.js'

vi.mock('./api.js', () => ({ api: { sessions: vi.fn() } }))
vi.mock('./ProductApi.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./ProductApi.js')>()
  return {
    ...actual,
    productApi: {
      status: vi.fn(), pairing: vi.fn(), clients: vi.fn(), assets: vi.fn(), ledger: vi.fn(), knowledge: vi.fn(),
      memories: vi.fn(), relationships: vi.fn(), locations: vi.fn(), notifications: vi.fn(), backups: vi.fn(),
      uploadAsset: vi.fn(), downloadAsset: vi.fn(), createLedger: vi.fn(), createKnowledge: vi.fn(), updateKnowledge: vi.fn(), deleteKnowledge: vi.fn(), acknowledge: vi.fn(), createBackup: vi.fn(), stageRestore: vi.fn(), commitRestore: vi.fn(), createPairingCode: vi.fn(), revokeClient: vi.fn(),
    },
  }
})

const page = { items: [], nextCursor: null }
const status = { apiVersion: 1 as const, dshCompatibility: '0.1.2-rc.1' as const, storage: 'ready' as const, schemaVersion: 1, projection: 'current' as const, pairing: { enabled: true, listener: 'https-lan' as const } }

afterEach(cleanup)

beforeEach(() => {
  history.replaceState({}, '', '/product?sessionId=session-1')
  vi.clearAllMocks()
  vi.mocked(studioApi.sessions).mockResolvedValue([])
  vi.mocked(productApi.assets).mockResolvedValue(page)
  vi.mocked(productApi.ledger).mockResolvedValue(page)
  vi.mocked(productApi.knowledge).mockResolvedValue({ items: [
    { id: 'user-1', text: '玩家确认的安全屋位置', source: 'user', createdAt: '2026-09-08T10:00:00.000Z', updatedAt: '2026-09-08T10:00:00.000Z' },
    { id: 'rp-1', text: '走廊中发现脚印', source: 'rp-projection', provenance: { branchId: 'branch-1', sourceSeq: 4 }, createdAt: '2026-09-08T10:00:00.000Z', updatedAt: '2026-09-08T10:00:00.000Z' },
  ], nextCursor: null })
  vi.mocked(productApi.memories).mockResolvedValue(page)
  vi.mocked(productApi.relationships).mockResolvedValue(page)
  vi.mocked(productApi.locations).mockResolvedValue(page)
  vi.mocked(productApi.notifications).mockResolvedValue({ items: [], cursor: 'c1', resetRequired: false })
  vi.mocked(productApi.backups).mockResolvedValue(page)
  vi.mocked(productApi.status).mockResolvedValue(status)
  vi.mocked(productApi.pairing).mockResolvedValue(status.pairing)
  vi.mocked(productApi.clients).mockResolvedValue([])
})

describe('ProductPanel', () => {
  it('aborts and ignores a slower previous scope response', async () => {
    let resolveA!: (value: string) => void; let resolveB!: (value: string) => void; let signalA: AbortSignal | undefined
    const loader = (scope: string, signal: AbortSignal) => new Promise<string>(resolve => { if (scope === 'A') { signalA = signal; resolveA = resolve } else resolveB = resolve })
    const hook = renderHook(({ scope }) => useProductPage(signal => loader(scope, signal), [scope]), { initialProps: { scope: 'A' } })
    hook.rerender({ scope: 'B' })
    await act(async () => { resolveB('B data'); await Promise.resolve() })
    await act(async () => { resolveA('stale A data'); await Promise.resolve() })
    expect(signalA?.aborted).toBe(true)
    expect(hook.result.current.data).toBe('B data')
  })

  it('clears stale page data while the next scope is loading', async () => {
    let resolveA!: (value: string) => void
    const loader = (scope: string) => scope === 'A'
      ? new Promise<string>(resolve => { resolveA = resolve })
      : Promise.resolve('B data')
    const hook = renderHook(({ scope }) => useProductPage(() => loader(scope), [scope]), { initialProps: { scope: 'A' } })
    await act(async () => { resolveA('A data'); await Promise.resolve() })
    expect(hook.result.current.data).toBe('A data')
    hook.rerender({ scope: 'B' })
    expect(hook.result.current.data).toBeNull()
    await waitFor(() => expect(hook.result.current.data).toBe('B data'))
  })

  it('does not append an old cursor page after the scope changes', async () => {
    let resolveMore!: (value: { items: string[]; nextCursor: string | null }) => void
    const loader = (scope: string, cursor: string | undefined) => cursor ? new Promise<{ items: string[]; nextCursor: string | null }>(resolve => { resolveMore = resolve }) : Promise.resolve({ items: [`${scope}-first`], nextCursor: scope === 'A' ? 'A-next' : null })
    const hook = renderHook(({ scope }) => usePagedProduct((cursor, _signal) => loader(scope, cursor), [scope]), { initialProps: { scope: 'A' } })
    await waitFor(() => expect(hook.result.current.data?.items).toEqual(['A-first']))
    await act(async () => { void hook.result.current.loadMore(); await Promise.resolve() })
    hook.rerender({ scope: 'B' })
    await waitFor(() => expect(hook.result.current.data?.items).toEqual(['B-first']))
    await act(async () => { resolveMore({ items: ['stale A-more'], nextCursor: null }); await Promise.resolve() })
    expect(hook.result.current.data?.items).toEqual(['B-first'])
  })

  it('keeps management separate from the narrative and scopes assets to the current session', async () => {
    render(<ProductPanel />)
    expect(await screen.findByRole('heading', { name: '资产与表情包' })).toBeInTheDocument()
    expect(screen.getByText('当前故事档案')).toBeInTheDocument()
    expect(productApi.assets).toHaveBeenCalledWith('session-1', undefined, undefined, expect.any(AbortSignal))
  })

  it('visually and behaviorally separates authoritative user notes from read-only RP knowledge', async () => {
    render(<ProductPanel />)
    fireEvent.click(screen.getByRole('button', { name: /用户知识笔记/ }))
    expect(await screen.findByText('用户笔记 · 可编辑')).toBeInTheDocument()
    expect(screen.getByText('只读剧情资料', { selector: '.product-source-badge' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('用户知识笔记')).toHaveValue('玩家确认的安全屋位置')
  })

  it('does not offer restore commit before a backup has been staged', async () => {
    vi.mocked(productApi.backups).mockResolvedValue({ items: [{
      id: 'backup-1', schemaVersion: 1, scope: { workspaceId: 'workspace-1', sessionId: 'session-1', cardId: 'card-1', branchId: 'branch-1' },
      createdAt: '2026-09-08T10:00:00.000Z', state: 'ready', manifestHash: `sha256:${'a'.repeat(64)}`,
      includes: { authoritativeAppData: true, rpProjections: true, dshSessions: false },
    }], nextCursor: null })
    vi.mocked(productApi.stageRestore).mockResolvedValue({ backupId: 'backup-1', restoreToken: 'restore-token-long-enough', expiresAt: '2099-09-08T10:05:00.000Z', manifestHash: `sha256:${'a'.repeat(64)}` })
    render(<ProductPanel />)
    fireEvent.click(screen.getByRole('button', { name: /备份与恢复/ }))
    expect(await screen.findByRole('button', { name: '验证恢复' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认并恢复' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '验证恢复' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并恢复' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '确认并恢复' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('确认恢复 backup-1'))
    expect(screen.getByRole('button', { name: '确认并恢复' })).toBeEnabled()
  })

  it('keeps global pairing reachable and shows storage-unavailable status errors', async () => {
    vi.mocked(productApi.status).mockRejectedValue(new ProductApiError('本地资料服务尚未就绪。', 'storage-unavailable', 503))
    render(<ProductPanel />)
    fireEvent.click(screen.getByRole('button', { name: /手机配对/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('storage-unavailable')
    expect(screen.getByRole('heading', { name: '手机配对' })).toBeInTheDocument()
  })
})
