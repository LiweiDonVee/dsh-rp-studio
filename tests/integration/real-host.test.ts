import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startServer } from '../../apps/gateway/src/server.js'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const officialRuntimeRoot = process.env.DSH_RUNTIME_ROOT ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime')
const dshExecutable = process.env.DSH_BIN ?? join(officialRuntimeRoot, 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const runRealHost = existsSync(dshExecutable)

async function reservePort(): Promise<number> {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('real host integration could not allocate a port')
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function waitForToken(child: ChildProcess, readLogs: () => string): Promise<string> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`temporary DSH exited before readiness with code ${child.exitCode}`)
    const token = /[?&]token=([^\s]+)/u.exec(readLogs().replaceAll(String.fromCharCode(27), ''))?.[1]
    if (token) return token
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const sanitized = readLogs().replace(/([?&]token=)[^\s"'<>]+/giu, '$1[REDACTED]').replaceAll(String.fromCharCode(27), '')
  throw new Error(`temporary DSH did not expose its launch credential before timeout: ${sanitized.slice(-4000)}`)
}

async function stopOwned(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
  } else {
    child.kill('SIGTERM')
  }
  const deadline = Date.now() + 5_000
  while (child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  if (child.exitCode === null) throw new Error(`temporary DSH process ${child.pid} did not exit after owned shutdown`)
}

describe('real temporary DSH integration', () => {
  it.skipIf(!runRealHost)('reads health, cards and session list through the official rc2 host without a model call', async () => {
    let home: string | undefined
    let child: ChildProcess | undefined
    let studio: Awaited<ReturnType<typeof startServer>> | undefined
    const previousDshToken = process.env.DSH_WEB_TOKEN
    const previousPresetToken = process.env.PROMPT_PRESETS_WEB_TOKEN
    try {
      home = await mkdtemp(join(tmpdir(), 'dsh-rp-real-host-'))
      const dshPort = await reservePort()
      const studioPort = await reservePort()
      let logs = ''
      const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(dshExecutable)
      child = spawn(shell ? `"${dshExecutable}"` : dshExecutable, ['--profile', 'web', '--host', '127.0.0.1', '--port', String(dshPort), '--no-open'], {
        cwd: studioRoot,
        env: {
          ...process.env,
          DSH_HOME: home,
        },
        shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', chunk => { logs = `${logs}${String(chunk)}`.slice(-65_536) })
      child.stderr?.on('data', chunk => { logs = `${logs}${String(chunk)}`.slice(-65_536) })
      const token = await waitForToken(child, () => logs)
      process.env.DSH_WEB_TOKEN = token
      process.env.PROMPT_PRESETS_WEB_TOKEN = token
      const publicDir = join(home, 'studio-public')
      await mkdir(publicDir)
      await writeFile(join(publicDir, 'index.html'), '<main>temporary real-host integration</main>')
      const dshUrl = `http://127.0.0.1:${dshPort}`
      studio = await startServer({
        host: '127.0.0.1',
        port: studioPort,
        dshUrl,
        dshHome: home,
        promptPresetsUrl: `${dshUrl}/prompt-presets/api`,
        publicDir,
      })

      const healthResponse = await fetch(`${studio.url}/api/v1/health`)
      const health = await healthResponse.json() as { data?: { upstream?: string; transport?: string } }
      expect({ status: healthResponse.status, data: health.data }).toMatchObject({ status: 200, data: { upstream: 'ready', transport: 'remote' } })
      const cardsResponse = await fetch(`${studio.url}/api/v1/cards`)
      const cards = await cardsResponse.json() as { data?: Array<{ id: string }> }
      expect({ status: cardsResponse.status, data: cards.data }).toMatchObject({ status: 200, data: expect.any(Array) })
      const sessionsResponse = await fetch(`${studio.url}/api/v1/sessions`)
      const sessions = await sessionsResponse.json() as { data?: Array<{ id: string; cardId: string }> }
      expect({ status: sessionsResponse.status, data: sessions.data }).toMatchObject({ status: 200, data: expect.any(Array) })
    } finally {
      let cleanupError: unknown
      try { if (studio) await studio.app.close() } catch (error) { cleanupError = error }
      try { if (child) await stopOwned(child) } catch (error) { cleanupError ??= error }
      if (previousDshToken === undefined) delete process.env.DSH_WEB_TOKEN
      else process.env.DSH_WEB_TOKEN = previousDshToken
      if (previousPresetToken === undefined) delete process.env.PROMPT_PRESETS_WEB_TOKEN
      else process.env.PROMPT_PRESETS_WEB_TOKEN = previousPresetToken
      try { if (home) await rm(home, { recursive: true, force: true }) } catch (error) { cleanupError ??= error }
      if (cleanupError) process.stderr.write(`real-host cleanup failed: ${String(cleanupError)}\n`)
    }
  }, 90_000)
})
