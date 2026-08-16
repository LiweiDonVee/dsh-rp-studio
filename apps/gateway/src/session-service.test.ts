import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DshClient, DshHistoryEntry, DshStreamFrame } from './dsh/client.js'
import { DshRpcError } from './dsh/wire.js'
import { GatewayError } from './errors.js'
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
): Promise<{
  service: SessionService
  emit(frame: DshStreamFrame): void
  disconnect(): void
  reconnect(): void
}> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-rp-session-'))
  const preset = join(home, '.agent-presets', 'rp-runtime')
  await mkdir(preset, { recursive: true })
  await writeFile(join(preset, 'rp-card.json'), JSON.stringify({
    schemaVersion: 1,
    runtime: 'dsh-rp',
    id: 'rp-runtime',
    title: '魔药宗师',
    world: '营地',
    protagonist: '加斯帕',
    art: 'potion-master',
    accent: 'jade',
  }))

  let emit = (_frame: DshStreamFrame): void => {}
  let disconnect = (): void => {}
  let reconnect = (): void => {}
  const dsh: DshClient = {
    hostDescribe: async () => ({ version: 'test' }),
    listPresets: async () => [{ id: 'rp-runtime', trust: 'user' }],
    listSessions: async () => [{
      sessionId: 'session-1',
      updatedAt: 1,
      running: false,
      blank: false,
      agentPreset: 'rp-runtime',
      projections: {
        asOfSeq: 1,
        values: { 'rp-state': { game: { started: true, statusLines: [] }, meta: { checkpoints: [] } } },
      },
    }],
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
  const service = new SessionService({ dsh, dshHome: home })
  await service.start()
  return {
    service,
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
