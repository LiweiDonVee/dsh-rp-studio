import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startServer } from '../../apps/gateway/src/server.js'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repositoriesRoot = resolve(studioRoot, '..')
const dshExecutable = join(repositoriesRoot, 'deepseek-harness-local', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const userProfile = process.env.USERPROFILE ?? ''
const sourceProfile = join(userProfile, '.dsh', 'profiles', 'web')

async function reservePort(): Promise<number> {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('real host integration could not allocate a port')
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function prepareTemporaryHost(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-rp-real-host-'))
  try {
    const profile = join(home, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    for (const file of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml']) await cp(join(sourceProfile, file), join(profile, file))
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: cherry-provider-bridge\n  disabled: true\n')
    await symlink(join(sourceProfile, 'node_modules'), join(profile, 'node_modules'), 'junction')

    const presetRoot = join(home, '.agent-presets')
    await mkdir(presetRoot)
    for (const preset of ['rp-runtime', 'zombie-world', 'rp-card-builder']) {
      await cp(join(repositoriesRoot, 'dsh-rp-preset', '05-delivery', preset), join(presetRoot, preset), { recursive: true })
    }
    await cp(join(repositoriesRoot, 'rp', 'HP：魔药宗师'), join(presetRoot, 'hp-potion-master'), {
      recursive: true,
      filter: source => !source.includes('.compat') && !source.includes('.snapshots'),
    })
    for (const preset of ['router-standard', 'router-spec', 'router-react']) {
      await cp(join(repositoriesRoot, 'dsh-routing-suite', 'preset', preset), join(presetRoot, preset), { recursive: true })
    }
    return home
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
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

describe('real temporary DSH release-card integration', () => {
  it('discovers and creates sessions for the HP and Zombie release cards through Gateway', async () => {
    let home: string | undefined
    let junction: string | undefined
    let child: ChildProcess | undefined
    let studio: Awaited<ReturnType<typeof startServer>> | undefined
    const previousDshToken = process.env.DSH_WEB_TOKEN
    const previousPresetToken = process.env.PROMPT_PRESETS_WEB_TOKEN
    try {
      home = await prepareTemporaryHost()
      junction = join(home, 'profiles', 'web', 'node_modules')
      const dshPort = await reservePort()
      const studioPort = await reservePort()
      let logs = ''
      child = spawn(process.execPath, [dshExecutable, '--profile', 'web', '--host', '127.0.0.1', '--port', String(dshPort), '--no-open'], {
        cwd: repositoriesRoot,
        env: {
          ...process.env,
          DSH_HOME: home,
          HOME: home,
          USERPROFILE: home,
          APPDATA: join(home, 'app-data'),
          LOCALAPPDATA: join(home, 'local-app-data'),
        },
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

      const cardsResponse = await fetch(`${studio.url}/api/v1/cards`)
      const cards = await cardsResponse.json() as { data: Array<{ id: string }> }
      expect({ status: cardsResponse.status, ids: cards.data.map(value => value.id) }).toMatchObject({ status: 200, ids: expect.arrayContaining(['zombie-world', 'hp-potion-master']) })

      for (const cardId of ['zombie-world', 'hp-potion-master']) {
        const createdResponse = await fetch(`${studio.url}/api/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId }) })
        const created = await createdResponse.json() as { data?: { session?: { id?: string; cardId?: string } }; error?: unknown }
        expect({ status: createdResponse.status, body: created }).toMatchObject({ status: 200, body: { data: { session: { id: expect.any(String), cardId } } } })
        const sessionId = created.data!.session!.id!
        const detailResponse = await fetch(`${studio.url}/api/v1/sessions/${encodeURIComponent(sessionId)}`)
        expect(detailResponse.status).toBe(200)
        const methodsResponse = await fetch(`${studio.url}/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt-presets`)
        const methods = await methodsResponse.json() as { data?: { available?: boolean } }
        expect({ status: methodsResponse.status, available: methods.data?.available }).toEqual({ status: 200, available: true })
      }
    } finally {
      let cleanupError: unknown
      try { if (studio) await studio.app.close() } catch (error) { cleanupError = error }
      try { if (child) await stopOwned(child) } catch (error) { cleanupError ??= error }
      if (previousDshToken === undefined) delete process.env.DSH_WEB_TOKEN
      else process.env.DSH_WEB_TOKEN = previousDshToken
      if (previousPresetToken === undefined) delete process.env.PROMPT_PRESETS_WEB_TOKEN
      else process.env.PROMPT_PRESETS_WEB_TOKEN = previousPresetToken
      try { if (junction) await rm(junction, { recursive: false, force: true }) } catch (error) { cleanupError ??= error }
      try { if (home) await rm(home, { recursive: true, force: true }) } catch (error) { cleanupError ??= error }
      if (cleanupError) process.stderr.write(`real-host cleanup failed: ${String(cleanupError)}\n`)
    }
  }, 90_000)
})
