import { spawn, execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { verifyInstalled } from './inputs.mjs'
import { assertRunDirectory, ownedRunPath } from './paths.mjs'
export { assertRunDirectory } from './paths.mjs'

export const redact = value => String(value).replace(/([?&]token=)[^\s"'<>]+/giu, '$1[REDACTED]').replace(/(Bearer\s+)[\w.-]+/giu, '$1[REDACTED]')
const quote = value => { if (/["\r\n]/u.test(value)) throw new Error('INVALID_CLI_ARGUMENT'); if (process.platform === 'win32' && value.includes('%')) throw new Error('CLI_PERCENT_ARGUMENT_UNSUPPORTED'); return process.platform === 'win32' ? `"${value}"` : value }
export const defaultCli = () => process.env.DSH_BIN ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd')
export async function closeOwnedResources(browser, host) {
  const results = await Promise.allSettled([browser, host].map(resource => Promise.resolve().then(() => resource?.close())))
  return results.flatMap((result, index) => result.status === 'rejected' ? [{ resource: index === 0 ? 'browser' : 'host', message: redact(result.reason?.message ?? result.reason).slice(0, 600) }] : [])
}
export async function runCli(cli, args, environment, cwd) {
  return new Promise((done, reject) => {
    const child = spawn(quote(cli), args.map(quote), { cwd, env: environment, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { void stopOwned(child).then(() => reject(new Error('CLI_TIMEOUT')), reject) }, 60000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', part => { output = (output + part).slice(-200000) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); if (code === 0) done(output.trim()); else reject(new Error(`CLI_FAILED:${code}:${redact(output.slice(-4000))}`)) })
  })
}
export async function stopOwned(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') await new Promise(done => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => done()))
  else child.kill('SIGTERM')
  if (child.exitCode === null && child.signalCode === null) await new Promise((done, reject) => {
    const exited = () => { clearTimeout(timer); done() }
    const timer = setTimeout(() => { child.removeListener('exit', exited); reject(new Error('OWNED_PROCESS_STOP_TIMEOUT')) }, 5000)
    child.once('exit', exited)
  })
}
export async function installInputs({ staged, home, cli, workspace, log }) {
  const run = await assertRunDirectory(workspace, dirname(home))
  home = await ownedRunPath(workspace, run, home)
  quote(cli); quote(home); for (const input of staged.packages) quote(input.archive)
  try { await mkdir(home) } catch (error) { if (error.code === 'EEXIST') throw new Error('INSPECTION_HOME_ALREADY_USED_USE_NEW_RUN'); throw error }
  await writeFile(await ownedRunPath(workspace, run, join(home, 'package.json')), '{"name":"studio-native-isolated-home","private":true,"type":"module"}\n', { flag: 'wx' })
  const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'unused-local-studio-fixture', DSH_TOOLS_MODE: 'native' }
  const version = await runCli(cli, ['--version'], env, workspace)
  if (version !== staged.hostVersion) throw new Error(`HOST_VERSION_MISMATCH:${version}`)
  const installed = []
  for (const input of staged.packages) {
    log(`install ${input.name}@${input.version} ${input.sha256}`)
    const output = await runCli(cli, ['plugin', '--profile', 'web', 'add', input.archive], env, workspace)
    await writeFile(await ownedRunPath(workspace, run, join(home, `install-${input.name}.log`)), redact(output) + '\n')
    installed.push(await verifyInstalled(home, input))
  }
  return { version, installed, env }
}
export async function startHost({ cli, home, patch, workspace, env, logPath }) {
  const run = await assertRunDirectory(workspace, dirname(home))
  home = await ownedRunPath(workspace, run, home)
  patch = await ownedRunPath(workspace, run, patch)
  logPath = await ownedRunPath(workspace, run, logPath)
  const child = spawn(quote(cli), ['web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'].map(quote), { cwd: workspace, env: { ...env, DSH_HOME: home }, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = '', stopped = false
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-200000) })
  const close = async () => { if (stopped) return; stopped = true; await stopOwned(child); await writeFile(await ownedRunPath(workspace, run, logPath), redact(logs)) }
  let startupError
  child.on('error', error => { startupError = error })
  try {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (startupError) throw startupError
      const url = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0]
      if (url) return { child, url, close }
      if (child.exitCode !== null) throw new Error(`HOST_EXITED:${child.exitCode}:${redact(logs.slice(-4000))}`)
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error(`HOST_START_TIMEOUT:${redact(logs.slice(-4000))}`)
  } catch (error) { await close(); throw error }
}
export async function copyFixtureFiles(workspace, destination) {
  const run = await assertRunDirectory(workspace, dirname(destination))
  destination = await ownedRunPath(workspace, run, destination)
  await mkdir(destination, { recursive: true })
  for (const file of ['fixture.mjs', 'model-fixture.mjs', 'requirements.mjs']) await writeFile(await ownedRunPath(workspace, run, join(destination, file)), await readFile(join(workspace, 'scripts/native-integration', file)))
}
