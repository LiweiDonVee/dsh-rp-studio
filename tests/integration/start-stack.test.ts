import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../..')

async function command(home: string, args: string[]) {
  const result = await execFileAsync(process.execPath, ['scripts/start-stack.mjs', ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DSH_HOME: home,
      HOME: home,
      USERPROFILE: home,
      DSH_BIN: join(repositoryRoot, 'packages', 'supervisor', 'src', '__fixtures__', 'dsh.mjs'),
      DSH_RP_GATEWAY_ENTRY: join(repositoryRoot, 'tests', 'integration', 'fixtures', 'gateway-control.mjs'),
      DSH_PORT: '0',
      DSH_RP_PORT: '0',
      DSH_RP_STARTUP_TIMEOUT_MS: '5000',
      SUPERVISOR_TEST_SECRET: 'root-control-secret-canary',
    },
    timeout: 15_000,
  })
  return JSON.parse(result.stdout)
}

describe('root Supervisor control daemon', () => {
  it('reports stopped without starting services when no owned daemon exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rp-control-status-'))
    const result = await execFileAsync(process.execPath, ['scripts/start-stack.mjs', 'status'], {
      cwd: repositoryRoot,
      env: { ...process.env, DSH_HOME: home, HOME: home, USERPROFILE: home, DSH_BIN: join(home, 'not-a-runtime.js') },
      timeout: 5_000,
    })

    expect(JSON.parse(result.stdout)).toMatchObject({ phase: 'stopped', daemon: 'not-running', processes: {} })
  })

  it('owns one persistent daemon while Supervisor owns every managed service process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rp-control-lifecycle-'))
    try {
      const started = await command(home, ['start'])
      expect(started).toMatchObject({ phase: 'running', daemon: 'running', daemonPid: expect.any(Number), processes: { dsh: expect.any(Number), studio: expect.any(Number) } })
      const repeated = await command(home, ['start'])
      expect(repeated.daemonPid).toBe(started.daemonPid)
      const status = await command(home, ['status'])
      expect(status).toMatchObject({ phase: 'running', daemonPid: started.daemonPid, studioUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u) })
      const doctor = await command(home, ['doctor'])
      expect(doctor).toMatchObject({ phase: 'running', services: { dsh: 'ready', studio: 'ready' } })
      const backup = await command(home, ['backup', '--session', 'session-root-control', '--command-id', 'root-control'])
      expect(backup).toMatchObject({ id: 'backup-root-control', state: 'ready', manifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })
    } finally {
      await command(home, ['stop']).catch(() => undefined)
    }
    expect(await command(home, ['status'])).toMatchObject({ phase: 'stopped', daemon: 'not-running', processes: {} })
  }, 30_000)
})
