import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamEventSchema, type StreamEvent } from '@dsh-rp/protocol'
import type { DshClient, DshHistoryEntry, DshStreamFrame } from './dsh/client.js'
import { DshRpcError } from './dsh/wire.js'
import { GatewayError } from './errors.js'
import type { PromptPresetsClient } from './prompt-presets-client.js'
import { SessionService, type SessionServiceOptions } from './session-service.js'
import emptyLegacyHistory from './fixtures/last-step-empty-legacy-history.json'

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
  isPresentationSession?: (sessionId: string) => boolean,
  nativeOptions: Partial<SessionServiceOptions> = {},
): Promise<{
  service: SessionService
  home: string
  emit(frame: DshStreamFrame): void
  disconnect(): void
  reconnect(): void
}> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-rp-session-'))
  let emit = (_frame: DshStreamFrame): void => {}
  let disconnect = (): void => {}
  let reconnect = (): void => {}
  const dsh: DshClient = {
    hostDescribe: async () => ({ version: 'test' }),
    listPresets: async () => [{ id: 'sample-world', isDefault: false, name: '测试 RP', description: 'synthetic fixture' }],
    readPreset: async agentPreset => ({ agentPreset, content: JSON.stringify({ schemaVersion: 1, runtime: 'dsh-rp', id: agentPreset, title: '测试 RP', world: '测试世界', protagonist: '玩家', art: agentPreset, accent: 'jade', prompt: { coreProfileIds: ['rp-narrative-base', 'sample-world'], optionalProfileIds: ['dreamwhale-v3-agent'] } }) }),
    listSessions: async () => [{
      sessionId: 'session-1',
      updatedAt: 1,
      running: false,
      blank: false,
      agentPreset: 'sample-world',
      projections: {
        asOfSeq: 1,
        values: { 'rp-state': { game: { started: true, statusLines: [] }, meta: { checkpoints: [] } } },
      },
    }],
    listWorkspaces: async () => ({ items: [], archivedSessionIds: [] }),
    createWorkspace: async path => ({
      workspace: {
        workspaceId: 'workspace-sample-world', path, title: 'sample-world', sessionIds: [],
        createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
      },
      created: true,
    }),
    renameWorkspace: async (workspaceId, title) => ({
      workspace: {
        workspaceId, path: join(home, 'rp-workspaces', 'sample-world'), title, sessionIds: [],
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
  const service = new SessionService({ dsh, dshHome: home, ...(promptPresets ? { promptPresets } : {}), ...(isPresentationSession ? { isPresentationSession } : {}), ...nativeOptions })
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

describe('generic native story services', () => {
  const binding = { schemaVersion: 1, id: 'binding-one', sessionId: 'session-1', launchId: 'launch-one', title: '雨后的港口', status: 'active', character: { assetId: 'actor', version: 2, name: '林', description: '港口的向导。' }, persona: { assetId: 'player', version: 1, name: '旅人', description: '来访者' }, opening: { id: 'first', text: '船靠岸了。' }, examples: '', sources: [], profile: { profileId: 'profile', version: 1 }, factEntryRefs: [], createdAt: '2026-10-25T00:00:00Z' }
  const scene = { schemaVersion: 1, title: '抵港', location: '码头', presentActorIds: ['actor'] }
  const facts = { schemaVersion: 1, items: [{ id: 'arrived', text: '旅人已到达码头。' }] }
  const ref = { sessionId: 'session-1', presentationId: 'receipt-one', assistantMessageId: 'gm-1', callSeq: 2, baseResultSeq: 3, resultSeq: 8 }
  function gm() {
    return { apiVersion: 1, listStories: async () => ({ stories: [{ ...binding }] }), binding: async (input: { sessionId: string }) => ({ ...binding, sessionId: input.sessionId }),
      storyState: async () => ({ binding, scene, facts, capabilities: { rollback: true, fork: true, autoplay: false } }),
      forkStory: async () => ({ sessionId: 'child', binding: { ...binding, sessionId: 'child' } }),
      rollbackStory: async () => ({ sessionId: 'child', binding: { ...binding, sessionId: 'child' } }) }
  }

  it('discovers a generic story from its owner and projects current scene/facts without a per-card preset', async () => {
    const owner = gm()
    const h = await fixture(async () => [assistantEvent(1, 'PRIVATE_MAIN_GM')], undefined, undefined, dsh => {
      dsh.listPresets = async () => []
      dsh.listSessions = async () => [{ sessionId: 'session-1', updatedAt: 1, running: false, blank: false, agentPreset: 'plain-gm' }]
    }, undefined, { getGM: () => owner })
    services.push(h.service)
    expect(await h.service.cards()).toEqual([])
    expect(await h.service.sessions()).toMatchObject([{ id: 'session-1', title: '雨后的港口' }])
    expect(await h.service.session('session-1')).toMatchObject({ messages: [], card: { protagonist: '旅人' }, state: { scene: { location: '码头' }, extensions: { gm: { scene, facts, capabilities: { autoplay: false } } } } })
  })

  it('prefers current native narrative revisions while retaining player actions', async () => {
    const owner = gm()
    const history: DshHistoryEntry[] = [{ event: { seq: 0, time: 1, type: 'user/message', data: { id: 'player', source: { kind: 'user' }, content: [{ type: 'text', text: '靠岸。' }] }, surfaceOp: 'append' } }]
    const h = await fixture(async () => history, undefined, undefined, undefined, undefined, {
      getGM: () => owner,
      getLastStep: () => ({ narratives: async () => ({ records: [{ id: '["receipt-one",8]', ref, turn: 1, action: '靠岸。', text: '有效采用稿。' }] }) }),
    })
    services.push(h.service)
    expect((await h.service.session('session-1')).messages.map(message => [message.role, message.text])).toEqual([['player', '靠岸。'], ['gm', '有效采用稿。']])
  })

  it('keeps facts and controls available while explicitly withholding unavailable effective prose', async () => {
    const h = await fixture(async () => [assistantEvent(1, 'OLD_BODY')], undefined, undefined, undefined, undefined, {
      getGM: () => gm(),
      getLastStep: () => ({ narratives: async () => ({ records: [] }) }),
      getDatabase: () => ({ capabilities: { factReview: 1 }, factReviewProjection: async () => ({ schemaVersion: 1, latestRoundId: 'round', groups: [{ roundId: 'round', activeReceiptId: 'new-fact', pendingCandidateId: null, factRevision: 2 }] }) }),
    })
    services.push(h.service)
    const current = await h.service.session('session-1')
    expect(current.messages).toEqual([])
    expect(current.state.extensions).toMatchObject({ gm: { facts }, reader: { status: 'unavailable', code: 'EFFECTIVE_HISTORY_UNAVAILABLE' } })
  })

  it.each(['unbound', 'bound', 'unknown', 'missing-method'])('requires actual GM absence before preserving ordinary legacy prose (%s)', async source => {
    const owner = { ...gm(), listStories: async () => ({ stories: [] }),
      binding: async () => source === 'unbound' ? null : source === 'unknown' ? undefined : binding }
    if (source === 'missing-method') Reflect.deleteProperty(owner, 'binding')
    const h = await fixture(async () => [assistantEvent(0, '旧故事。'), presentationContext(1)], undefined, undefined, undefined, undefined, {
      getGM: () => owner as ReturnType<NonNullable<SessionServiceOptions['getGM']>>,
      getLastStep: () => ({ capabilities: { narrativeRevisions: 1 }, storyHistory: async () => ({ ...structuredClone(emptyLegacyHistory), schemaVersion: 1 as const }) }),
    })
    services.push(h.service)
    const current = await h.service.session('session-1')
    expect(current.messages.map(item => item.text)).toEqual(source === 'unbound' ? ['旧故事。'] : [])
  })

  it('propagates the installed GM binding lookup failure instead of treating it as absence', async () => {
    const error = Object.assign(new Error('binding denied'), { code: 'PERMISSION_DENIED' })
    const h = await fixture(async () => [assistantEvent(0, '旧故事。'), presentationContext(1)], undefined, undefined, undefined, undefined, {
      getGM: () => ({ ...gm(), listStories: async () => ({ stories: [] }), binding: async () => { throw error } }),
      getLastStep: () => ({ capabilities: { narrativeRevisions: 1 }, storyHistory: async () => ({ ...structuredClone(emptyLegacyHistory), schemaVersion: 1 as const }) }),
    })
    services.push(h.service)
    await expect(h.service.session('session-1')).rejects.toBe(error)
  })

  it('blocks ordinary Studio send on actual owner pending state before submitting a host prompt', async () => {
    const prompt = vi.fn(async () => ({ accepted: true }))
    const h = await fixture(async () => [], prompt, undefined, undefined, undefined, {
      getGM: () => ({ ...gm(), capabilities: { factReview: 1 }, reviewState: async () => ({ latestRound: { pendingCandidateId: 'candidate' }, pendingDecision: null, generation: null }) }),
    })
    services.push(h.service)
    await expect(h.service.prompt('session-1', '继续')).rejects.toMatchObject({ apiError: { upstreamCode: 'FACT_REVIEW_PENDING' } })
    expect(prompt).not.toHaveBeenCalled()
  })
  it('keeps the legacy approval-off prompt path when GM explicitly reports an older Database', async () => {
    const prompt = vi.fn(async () => ({ accepted: true }))
    const h = await fixture(async () => [], prompt, undefined, undefined, undefined, {
      getGM: () => ({ ...gm(), capabilities: { factReview: 1 }, reviewState: async () => { throw Object.assign(new Error('Install Database with fact review support'), { code: 'FACT_REVIEW_UNAVAILABLE' }) } }),
    })
    services.push(h.service)
    expect(await h.service.prompt('session-1', '继续')).toEqual({ accepted: true })
    expect(prompt).toHaveBeenCalledWith('session-1', '继续')
  })

  it('delegates generic branch controls and refuses legacy autoplay commands', async () => {
    const owner = gm(), prompt = vi.fn(async () => ({ accepted: true }))
    let listed = ['session-1']
    owner.listStories = async () => ({ stories: listed.map(sessionId => ({ ...binding, sessionId })) })
    owner.binding = async ({ sessionId }: { sessionId: string }) => ({ ...binding, sessionId })
    owner.forkStory = async () => { listed = ['session-1', 'child']; return { sessionId: 'child', binding: { ...binding, sessionId: 'child' } } }
    owner.rollbackStory = owner.forkStory
    const h = await fixture(async () => [], prompt, undefined, dsh => {
      dsh.listSessions = async () => listed.map(sessionId => ({ sessionId, updatedAt: 1, running: false, blank: false, agentPreset: 'generic-gm' }))
    }, undefined, { getGM: () => owner })
    services.push(h.service)
    expect(await h.service.fork('session-1')).toMatchObject({ session: { id: 'child' } })
    expect(await h.service.rollback('session-1')).toMatchObject({ accepted: true, sessionId: 'child' })
    await expect(h.service.autoplay('session-1', { rounds: 3 })).rejects.toThrow(/自动续写/u)
    expect(prompt).not.toHaveBeenCalled()
    expect((await h.service.sessions()).map(item => item.id)).toContain('session-1')
  })

  it('invalidates an idle reader when the owner changes state and releases that subscription', async () => {
    let notify = (_event: Record<string, unknown>) => {}
    const owner = { ...gm(), subscribe: (_id: string, listener: typeof notify) => { notify = listener; return () => { notify = () => {} } } }
    const h = await fixture(async () => [], undefined, undefined, undefined, undefined, { getGM: () => owner })
    services.push(h.service)
    const events: StreamEvent[] = []
    const stop = h.service.subscribe('session-1', event => events.push(event))
    notify({ type: 'changed', sessionId: 'session-1' })
    expect(events).toEqual([{ type: 'session.rebased', sessionId: 'session-1' }])
    stop()
    notify({ type: 'changed', sessionId: 'session-1' })
    expect(events).toHaveLength(1)
  })

  it('reports an unavailable generic rollback through the existing safe API error contract', async () => {
    const owner = gm()
    owner.rollbackStory = async () => { throw Object.assign(new Error('No ordinary factual turn'), { code: 'ROLLBACK_UNAVAILABLE', status: 409 }) }
    const h = await fixture(async () => [], undefined, undefined, undefined, undefined, { getGM: () => owner })
    services.push(h.service)
    await expect(h.service.rollback('session-1')).rejects.toMatchObject({ statusCode: 409, apiError: { code: 'rollback-unavailable' } })
  })

  it('does not advertise generic branch controls when the installed owner lacks their methods', async () => {
    const { forkStory: _fork, rollbackStory: _rollback, ...owner } = gm()
    const h = await fixture(async () => [], undefined, undefined, undefined, undefined, { getGM: () => owner })
    services.push(h.service)
    expect((await h.service.session('session-1')).state.extensions.gm).toMatchObject({ capabilities: { rollback: false, fork: false, autoplay: false } })
  })
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
    const harness = await fixture(async () => [], undefined, undefined, async (dsh) => {
      dsh.listPresets = async () => [
        { id: 'sample-world', isDefault: false, name: '测试 RP', description: 'synthetic fixture' },
        { id: 'rp-runtime', isDefault: false, name: 'RP Runtime 基础模板', description: 'synthetic template' },
      ]
      dsh.readPreset = async agentPreset => ({ agentPreset, content: JSON.stringify(agentPreset === 'rp-runtime' ? {
        schemaVersion: 1, runtime: 'dsh-rp', id: agentPreset, kind: 'template', title: 'RP Runtime 基础模板', world: null, protagonist: null, art: 'runtime-template', accent: 'graphite',
      } : { schemaVersion: 1, runtime: 'dsh-rp', id: agentPreset, title: '测试 RP', world: '测试世界', protagonist: '玩家', art: agentPreset, accent: 'jade' }) })
      dsh.listSessions = async () => [{
        sessionId: 'session-1', updatedAt: 1, running: false, blank: false, agentPreset: 'rp-runtime',
        projections: {
          asOfSeq: 1,
          values: { 'rp-state': { game: { started: true, statusLines: [] }, meta: { checkpoints: [] } } },
        },
      }]
    })
    services.push(harness.service)

    expect(await harness.service.cards()).toMatchObject([{ id: 'sample-world' }])
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
      const cardPath = join(home, 'rp-workspaces', 'sample-world')
      dsh.listSessions = async () => [{
        sessionId: 'session-migrated', updatedAt: 1, running: false, blank: false,
        cwd: cardPath, agentPreset: 'sample-world',
      }]
      dsh.createSession = createSession
    })
    services.push(harness.service)

    expect(createSession).toHaveBeenCalledWith({
      sessionId: 'session-migrated', agentPreset: 'sample-world', workspaceId: 'workspace-sample-world',
    })
  })

  it('does not adopt an RP session until its durable cwd has been migrated', async () => {
    const createSession = vi.fn<DshClient['createSession']>(async payload => ({ sessionId: payload.sessionId ?? 'new' }))
    const harness = await fixture(async () => [], undefined, undefined, (dsh) => {
      dsh.listSessions = async () => [{
        sessionId: 'session-legacy', updatedAt: 1, running: false, blank: false,
        cwd: 'E:\\WorkSpace\\legacy-rp', agentPreset: 'sample-world',
      }]
      dsh.createSession = createSession
    })
    services.push(harness.service)

    expect(createSession).not.toHaveBeenCalled()
  })

  it('creates sessions inside the card-specific native DSH workspace', async () => {
    const createWorkspace = vi.fn<DshClient['createWorkspace']>(async path => ({
      workspace: {
        workspaceId: 'workspace-sample-world', path, title: 'sample-world', sessionIds: [],
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

    await harness.service.create('sample-world')

    const cardPath = await realpath(join(harness.home, 'rp-workspaces', 'sample-world'))
    expect(createWorkspace).toHaveBeenCalledWith(cardPath)
    expect(renameWorkspace).toHaveBeenCalledWith('workspace-sample-world', '测试 RP [sample-world]')
    expect(createSession).toHaveBeenCalledWith({ agentPreset: 'sample-world', workspaceId: 'workspace-sample-world' })
  })

  it('excludes globally archived DSH sessions from Studio listings', async () => {
    const harness = await fixture(async () => [], undefined, undefined, (dsh) => {
      dsh.listSessions = async () => [
        {
          sessionId: 'session-active', updatedAt: 2, running: false, blank: false,
          agentPreset: 'sample-world',
        },
        {
          sessionId: 'session-archived', updatedAt: 1, running: false, blank: true,
          agentPreset: 'sample-world',
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
          content: [{ type: 'text', text: '检查门后。' }],
        },
        surfaceOp: 'append',
      },
    })

    await expect(completed).resolves.toMatchObject({
      message: { id: 'player-2', role: 'player', text: '检查门后。' },
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
        sessionId: 'session-1', updatedAt: 1, running: false, blank: true, agentPreset: 'sample-world',
        projections: {
          asOfSeq: includeProjection ? 1 : 2,
          values: includeProjection
            ? {
                'rp-state': {
                  game: {
                    started: false,
                    protagonist: { name: '测试玩家', attributes: {} },
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
      protagonist: { name: '测试玩家' },
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

describe('SessionService product projection source', () => {
  it('resolves the real DSH workspace and emits official projection and rebase cursors', async () => {
    const harness = await fixture(async () => [], undefined, undefined, (dsh) => {
      dsh.listWorkspaces = async () => ({ items: [{ workspaceId: 'workspace-real', path: 'E:\\rp', title: 'RP', sessionIds: ['session-1'], createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z' }], archivedSessionIds: [] })
    })
    services.push(harness.service)
    expect(await harness.service.getProductScope('session-1')).toEqual({ workspaceId: 'workspace-real', cardId: 'sample-world', sessionId: 'session-1', branchId: 'session-1' })
    expect((await harness.service.productSnapshots())[0]?.sourceSeq).toBe(1)
    const events: import('./app.js').ProductSourceEvent[] = []
    harness.service.subscribeProduct(event => events.push(event))
    harness.emit({ type: 'session/projection', sessionId: 'session-1', key: 'rp-state', seq: 41, value: { game: { started: true, statusLines: [], driver: { armed: true } }, meta: {} } })
    harness.emit({ type: 'session/projection', sessionId: 'session-1', key: 'rp-state', seq: 42, value: { game: { started: true, statusLines: [], driver: { armed: false } }, meta: {} } })
    harness.emit({ type: 'session/subscribed', sessionId: 'session-1', lastSeq: 43 })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'projection', sourceSeq: 41 }),
      expect.objectContaining({ type: 'autoplay.completed', sourceSeq: 42 }),
      expect.objectContaining({ type: 'rebase', sourceSeq: 43 }),
    ]))
  })

  it('emits turn completion and attention without forwarding prompt contents', async () => {
    const harness = await fixture(async () => [], undefined, undefined, (dsh) => {
      dsh.listWorkspaces = async () => ({ items: [{ workspaceId: 'workspace-real', path: 'E:\\rp', title: 'RP', sessionIds: ['session-1'], createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z' }], archivedSessionIds: [] })
    })
    services.push(harness.service)
    await harness.service.session('session-1')
    const events: import('./app.js').ProductSourceEvent[] = []
    harness.service.subscribeProduct(event => events.push(event))
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: assistantEvent(51, '公开正文').event })
    harness.emit({ type: 'host/attention', sessionId: 'session-1' })
    expect(events).toEqual(expect.arrayContaining([
      { type: 'turn.completed', sessionId: 'session-1', sourceSeq: 51 },
      expect.objectContaining({ type: 'attention.required', sessionId: 'session-1' }),
    ]))
    expect(JSON.stringify(events)).not.toContain('公开正文')
  })
})

function presentationContext(seq: number, enabled = true): DshHistoryEntry {
  return { event: {
    seq, time: 1_700_000_000_000 + seq, type: 'user/message', surfaceOp: 'append',
    data: { id: `context-${seq}`, source: {
      kind: 'runtime-context', form: 'snapshot', sections: enabled ? [{ name: 'rp-last-step-binding', text: JSON.stringify({ contract: 'rp-last-step/v1', enabled: true, profileId: 'story', version: 1 }) }] : [],
    }, content: [{ type: 'text', text: 'PRIVATE_CONTEXT_CANARY' }] },
  } }
}

function presentationCall(seq: number, turn = 1): DshHistoryEntry {
  const entry = assistantEvent(seq, 'PRIVATE_MAIN_CANARY')
  entry.event.data.turn = turn
  entry.event.data.step = 1
  const message = entry.event.data.message as Record<string, unknown>
  ;(message.content as unknown[]).push({ type: 'tool-call', id: 'present-call', name: 'rp_present', arguments: '{}' })
  return entry
}

function presentationToolCall(seq: number, turn = 1): DshHistoryEntry {
  return { event: { seq, time: 1_700_000_000_000 + seq, type: 'tool/call', data: { turn, step: 1, callId: 'present-call', name: 'rp_present', arguments: '{}' } } }
}

function presentationResult(seq: number, turn = 1): DshHistoryEntry {
  return { event: {
    seq, time: 1_700_000_000_000 + seq, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [seq - 1],
    data: { turn, step: 1,
      message: { id: 'tool-result', role: 'tool', source: { kind: 'tool', callId: 'present-call' }, toolCallId: 'present-call', isError: false, content: [{ type: 'text', text: 'PRIVATE_TOOL_CANARY' }] },
      meta: { rpLastStep: { schemaVersion: 1, record: { id: 'presentation-final', text: '星光落在她的肩头。', status: 'complete', createdAt: '2026-10-24T00:00:00.000Z', profileId: 'story', profileVersion: 1, profileHash: 'hash' } } },
    },
  } }
}

describe('SessionService last-step presentation bridge', () => {
  it.each(['{invalid binding', JSON.stringify({ contract: 'rp-last-step/v2', enabled: true })])('mutes both main-agent carriers when the reserved binding marker is invalid (%s)', async text => {
    const harness = await fixture(async () => [])
    services.push(harness.service)
    await harness.service.session('session-1')
    const events: StreamEvent[] = []
    harness.service.subscribe('session-1', item => events.push(item))
    const context = presentationContext(1)
    context.event.data.source = { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'rp-last-step-binding', text }] }
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: context.event })
    harness.emit({ type: 'session/assistant-delta', sessionId: 'session-1', messageId: 'main', text: 'PRIVATE_DELTA_CANARY' })
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: { seq: 2, time: 2, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'PRIVATE_CHUNK_CANARY' } } } })
    expect(events).toEqual([])
  })

  it('mutes both main-agent stream carriers after a standalone runtime-context marker and restores them after clearing', async () => {
    const harness = await fixture(async () => [])
    services.push(harness.service)
    await harness.service.session('session-1')
    const events: StreamEvent[] = []
    harness.service.subscribe('session-1', item => events.push(item))
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: presentationContext(1).event })
    harness.emit({ type: 'session/assistant-delta', sessionId: 'session-1', messageId: 'main', text: 'PRIVATE_DELTA_CANARY' })
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: { seq: 2, time: 2, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'PRIVATE_CHUNK_CANARY' } } } })
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: presentationCall(3).event })
    expect(events).toEqual([])
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: presentationContext(4, false).event })
    harness.emit({ type: 'session/assistant-delta', sessionId: 'session-1', messageId: 'legacy', text: '普通故事。' })
    expect(events).toEqual([{ type: 'message.delta', sessionId: 'session-1', messageId: 'legacy', text: '普通故事。' }])
    expect((await harness.service.session('session-1')).messages).toEqual([])
  })

  it.each([false, true])('loads and reconciles ordinary legacy prose with an empty effective reader (%s)', async installed => {
    const history = [assistantEvent(0, '旧故事。'), presentationContext(1)]
    const original = structuredClone(history)
    const historyAll = vi.fn(async () => history)
    const write = vi.fn(async () => { throw new Error('Reading must not dispatch a model or write host history') })
    const projection = vi.fn(async () => { throw new Error('Successful storyHistory must not cause another Database lookup') })
    // Actual projectStoryHistory output at LastStep a73d96a for this exact legacy
    // history, captured by studio-legacy-reading-projection-repro.json (C17).
    const storyHistory = vi.fn(async () => ({ ...structuredClone(emptyLegacyHistory), schemaVersion: 1 as const }))
    const harness = await fixture(historyAll, write, undefined, dsh => {
      dsh.createSession = write
      dsh.cancel = write
      dsh.fork = write
    }, undefined, installed ? {
      getLastStep: () => ({ capabilities: { narrativeRevisions: 1 }, storyHistory }),
      getDatabase: () => ({ capabilities: { factReview: 1 }, factReviewProjection: projection }),
    } : {})
    services.push(harness.service)
    const loaded = await harness.service.session('session-1')
    expect(loaded.messages.map(item => item.text)).toEqual(['旧故事。'])
    expect(loaded.state.extensions.reader).toBeUndefined()
    harness.emit({ type: 'session/subscribed', sessionId: 'session-1', lastSeq: 1 })
    const reconciled = await harness.service.session('session-1')
    expect(reconciled.messages.map(item => item.text)).toEqual(['旧故事。'])
    expect(reconciled.state.extensions.reader).toBeUndefined()
    expect(historyAll).toHaveBeenCalledTimes(2)
    expect(storyHistory).toHaveBeenCalledTimes(installed ? 2 : 0)
    expect(history).toEqual(original)
    expect(write).not.toHaveBeenCalled()
    expect(projection).not.toHaveBeenCalled()
    const events: StreamEvent[] = []
    harness.service.subscribe('session-1', item => events.push(item))
    harness.emit({ type: 'session/assistant-delta', sessionId: 'session-1', messageId: 'main', text: 'PRIVATE_DELTA_CANARY' })
    expect(events).toEqual([])
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: presentationContext(2, false).event })
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: { seq: 3, time: 3, type: 'user/message', data: { id: 'player', source: { kind: 'user' }, content: [{ type: 'text', text: 'rp-last-step/v1 enabled:true' }] }, surfaceOp: 'append' } })
    harness.emit({ type: 'session/assistant-delta', sessionId: 'session-1', messageId: 'legacy', text: '普通故事。' })
    expect(events.at(-1)).toMatchObject({ type: 'message.delta', text: '普通故事。' })
  })

  it('does not revive an actual canonical presentation excluded by an empty effective reader', async () => {
    const harness = await fixture(async () => [assistantEvent(0, '旧故事。'), presentationContext(1), presentationCall(2), presentationToolCall(3), presentationResult(4)], undefined, undefined, undefined, undefined, {
      getLastStep: () => ({ capabilities: { narrativeRevisions: 1 }, storyHistory: async () => ({ ...structuredClone(emptyLegacyHistory), schemaVersion: 1 as const }) }),
    })
    services.push(harness.service)
    expect((await harness.service.session('session-1')).messages).toEqual([])
  })

  it.each(['rp_commit_turn', 'rp_propose_turn'])('does not restore ordinary prose when the log contains a GM fact source (%s)', async name => {
    const call: DshHistoryEntry = { event: { seq: 2, time: 2, type: 'tool/call', data: { name, callId: 'fact-call', turn: 1, step: 1 } } }
    const harness = await fixture(async () => [assistantEvent(0, '旧故事。'), presentationContext(1), call], undefined, undefined, undefined, undefined, {
      getLastStep: () => ({ capabilities: { narrativeRevisions: 1 }, storyHistory: async () => ({ ...structuredClone(emptyLegacyHistory), schemaVersion: 1 as const }) }),
    })
    services.push(harness.service)
    expect((await harness.service.session('session-1')).messages).toEqual([])
  })

  it('uses the optional native binding cache to mute main deltas before history loads', async () => {
    const harness = await fixture(async () => [], undefined, undefined, undefined, () => true)
    services.push(harness.service)
    const events: StreamEvent[] = []
    harness.service.subscribe('session-1', item => events.push(item))
    harness.emit({ type: 'session/assistant-delta', sessionId: 'session-1', messageId: 'main', text: 'PRIVATE_DELTA_CANARY' })
    harness.emit({ type: 'session/event', sessionId: 'session-1', event: { seq: 1, time: 1, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'PRIVATE_CHUNK_CANARY' } } } })
    expect(events).toEqual([])
  })

  it('only forwards safe presentation deltas for a known RP owner with presentation enabled', async () => {
    let enabled = true
    const harness = await fixture(async () => [], undefined, undefined, undefined, () => enabled)
    services.push(harness.service)
    const events: StreamEvent[] = []
    harness.service.subscribe('session-1', item => events.push(item))
    harness.service.subscribe('unknown', item => events.push(item))
    expect(harness.service.publishPresentationDelta('session-1', 'writer', '晨风')).toBe(true)
    expect(harness.service.publishPresentationDelta('unknown', 'writer', 'MUST_NOT_PUBLISH')).toBe(false)
    enabled = false
    expect(harness.service.publishPresentationDelta('session-1', 'writer', 'MUST_NOT_PUBLISH')).toBe(false)
    expect(events).toEqual([{ type: 'message.delta', sessionId: 'session-1', messageId: 'writer', text: '晨风' }])
  })

  it('publishes a generic typed presentation failure or cancellation without provider details', async () => {
    const harness = await fixture(async () => [presentationContext(1)])
    services.push(harness.service)
    await harness.service.session('session-1')
    const events: StreamEvent[] = []
    harness.service.subscribe('session-1', item => events.push(item))
    expect(harness.service.publishPresentationError('session-1', 'failed')).toBe(true)
    expect(harness.service.publishPresentationError('session-1', 'cancelled')).toBe(true)
    expect(harness.service.publishPresentationError('unknown', 'failed')).toBe(false)
    expect(events).toMatchObject([
      { type: 'error', error: { code: 'upstream-unavailable', upstreamCode: 'rp-last-step-failed' } },
      { type: 'error', error: { upstreamCode: 'rp-last-step-cancelled' } },
    ])
    for (const item of events) expect(streamEventSchema.safeParse(item).success).toBe(true)
  })

  it('completes canonical writer narration from the result sequence and emits product turn completion once', async () => {
    const harness = await fixture(async () => [presentationContext(1), presentationCall(2), presentationToolCall(3)])
    services.push(harness.service)
    await harness.service.session('session-1')
    const events: StreamEvent[] = []
    const product: import('./app.js').ProductSourceEvent[] = []
    harness.service.subscribe('session-1', item => events.push(item))
    harness.service.subscribeProduct(item => product.push(item))
    const frame: DshStreamFrame = { type: 'session/event', sessionId: 'session-1', event: presentationResult(4).event }
    harness.emit(frame)
    harness.emit(frame)
    expect(events).toMatchObject([{ type: 'message.completed', message: { id: 'presentation-final', text: '星光落在她的肩头。', seq: 4, role: 'gm' } }])
    expect(product).toEqual([{ type: 'turn.completed', sessionId: 'session-1', sourceSeq: 4 }])
    expect((await harness.service.session('session-1')).messages).toMatchObject([{ id: 'presentation-final', text: '星光落在她的肩头。' }])
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })

  it('keeps both completed presentations when a provider call ID is reused in the next turn', async () => {
    const harness = await fixture(async () => [presentationContext(1)])
    services.push(harness.service)
    await harness.service.session('session-1')
    const events: StreamEvent[] = []
    harness.service.subscribe('session-1', item => events.push(item))
    const second = presentationResult(7, 2)
    const secondRecord = (second.event.data.meta as { rpLastStep: { record: Record<string, unknown> } }).rpLastStep.record
    secondRecord.id = 'second-final'
    secondRecord.text = '第二幕星光。'
    for (const entry of [presentationCall(2), presentationToolCall(3), presentationResult(4), presentationCall(5, 2), presentationToolCall(6, 2), second]) {
      harness.emit({ type: 'session/event', sessionId: 'session-1', event: entry.event })
    }
    expect(events.filter(item => item.type === 'message.completed')).toMatchObject([
      { message: { id: 'presentation-final', text: '星光落在她的肩头。' } }, { message: { id: 'second-final', text: '第二幕星光。' } },
    ])
    expect((await harness.service.session('session-1')).messages.map(item => [item.id, item.text])).toEqual([
      ['presentation-final', '星光落在她的肩头。'], ['second-final', '第二幕星光。'],
    ])
  })
})

describe('SessionService prompt settings', () => {
  function promptClient(): PromptPresetsClient {
    return {
      catalog: vi.fn(async () => ({ revision: 4, profiles: [{ id: 'dreamwhale-v3-agent', name: '梦鲸 Agent', version: 1 }] })),
      profile: vi.fn(async () => ({
        id: 'dreamwhale-v3-agent', name: '梦鲸 Agent', description: 'optional', version: 1,
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
      coreProfileIds: ['rp-narrative-base', 'sample-world'],
      enabledEntryIds: [],
      appliesFromNextTurn: false,
    })
    expect(JSON.stringify(settings)).not.toContain('content')

    const applied = await harness.service.applyPromptSettings('session-1', { enabledEntryIds: ['style-a', 'slow'], expectedRevision: 4 })
    expect(prompts.setOverlay).toHaveBeenCalledWith(
      'session-1',
      ['rp-narrative-base', 'sample-world', 'dreamwhale-v3-agent'],
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
