import { describe, expect, it, vi } from 'vitest'
import {
  createSupervisorAdapter,
  createSupervisorConfig,
  projectSupervisorStatus,
  supervisorCreatorFromModule,
  type SupervisorInstance,
} from '../src/main/supervisor-adapter.js'

describe('Supervisor adapter', () => {
  it('constructs the real Supervisor configuration from persisted settings', () => {
    expect(createSupervisorConfig({
      nodeExecutable: 'C:/运行时/node.exe',
      dshBin: 'C:/运行时/dsh.js',
      gatewayEntry: 'C:/运行时/gateway.js',
      dshHome: 'C:/档案',
      dshPort: 0,
      studioPort: 0,
      runtimeRoot: 'C:/运行时',
    })).toEqual({
      nodeExecutable: 'C:/运行时/node.exe',
      dshBin: 'C:/运行时/dsh.js',
      gatewayEntry: 'C:/运行时/gateway.js',
      dshHome: 'C:/档案',
      dshPort: 0,
      studioPort: 0,
      cwd: 'C:/运行时',
      startupTimeoutMs: 30_000,
    })
  })

  it('delegates to the real instance API without exposing its launch URL', async () => {
    const stop = vi.fn(async () => undefined)
    const supervisor: SupervisorInstance = {
      start: async () => ({
        studioUrl: 'http://127.0.0.1:4567',
        dshUrl: 'http://127.0.0.1:4568',
        launchUrl: 'http://127.0.0.1:4568/?token=secret',
      }),
      status: () => ({ phase: 'running', studioUrl: 'http://127.0.0.1:4567', dshUrl: 'http://127.0.0.1:4568', processes: { dsh: 42 }, logs: [{ text: 'token=secret C:/private' }] }),
      doctor: async () => ({ phase: 'running', entries: [{ component: 'node', path: 'C:/private/node.exe', exists: true, status: 'ready' }], services: { dsh: 'ready', studio: 'ready' } }),
      stop,
    }
    const adapter = createSupervisorAdapter(supervisor)

    await expect(adapter.start()).resolves.toEqual({ studioUrl: 'http://127.0.0.1:4567' })
    await expect(adapter.status()).resolves.toEqual({ state: 'running', studioUrl: 'http://127.0.0.1:4567', processes: { dsh: 42 } })
    await expect(adapter.doctor()).resolves.toEqual({ ok: true, diagnostics: [] })
    await adapter.stop()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('maps every phase and strips logs paths and error messages', () => {
    expect(['stopped', 'starting', 'running', 'stopping'].map(phase => projectSupervisorStatus({
      phase,
      processes: {},
      logs: [{ text: 'token=secret C:/Users/private' }],
      lastError: { code: 'spawn-error', message: 'C:/Users/private token=secret' },
    }))).toEqual([
      { state: 'stopped', processes: {}, lastError: { code: 'spawn-error' } },
      { state: 'starting', processes: {}, lastError: { code: 'spawn-error' } },
      { state: 'running', processes: {}, lastError: { code: 'spawn-error' } },
      { state: 'stopping', processes: {}, lastError: { code: 'spawn-error' } },
    ])
  })

  it('forwards real Supervisor status events and removes the listener during cleanup', () => {
    let listener: ((status: ReturnType<SupervisorInstance['status']>) => void) | undefined
    const remove = vi.fn()
    const supervisor = {
      start: vi.fn(), stop: vi.fn(), doctor: vi.fn(),
      status: () => ({ phase: 'running', processes: {} }),
      onStatus: (next: typeof listener) => { listener = next; return remove },
    } as unknown as SupervisorInstance
    const states: string[] = []

    const unsubscribe = createSupervisorAdapter(supervisor).subscribeStatus(status => states.push(status.state))
    listener?.({ phase: 'stopping', processes: {} })
    unsubscribe()

    expect(states).toEqual(['stopping'])
    expect(remove).toHaveBeenCalledOnce()
  })

  it('supports the stable configured Supervisor factory without invoking it empty', () => {
    const factory = vi.fn((_config: ReturnType<typeof createSupervisorConfig>) => ({}) as SupervisorInstance)
    const create = supervisorCreatorFromModule({ createSupervisor: factory })
    const config = createSupervisorConfig({
      nodeExecutable: 'C:/Node24/node.exe', dshBin: 'C:/DSH/bin.js', gatewayEntry: 'C:/Studio/server.js',
      dshHome: 'C:/用户/.dsh', dshPort: 0, studioPort: 0, runtimeRoot: 'C:/DSH',
    })

    create?.(config)

    expect(factory).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledWith(config)
  })
})
