import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Supervisor,
  SupervisorError,
  type ManagedChildProcess,
  type ServiceSpec,
  type ServiceStatus,
  type SupervisorConfig,
} from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const dshBin = join(here, '__fixtures__', 'dsh.mjs')
const gatewayEntry = join(here, '__fixtures__', 'gateway.mjs')
const secret = 'fixture-secret-never-leak'
const supervisors: Supervisor[] = []
const temporaryHomes: string[] = []
const envKeys = ['SUPERVISOR_TEST_DSH_MODE', 'SUPERVISOR_TEST_GATEWAY_MODE', 'SUPERVISOR_TEST_SECRET', 'SUPERVISOR_TEST_PID_FILE'] as const

async function config(overrides: Partial<SupervisorConfig> = {}): Promise<SupervisorConfig> {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-rp-supervisor-'))
  temporaryHomes.push(dshHome)
  return {
    nodeExecutable: process.execPath,
    dshBin,
    gatewayEntry,
    dshHome,
    dshPort: 0,
    studioPort: 0,
    cwd: here,
    startupTimeoutMs: 3_000,
    ...overrides,
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function setMode(key: typeof envKeys[number], value: string): void {
  process.env[key] = value
}

class FakeChild extends EventEmitter implements ManagedChildProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  constructor(readonly pid: number) {
    super()
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }

  exit(code: number): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(supervisor => supervisor.stop()))
  await Promise.all(temporaryHomes.splice(0).map(path => rm(path, { recursive: true, force: true })))
  for (const key of envKeys) delete process.env[key]
})

describe('Supervisor lifecycle', () => {
  it('supports fake child/fetch dependencies and exposes typed service status without leaking tokens', async () => {
    const specs: ServiceSpec[] = []
    const children: FakeChild[] = []
    let nextPort = 41_000
    const supervisor = new Supervisor(await config(), {
      reservePort: async requested => requested || nextPort++,
      spawn: spec => {
        specs.push(spec)
        const child = new FakeChild(10_000 + specs.length)
        children.push(child)
        if (spec.service === 'dsh') {
          queueMicrotask(() => child.stdout.write('DSH http://127.0.0.1:41000/?tok'))
          queueMicrotask(() => child.stdout.write('en=fake-memory-token\n'))
        }
        return child
      },
      fetch: async (input, init) => {
        const url = String(input)
        if (url.includes('?token=')) {
          expect(init?.redirect).toBe('manual')
          return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'dsh_session=fake-cookie; HttpOnly; Path=/' } })
        }
        if (!url.endsWith('/api/v1/health')) expect(new Headers(init?.headers).get('cookie')).toBe('dsh_session=fake-cookie')
        return url.endsWith('/api/v1/health')
          ? new Response(JSON.stringify({ ok: true, protocolVersion: 1, data: { upstream: 'ready' } }))
          : new Response('<title>DeepSeek Harness</title>')
      },
      killTree: async child => { child.kill() },
    })
    supervisors.push(supervisor)

    const started = await supervisor.start()
    const service: ServiceStatus = supervisor.status().services.studio

    expect(started.launchUrl).toBe('http://127.0.0.1:41000/?token=fake-memory-token')
    expect(specs).toHaveLength(2)
    expect(specs[0]).toMatchObject({ service: 'dsh', port: 41_000 })
    expect(specs[1]).toMatchObject({
      service: 'studio',
      port: 41_001,
      env: {
        DSH_BASE_URL: 'http://127.0.0.1:41000',
        PROMPT_PRESETS_BASE_URL: 'http://127.0.0.1:41000/prompt-presets/api',
        DSH_WEB_TOKEN: 'fake-memory-token',
        PROMPT_PRESETS_WEB_TOKEN: 'fake-memory-token',
      },
    })
    expect(service).toMatchObject({ service: 'studio', state: 'running', healthy: true, pid: 10_002 })
    expect(JSON.stringify(supervisor.status())).not.toContain('fake-memory-token')
    expect(JSON.stringify(supervisor.status())).not.toContain('fake-cookie')
  })

  it('waits for a complete launch line without mixing stdout and stderr', async () => {
    const children: FakeChild[] = []
    const requests: string[] = []
    let port = 43_000
    const supervisor = new Supervisor(await config(), {
      reservePort: async () => port++,
      spawn: spec => {
        const child = new FakeChild(30_000 + children.length)
        children.push(child)
        if (spec.service === 'dsh') queueMicrotask(() => {
          child.stdout.write('prior line\nDSH http://127.0.0.1:43000/?token=prefix')
          child.stderr.write('unrelated stderr\n')
        })
        return child
      },
      fetch: async (url, init) => {
        requests.push(url)
        if (url.includes('?token=')) return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'dsh_session=full-line-cookie; Path=/' } })
        if (url.endsWith('/api/v1/health')) return new Response(JSON.stringify({ ok: true, protocolVersion: 1, data: { upstream: 'ready' } }))
        expect(new Headers(init?.headers).get('cookie')).toBe('dsh_session=full-line-cookie')
        return new Response('<title>DeepSeek Harness</title>')
      },
      killTree: async child => { child.kill() },
    })
    supervisors.push(supervisor)
    const pending = supervisor.start()
    await waitFor(() => children.length > 0)
    await new Promise(resolve => setTimeout(resolve, 70))
    const premature = [...requests]
    children[0]!.stdout.write('-remaining-secret\n')
    expect((await pending).launchUrl).toContain('token=prefix-remaining-secret')
    expect(premature).toEqual([])
    expect(supervisor.status().logs).toContainEqual({ source: 'dsh', text: 'unrelated stderr' })
  })

  it('doctor rejects an existing file that is not the configured Node runtime', async () => {
    const supervisor = new Supervisor(await config({ nodeExecutable: dshBin }))
    const node = (await supervisor.doctor()).entries.find(entry => entry.component === 'node')
    expect(node).toMatchObject({ exists: true, status: 'unhealthy' })
    expect(node?.version).toBeUndefined()
  })

  it('reclaims a dead-owner lock and preserves a replacement lock on stop', async () => {
    const options = await config()
    const path = join(options.dshHome, '.dsh-rp-supervisor.lock')
    await writeFile(path, JSON.stringify({ owner: 'dead-owner', pid: 2_147_483_647 }))
    const supervisor = new Supervisor(options)
    supervisors.push(supervisor)
    await supervisor.start()
    await unlink(path)
    const replacement = JSON.stringify({ owner: 'replacement', pid: process.pid })
    await writeFile(path, replacement)
    await supervisor.stop()
    expect(await readFile(path, 'utf8')).toBe(replacement)
  })

  it('waits for cancelled startup to finish acquiring resources before stop resolves', async () => {
    const options = await config()
    const supervisor = new Supervisor(options)
    supervisors.push(supervisor)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const validate = supervisor.validatePaths.bind(supervisor)
    supervisor.validatePaths = async () => { await gate; await validate() }
    const pending = supervisor.start().catch(error => error)
    const stopping = supervisor.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    const stoppedEarly = stopped
    release()
    await stopping
    expect(await pending).toMatchObject({ code: 'startup-cancelled' })
    expect(stoppedEarly).toBe(false)
    await expect(readFile(join(options.dshHome, '.dsh-rp-supervisor.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a startup child exit immediately with its exit diagnostics', async () => {
    const supervisor = new Supervisor(await config({ startupTimeoutMs: 2_000 }), {
      reservePort: async requested => requested || 42_000,
      spawn: spec => {
        const child = new FakeChild(20_000)
        if (spec.service === 'dsh') queueMicrotask(() => child.exit(23))
        return child
      },
      fetch: async () => new Promise<Response>(() => undefined),
      killTree: async child => { child.kill() },
    })
    supervisors.push(supervisor)

    const startedAt = Date.now()
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'child-exited' })
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(supervisor.status().lastError?.message).toContain('23')
  })

  it('starts both services, passes one shared token internally, and returns usable URLs', async () => {
    setMode('SUPERVISOR_TEST_SECRET', secret)
    const supervisor = new Supervisor(await config())
    supervisors.push(supervisor)

    const started = await supervisor.start()

    expect(started.studioUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(started.dshUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(started.launchUrl).toBe(`${started.dshUrl}/?token=${secret}`)
    expect(supervisor.status()).toMatchObject({ phase: 'running', studioUrl: started.studioUrl, dshUrl: started.dshUrl })
    expect(JSON.stringify(supervisor.status())).not.toContain(secret)
    expect(JSON.stringify(await supervisor.doctor())).not.toContain(secret)
    expect(JSON.stringify(supervisor.status().logs)).not.toContain(secret)
  })

  it('rejects a second supervisor for the same home and releases its own lock on stop', async () => {
    const shared = await config()
    const first = new Supervisor(shared)
    const second = new Supervisor(shared)
    supervisors.push(first, second)
    await first.start()

    await expect(second.start()).rejects.toMatchObject({ code: 'home-locked' })
    await first.stop()
    await expect(second.start()).resolves.toHaveProperty('studioUrl')
  })

  it('rejects occupied fixed ports and accepts port zero allocation', async () => {
    const blocker = createServer()
    const occupied = await listen(blocker)
    try {
      const rejected = new Supervisor(await config({ dshPort: occupied }))
      supervisors.push(rejected)
      await expect(rejected.start()).rejects.toMatchObject({ code: 'port-occupied' })
    } finally {
      await close(blocker)
    }

    const dynamic = new Supervisor(await config({ dshPort: 0, studioPort: 0 }))
    supervisors.push(dynamic)
    const result = await dynamic.start()
    expect(new URL(result.dshUrl).port).not.toBe('0')
    expect(new URL(result.studioUrl).port).not.toBe('0')
  })

  it('does not accept arbitrary HTTP 200 responses as service health', async () => {
    setMode('SUPERVISOR_TEST_GATEWAY_MODE', 'wrong-identity')
    const supervisor = new Supervisor(await config({ startupTimeoutMs: 300 }))
    supervisors.push(supervisor)
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'startup-timeout' })
    expect(supervisor.status().phase).toBe('stopped')
  })

  it('stops the sibling when a child exits after readiness', async () => {
    setMode('SUPERVISOR_TEST_GATEWAY_MODE', 'exit-after-ready')
    const supervisor = new Supervisor(await config())
    supervisors.push(supervisor)
    await supervisor.start()
    await waitFor(() => supervisor.status().phase === 'stopped')
    expect(supervisor.status()).toMatchObject({ phase: 'stopped', processes: {} })
  })

  it('reports timeout and spawn failures without leaking a discovered secret', async () => {
    setMode('SUPERVISOR_TEST_DSH_MODE', 'timeout')
    const timed = new Supervisor(await config({ startupTimeoutMs: 150 }))
    supervisors.push(timed)
    await expect(timed.start()).rejects.toMatchObject({ code: 'startup-timeout' })

    setMode('SUPERVISOR_TEST_DSH_MODE', 'spawn-error')
    const failed = new Supervisor(await config())
    supervisors.push(failed)
    const error = await failed.start().catch((value: unknown) => value)
    expect(error).toBeInstanceOf(SupervisorError)
    expect(String(error)).not.toContain(secret)
  })

  it('reports a gateway exit before readiness as a child failure', async () => {
    setMode('SUPERVISOR_TEST_GATEWAY_MODE', 'spawn-error')
    const supervisor = new Supervisor(await config())
    supervisors.push(supervisor)

    await expect(supervisor.start()).rejects.toMatchObject({ code: 'child-exited' })
  })

  it('coalesces concurrent starts and serializes restart with stop', async () => {
    const supervisor = new Supervisor(await config())
    supervisors.push(supervisor)
    const [one, two] = await Promise.all([supervisor.start(), supervisor.start()])
    expect(one).toEqual(two)

    const restarted = supervisor.restart()
    const stopped = supervisor.stop()
    await Promise.allSettled([restarted, stopped])
    expect(['running', 'stopped']).toContain(supervisor.status().phase)
    await supervisor.stop()
    expect(supervisor.status().phase).toBe('stopped')
  })

  it('queues a start requested while stop is still cleaning up', async () => {
    const supervisor = new Supervisor(await config())
    supervisors.push(supervisor)
    await supervisor.start()

    const stopping = supervisor.stop()
    const starting = supervisor.start()

    await stopping
    await expect(starting).resolves.toHaveProperty('studioUrl')
    expect(supervisor.status().phase).toBe('running')
  })

  it('kills only its owned process tree and leaves an unrelated process alive', async () => {
    const pidFile = join((await config()).dshHome, 'pids.txt')
    setMode('SUPERVISOR_TEST_DSH_MODE', 'grandchild')
    setMode('SUPERVISOR_TEST_PID_FILE', pidFile)
    const supervisor = new Supervisor(await config())
    supervisors.push(supervisor)
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    try {
      await supervisor.start()
      await supervisor.stop()
      expect(unrelated.exitCode).toBeNull()
      const ownedPids = (await readFile(pidFile, 'utf8')).split(',').map(Number)
      expect(ownedPids).toHaveLength(2)
      expect(supervisor.status().processes).toEqual({})
    } finally {
      unrelated.kill()
    }
  })
})
