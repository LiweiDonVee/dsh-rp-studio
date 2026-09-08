import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DshClient, DshHistoryEntry, DshStreamFrame } from './dsh/client.js'
import { DshRpcError } from './dsh/wire.js'
import { GatewayError } from './errors.js'
import type { PromptPresetsClient } from './prompt-presets-client.js'
import { SessionService } from './session-service.js'

function assistantEvent(seq: number, text: string): DshHistoryEntry {
  return {
    event: {
      seq,
      time: 1_700_000_000_000 + seq,
      type: 'assistant/message',
      data: {
        message: {
          id: `gm-${seq}`,
          source: { kind: 'model' },
          content: [{ type: 'text', text }],
        },
      },
      surfaceOp: 'append',
    },
  }
}

async function fixture(
  historyAll: DshClient['historyAll'],
  prompt: DshClient['prompt'] = async () => ({ accepted: true }),
  promptPresets?: PromptPresetsClient,
  customize?: (dsh: DshClient, home: string) => void | Promise<void>,
): Promise<{
  service: SessionService
  home: string
  emit(frame: DshStreamFrame): void
  disconnect(): void
  reconnect(): void
}> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-rp-session-'))
  const preset = join(home, '.agent-presets', 'fixture-card')
  await mkdir(preset, { recursive: true })
  await writeFile(join(preset, 'rp-card.json'), JSON.stringify({
    schemaVersion: 1,
    runtime: 'dsh-rp',
    id: 'fixture-card',
    title: '测试卡片',
    world: '测试环境',
    protagonist: '测试角色',
    art: 'fixture-card',
    accent: 'crimson',
  }))
  await writeFile(join(preset, 'prompt-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    cardId: 'fixture-card',
    baseProfiles: ['rp-narrative-base'],
    cardProfiles: ['fixture-card'],
    optionalProfiles: ['fixture-profile'],
  }))

  let emit = (_frame: DshStreamFrame): void => {}
  let disconnect = (): void => {}
  let reconnect = (): void => {}
  const dsh: DshClient = {
    hostDescribe: async () => ({ version: 'test' }),
    listPresets: async () => [{ id: 'fixture-card', trust: 'user' }],
    listSessions: async () => [{
      sessionId: 'session-1',
      updatedAt: 1,
      running: false,
      blank: false,
      agentPreset: 'fixture-card',
      projections: {
        asOfSeq: 1,
        values: { 'rp-state': { game: { started: true, statusLines: [] }, meta: { checkpoints: [] } } },
      },
    }],
    listWorkspaces: async () => ({ items: [], archivedSessionIds: [] }),
    createWorkspace: async path => ({
      workspace: {
        workspaceId: 'workspace-fixture-card', path, title: 'fixture-card', sessionIds: [],
        createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
      },
      created: true,
    }),
    renameWorkspace: async (workspaceId, title) => ({
      workspace: {
        workspaceId, path: join(home, 'rp-workspaces', 'fixture-card'), title, sessionIds: [],
        createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
      },
    }),
    createSession: async () => ({ sessionId: 'session-1' }),
    history: async () => ({ events: [], hasMore: false }),
    historyAll,
    prompt,
    cancel: async () => ({ accepted: true }),
    fork: async () => ({ sessionId: 'session-1' }),
    connectStreams: (onFrame, onClose, onOpen) => {
      emit = onFrame
      disconnect = () => onClose?.()
      reconnect = () => onOpen?.()
      return () => {}
    },
  }
  await customize?.(dsh, home)
  const service = new SessionService({ dsh, dshHome: home, ...(promptPresets ? { promptPresets } : {}) })
  await service.start()
  return {
    service,
    home,
    emit: frame => emit(frame),
    disconnect: () => disconnect(),
    reconnect: () => reconnect(),
  }
}

const services: SessionService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
})

describe('SessionService transcript recovery', () => {
  it('shares an in-flight history load across concurrent detail reads', async () => {
    let resolveHistory!: (events: DshHistoryEntry[]) => void
    const historyAll = vi.fn(() => new Promise<DshHistoryEntry[]>(resolve => { resolveHistory = resolve }))
    const harness = await fixture(historyAll)
    services.push(harness.service)
    const first = harness.service.session('session-1')
    await vi.waitFor(() => expect(historyAll).toHaveBeenCalledTimes(1))
    let secondResolved = false
    const second = harness.service.session('session-1').then(detail => { secondResolved = true; return detail })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(secondResolved).toBe(false)
    resolveHistory([assistantEvent(1, 'complete history')])
    for (const detail of await Promise.all([first, second])) expect(detail.messages).toMatchObject([{ text: 'complete history' }])
    expect(historyAll).toHaveBeenCalledTimes(1)
  })

  it('invalidates the transcript on a replacement follow snapshot', async () => {
    let history = [assistantEvent(1, 'old')]
    const harness = await fixture(async () => history)
    services.push(harness.service)
    await harness.service.session('session-1')
    const events: unknown[] = []
    harness.service.subscribe('session-1', event => events.push(event))
    history = [assistantEvent(2, 'reconnected')]
    harness.emit({ type: 'session/subscribed', sessionId: 'session-1', lastSeq: 2 })
    expect((await harness.service.session('session-1')).messages).toMatchObject([{ text: 'reconnected' }])
    expect(events).toContainEqual({ type: 'session.rebased', sessionId: 'session-1' })
  })

  it('keeps send_message/team traffic out of the player transcript', async () => {
    const hidden: DshHistoryEntry[] = ['subagent', 'team', 'agent'].map((kind, seq) => ({ event: {
      seq, time: 1, type: 'user/message', surfaceOp: 'append',
      data: { id: kind, source: { kind }, content: [{ type: 'text', text: 'secret-canary' }] },
    } }))
    const harness = await fixture(async () => [...hidden, assistantEvent(5, 'public story')])
    services.push(harness.service)
    const detail = await harness.service.session('session-1')
    expect(detail.messages).toHaveLength(1)
    expect(JSON.stringify(detail)).not.toContain('secret-canary')
  })
  it('hides a runtime template from creation while preserving its existing sessions', async () => {
    const harness = await fixture(async () => [], undefined, undefined, async (dsh, home) => {
      await mkdir(join(home, '.agent-presets', 'rp-runtime'), { recursive: true })
      await writeFile(join(home, '.agent-presets', 'rp-runtime', 'rp-card.json'), JSON.stringify({
        schemaVersion: 1,
        runtime: 'dsh-rp',
        id: 'rp-runtime',
        kind: 'template',
        title: 'RP Runtime 基础模板',
        world: null,
        protagonist: null,
        art: 'runtime-template',
        accent: 'graphite',
      }))
      dsh.listPresets = async () => [
        { id: 'fixture-card', trust: 'user' },
        { id: 'rp-runtime', trust: 'user' },
      ]
      dsh.listSessions = async () => [{
        sessionId: 'session-1', updatedAt: 1, running: false, blank: false, agentPreset: 'rp-runtime',
        projections: {
          asOfSeq: 1,
          values: { 'rp-state': { game: { started: true, statusLines: [] }, meta: { checkpoints: [] } } },
        },
      }]
    })
    services.push(harness.service)

    expect(await harness.service.cards()).toMatchObject([{ id: 'fixture-card' }])
    expect(await harness.service.sessions()).toMatchObject([{
      id: 'session-1',
      cardId: 'rp-runtime',
      title: 'RP Runtime 基础模板',
    }])
    await expect(harness.service.session('session-1')).resolves.toMatchObject({
      card: { id: 'rp-runtime', kind: 'template', world: '未配置世界', protagonist: '未配置角色' },
    })
    await expect(harness.service.create('rp-runtime')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('adopts migrated card sessions into their native DSH workspace on startup', async () => {
    const createSession = vi.fn<DshClient['createSession']>(async payload => ({ sessionId: payload.sessionId ?? 'new' }))
    const harness = await fixture(async () => [], undefined, undefined, (dsh, home) => {
      const cardPath = join(home, 'rp-workspaces', 'fixture-card')
      dsh.listSessions = async () => [{
        sessionId: 'session-migrated', updatedAt: 1, running: false, blank: false,
        cwd: cardPath, agentPreset: 'fixture-card',
      }]
      dsh.createSession = createSession
    })
    services.push(harness.service)

    expect(createSession).toHaveBeenCalledWith({
      sessionId: 'session-migrated', agentPreset: 'fixture-card', workspaceId: 'workspace-fixture-card',
    })
  })

  it('does not adopt an RP session until its durable cwd has been migrated', async () => {
    const createSession = vi.fn<DshClient['createSession']>(async payload => ({ sessionId: payload.sessionId ?? 'new' }))
    const harness = await fixture(async () => [], undefined, undefined, (dsh) => {
      dsh.listSessions = async () => [{
        sessionId: 'session-legacy', updatedAt: 1, running: false, blank: false,
        cwd: '/synthetic/legacy', agentPreset: 'fixture-card',
      }]
      dsh.createSession = createSession
    })
    services.push(harness.service)

    expect(createSession).not.toHaveBeenCalled()
  })

  it('creates sessions inside the card-specific native DSH workspace', async () => {
    const createWorkspace = vi.fn<DshClient['createWorkspace']>(async path => ({
      workspace: {
        workspaceId: 'workspace-fixture-card', path, title: 'fixture-card', sessionIds: [],
        createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
      },
      created: true,
    }))
    const renameWorkspace = vi.fn<DshClient['renameWorkspace']>(async (workspaceId, title) => ({
      workspace: {
        workspaceId, path: 'ignored', title, sessionIds: [],
        createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
      },
    }))
    const createSession = vi.fn<DshClient['createSession']>(async () => ({ sessionId: 'session-1' }))
    const harness = await fixture(async () => [], undefined, undefined, dsh => {
      dsh.createWorkspace = createWorkspace
      dsh.renameWorkspace = renameWorkspace
      dsh.createSession = createSession
    })
    services.push(harness.service)

    await harness.service.create('fixture-card')

    const cardPath = await realpath(join(harness.home, 'rp-workspaces', 'fixture-card'))
    expect(createWorkspace).toHaveBeenCalledWith(cardPath)
    expect(renameWorkspace).toHaveBeenCalledWith('workspace-fixture-card', '测试卡片 [fixture-card]')
    expect(createSession).toHaveBeenCalledWith({ agentPreset: 'fixture-card', workspaceId: 'workspace-fixture-card' })
  })

  it('excludes globally archived DSH sessions from Studio listings', async () => {
    const harness = await fixture(async () => [], undefined, undefined, (dsh) => {
      dsh.listSessions = async () => [
        {
          sessionId: 'session-active', updatedAt: 2, running: false, blank: false,
          agentPreset: 'fixture-card',
        },
        {
          sessionId: 'session-archived', updatedAt: 1, running: false, blank: true,
          agentPreset: 'fixture-card',
        },
      ]
      dsh.listWorkspaces = async () => ({ items: [], archivedSessionIds: ['session-archived'] })
    })
    services.push(harness.service)

    expect(await harness.service.sessions()).toMatchObject([{ id: 'session-active' }])
  })

  it('publishes a completed player message from the real DSH user event shape', async () => {
    const harness = await fixture(async () => [])
    services.push(harness.service)
    await harness.service.session('session-1')
    const completed = new Promise<Extract<import('@dsh-rp/protocol').StreamEvent, { type: 'message.completed' }>>((resolve) => {
      const unsubscribe = harness.service.subscribe('session-1', (event) => {
        if (event.type !== 'message.completed') return
        unsubscribe()
        resolve(event)
      })
    })

    harness.emit({
      type: 'session/event',
      sessionId: 'session-1',
      event: {
        seq: 2,
        time: 1_700_000_000_002,
        type: 'user/message',
        data: {
          id: 'player-2',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: '测试输入 E。' }],
        },
        surfaceOp: 'append',
      },
    })

    await expect(completed).resolves.toMatchObject({
      message: { id: 'player-2', role: 'player', text: '测试输入 E。' },
    })
  })

  it('invalidates cached history after both DSH streams recover', async () => {
    let history = [assistantEvent(1, '断线前')]
    const historyAll = vi.fn(async () => history)
    const harness = await fixture(historyAll)
    services.push(harness.service)

    expect((await harness.service.session('session-1')).messages.map(item => item.text)).toEqual(['断线前'])
    history = [assistantEvent(1, '断线前'), assistantEvent(2, '断线期间完成')]
    const recovered = new Promise<void>((resolve) => {
      const unsubscribe = harness.service.subscribe('session-1', (event) => {
        if (event.type !== 'connected') return
        unsubscribe()
        resolve()
      })
    })
    harness.disconnect()
    harness.reconnect()
    await recovered

    expect((await harness.service.session('session-1')).messages.map(item => item.text)).toEqual(['断线前', '断线期间完成'])
    expect(historyAll).toHaveBeenCalledTimes(2)
  })

  it('drops a stale RP projection when a newer DSH baseline no longer contains it', async () => {
    let includeProjection = true
    const harness = await fixture(async () => [], undefined, undefined, (dsh) => {
      dsh.listSessions = async () => [{
        sessionId: 'session-1', updatedAt: 1, running: false, blank: true, agentPreset: 'fixture-card',
        projections: {
          asOfSeq: includeProjection ? 1 : 2,
          values: includeProjection
            ? {
                'rp-state': {
                  game: {
                    started: false,
                    protagonist: { name: '测试角色', attributes: {} },
                    statusLines: ['陈旧世界状态'],
                  },
                  meta: { checkpoints: [] },
                },
              }
            : {},
        },
      }]
    })
    services.push(harness.service)

    expect((await harness.service.session('session-1')).state).toMatchObject({
      protagonist: { name: '测试角色' },
      statusLines: ['陈旧世界状态'],
    })

    includeProjection = false
    const refreshed = (await harness.service.session('session-1')).state
    expect(refreshed.protagonist).toBeUndefined()
    expect(refreshed.statusLines).toEqual([])
  })

  it('merges live events that arrive during the initial history fetch', async () => {
    let resolveHistory: ((events: DshHistoryEntry[]) => void) | undefined
    const historyAll = vi.fn(() => new Promise<DshHistoryEntry[]>(resolve => { resolveHistory = resolve }))
    const harness = await fixture(historyAll)
    services.push(harness.service)

    const detail = harness.service.session('session-1')
    await vi.waitFor(() => expect(historyAll).toHaveBeenCalledTimes(1))
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: assistantEvent(2, '实时到达').event })
    resolveHistory?.([assistantEvent(1, '历史记录')])

    await expect(detail).resolves.toMatchObject({
      messages: [{ text: '历史记录' }, { text: '实时到达' }],
    })
  })

  it('maps a command-error rollback to the public rollback contract', async () => {
    const harness = await fixture(
      async () => [],
      async () => { throw new DshRpcError('command-error', 'raw checkpoint internals') },
    )
    services.push(harness.service)
    let caught: unknown
    try { await harness.service.rollback('session-1') } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(GatewayError)
    expect(caught).toMatchObject({
      statusCode: 409,
      apiError: {
        code: 'rollback-unavailable',
        message: '当前没有可回退的 RP 回合。',
        upstreamCode: 'command-error',
      },
    })
    expect(JSON.stringify(caught)).not.toContain('raw checkpoint internals')
  })
})

describe('SessionService prompt settings', () => {
  function promptClient(): PromptPresetsClient {
    return {
      catalog: vi.fn(async () => ({ revision: 4, profiles: [{ id: 'fixture-profile', name: '测试方法组', version: 1 }] })),
      profile: vi.fn(async () => ({
        id: 'fixture-profile', name: '测试方法组', description: 'optional', version: 1,
        entries: [
          { id: 'style-a', name: '实验文风', enabled: false, group: 'style', selection: 'single' as const, slot: 'render-style', tags: ['rp'], renderOnly: true },
          { id: 'style-b', name: '克制文风', enabled: false, group: 'style', selection: 'single' as const, slot: 'render-style', tags: ['rp'], renderOnly: true },
          { id: 'slow', name: '缓慢推进', enabled: false, group: 'pacing', selection: 'single' as const, slot: 'render-style', tags: ['rp'], renderOnly: true },
        ],
      })),
      effective: vi.fn(async () => ({ revision: 4, profileIds: [], enabledEntryIds: [], appliesFromNextTurn: false })),
      setOverlay: vi.fn(async (_sessionId, profileIds, enabledEntryIds) => ({ revision: 5, profileIds, enabledEntryIds, appliesFromNextTurn: true })),
      resetOverlay: vi.fn(async () => ({ revision: 6, profileIds: [], enabledEntryIds: [], appliesFromNextTurn: true })),
    }
  }

  it('defaults optional methods to empty and applies the locked core plus selected profile', async () => {
    const prompts = promptClient()
    const harness = await fixture(async () => [], undefined, prompts)
    services.push(harness.service)

    const settings = await harness.service.promptSettings('session-1')
    expect(settings).toMatchObject({
      available: true,
      revision: 4,
      coreProfileIds: ['rp-narrative-base', 'fixture-card'],
      enabledEntryIds: [],
      appliesFromNextTurn: false,
    })
    expect(JSON.stringify(settings)).not.toContain('content')

    const applied = await harness.service.applyPromptSettings('session-1', { enabledEntryIds: ['style-a', 'slow'], expectedRevision: 4 })
    expect(prompts.setOverlay).toHaveBeenCalledWith(
      'session-1',
      ['rp-narrative-base', 'fixture-card', 'fixture-profile'],
      ['style-a', 'slow'],
      4,
    )
    expect(applied).toMatchObject({ revision: 5, enabledEntryIds: ['style-a', 'slow'], appliesFromNextTurn: true })

    const reset = await harness.service.resetPromptSettings('session-1', 5)
    expect(prompts.resetOverlay).toHaveBeenCalledWith('session-1', 5)
    expect(reset).toMatchObject({ revision: 6, enabledEntryIds: [], appliesFromNextTurn: true })
  })

  it('rejects unknown entries and contradictory single-choice methods without writing', async () => {
    const prompts = promptClient()
    const harness = await fixture(async () => [], undefined, prompts)
    services.push(harness.service)

    await expect(harness.service.applyPromptSettings('session-1', { enabledEntryIds: ['unknown'], expectedRevision: 4 })).rejects.toMatchObject({ statusCode: 400 })
    await expect(harness.service.applyPromptSettings('session-1', { enabledEntryIds: ['style-a', 'style-b'], expectedRevision: 4 })).rejects.toMatchObject({ statusCode: 400 })
    expect(prompts.setOverlay).not.toHaveBeenCalled()
  })

  it('keeps the RP session usable when the optional prompt service is unavailable', async () => {
    const harness = await fixture(async () => [])
    services.push(harness.service)
    const detail = await harness.service.session('session-1')
    expect(detail.prompt).toMatchObject({ available: false, enabledEntryIds: [] })
    expect(detail.messages).toEqual([])
  })

  it('does not silently hide an optional profile missing from the catalog', async () => {
    const prompts = promptClient()
    vi.mocked(prompts.catalog).mockResolvedValue({ revision: 4, profiles: [] })
    const harness = await fixture(async () => [], undefined, prompts)
    services.push(harness.service)

    const settings = await harness.service.promptSettings('session-1')
    expect(settings).toMatchObject({ available: false, enabledEntryIds: [], optionalProfiles: [] })
    expect(prompts.profile).not.toHaveBeenCalled()
  })
})
