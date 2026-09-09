import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = resolve(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? root, '.dsh-rp'))
const statePath = join(dshHome, '.dsh-rp-control.json')
const socketName = `dsh-rp-studio-${createHash('sha256').update(dshHome).digest('hex').slice(0, 24)}`
const socketPath = process.platform === 'win32' ? ['\\\\', '.', '\\pipe\\', socketName].join('') : join(dshHome, '.dsh-rp-control.sock')
const commandTimeoutMs = 120_000
const maxRequestBytes = 65_536
const bootId = process.env.DSH_RP_CONTROL_BOOT_ID
const bootErrorPath = bootId ? join(dshHome, `.dsh-rp-control-${bootId}.error`) : undefined

function redact(value) {
  return String(value).replace(/([?&]token=)[^\s"'<>]+/giu, '$1[REDACTED]')
}

function parsePort(value, fallback) {
  const port = Number(value ?? fallback)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Configured port must be an integer from 0 through 65535')
  return port
}

function supervisorConfig() {
  const dshBin = process.env.DSH_BIN ?? fileURLToPath(new URL('../../deepseek-harness-local/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
  const gatewayEntry = process.env.DSH_RP_GATEWAY_ENTRY ?? join(root, 'apps', 'gateway', 'dist', 'server.js')
  if (!existsSync(dshBin) || !existsSync(gatewayEntry)) throw new Error('Required DSH or Gateway runtime path is missing; run pnpm build and configure DSH_BIN when needed')
  return {
    nodeExecutable: process.execPath,
    dshBin,
    gatewayEntry,
    dshHome,
    dshPort: parsePort(process.env.DSH_PORT, 3080),
    studioPort: parsePort(process.env.DSH_RP_PORT, 4317),
    cwd: root,
    startupTimeoutMs: parsePort(process.env.DSH_RP_STARTUP_TIMEOUT_MS, 30_000),
  }
}

async function loadSupervisor() {
  const compiled = join(root, 'packages', 'supervisor', 'dist', 'index.js')
  if (!existsSync(compiled)) throw new Error('Supervisor dist is missing; run pnpm build before starting the stack')
  const module = await import(pathToFileURL(compiled).href)
  if (typeof module.createSupervisor !== 'function') throw new Error('Supervisor package does not export createSupervisor')
  return module.createSupervisor(supervisorConfig())
}

async function readState() {
  let content
  try { content = await readFile(statePath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  let value
  try { value = JSON.parse(content) } catch { throw new Error('Root control state is invalid') }
  if (!value || value.schemaVersion !== 1 || value.dshHome !== dshHome || value.socket !== socketPath || !Number.isSafeInteger(value.pid) || typeof value.authToken !== 'string' || value.authToken.length < 40) throw new Error('Root control state is invalid')
  return value
}

async function writeState(state) {
  await mkdir(dshHome, { recursive: true })
  const temporary = `${statePath}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, statePath)
}

async function removeOwnedState(token) {
  const current = await readState()
  if (current?.authToken === token) await rm(statePath, { force: true })
}

function responseFor(socket, value, error) {
  socket.end(JSON.stringify(error ? { ok: false, error: redact(error instanceof Error ? error.message : error) } : { ok: true, data: value }) + '\n')
}

function supervisorStatus(supervisor) {
  const status = supervisor.status()
  return { ...status, daemon: 'running', daemonPid: process.pid }
}

async function gatewayBackup(supervisor, request) {
  const status = supervisor.status()
  if (status.phase !== 'running' || !status.studioUrl) throw new Error('Studio is not running')
  if (typeof request.session !== 'string' || !request.session || typeof request.commandId !== 'string' || !request.commandId) throw new Error('backup requires --session and --command-id')
  const response = await fetch(`${status.studioUrl}/api/v1/product/backups?sessionId=${encodeURIComponent(request.session)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: request.commandId }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json()
  if (!response.ok || body.ok !== true) throw new Error(`Gateway backup failed with HTTP ${response.status}`)
  return body.data
}

async function runDaemon() {
  const authToken = randomBytes(32).toString('base64url')
  const supervisor = await loadSupervisor()
  const lockPath = `${statePath}.lock`
  let lock = await open(lockPath, 'wx').catch(() => undefined)
  if (!lock) {
    let existing
    try { existing = JSON.parse(await readFile(lockPath, 'utf8')) } catch { existing = undefined }
    let alive = false
    if (Number.isSafeInteger(existing?.pid)) {
      try { process.kill(existing.pid, 0); alive = true } catch { alive = false }
    }
    if (alive) throw new Error('A root control daemon is already starting for this DSH home')
    await rm(lockPath, { force: true })
    lock = await open(lockPath, 'wx').catch(() => undefined)
  }
  if (!lock) throw new Error('A root control daemon is already starting for this DSH home')
  await lock.writeFile(JSON.stringify({ pid: process.pid, bootId: bootId ?? null }))
  await lock.close()
  await writeState({ schemaVersion: 1, pid: process.pid, socket: socketPath, authToken, dshHome })
  let stopping = false
  const server = createServer(socket => {
    let input = ''
    let size = 0
    let handled = false
    socket.setTimeout(commandTimeoutMs, () => socket.destroy(new Error('Control request timed out')))
    const handleRequest = async () => {
      if (handled) return
      handled = true
      try {
        const request = JSON.parse(input)
        if (request.authToken !== authToken) throw new Error('Control authentication failed')
        if (request.command === 'start') {
          try {
            const result = await supervisor.start()
            responseFor(socket, { studioUrl: result.studioUrl, dshUrl: result.dshUrl, ...supervisorStatus(supervisor) })
          } catch (error) {
            await supervisor.stop().catch(() => undefined)
            throw error
          }
        } else if (request.command === 'status') {
          responseFor(socket, supervisorStatus(supervisor))
        } else if (request.command === 'doctor') {
          responseFor(socket, { ...(await supervisor.doctor()), daemon: 'running', daemonPid: process.pid })
        } else if (request.command === 'backup') {
          responseFor(socket, await gatewayBackup(supervisor, request))
        } else if (request.command === 'stop') {
          stopping = true
          await supervisor.stop()
          responseFor(socket, { phase: 'stopped', daemon: 'stopped', processes: {} })
          await new Promise(resolveClose => server.close(resolveClose))
          await removeOwnedState(authToken)
          await rm(lockPath, { force: true })
          process.exitCode = 0
        } else {
          throw new Error(`Unknown control command ${String(request.command)}`)
        }
      } catch (error) {
        responseFor(socket, undefined, error)
      }
    }
    socket.on('data', chunk => {
      size += chunk.byteLength
      if (size > maxRequestBytes) { socket.destroy(new Error('Control request is too large')); return }
      input += String(chunk)
      if (input.includes('\n')) void handleRequest()
    })
    socket.on('error', () => undefined)
  })
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(socketPath, resolveListen) })
  } catch (error) {
    await removeOwnedState(authToken)
    await rm(lockPath, { force: true })
    throw error
  }
  const cleanExit = async () => {
    if (stopping) return
    stopping = true
    await supervisor.stop().catch(() => undefined)
    await removeOwnedState(authToken)
    await rm(lockPath, { force: true })
    server.close()
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanExit().finally(() => process.exit(0)) })
}

function request(state, command, values = {}) {
  return new Promise((resolveRequest, reject) => {
    const socket = connect(state.socket)
    let input = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Control daemon did not respond before timeout')) }, commandTimeoutMs)
    socket.on('data', chunk => {
      if (input.length + chunk.byteLength > maxRequestBytes) { socket.destroy(new Error('Control response is too large')); return }
      input += String(chunk)
    })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
    socket.once('end', () => {
      clearTimeout(timer)
      try {
        const result = JSON.parse(input)
        if (!result.ok) reject(new Error(result.error))
        else resolveRequest(result.data)
      } catch (error) { reject(error) }
    })
    socket.once('connect', () => {
      const payload = JSON.stringify({ command, ...values, authToken: state.authToken }) + '\n'
      if (process.platform === 'win32') socket.write(payload)
      else socket.end(payload)
    })
  })
}

async function ensureDaemon() {
  const current = await readState()
  if (current?.authToken) {
    try { await request(current, 'status'); return current } catch (error) {
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') await removeOwnedState(current.authToken)
      else throw error
    }
  }
  await mkdir(dshHome, { recursive: true })
  const nextBootId = randomUUID()
  const errorPath = join(dshHome, `.dsh-rp-control-${nextBootId}.error`)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--daemon'], { cwd: root, env: { ...process.env, DSH_RP_CONTROL_BOOT_ID: nextBootId }, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  const deadline = Date.now() + commandTimeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Root control daemon exited with code ${child.exitCode}`)
    const detail = await readFile(errorPath, 'utf8').catch(() => undefined)
    if (detail) { await rm(errorPath, { force: true }); throw new Error(detail) }
    const current = await readState()
    if (current?.authToken) {
    try { await request(current, 'status'); return current } catch { }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('Root control daemon did not become ready before timeout')
}

function parseArguments(args) {
  const [command = 'start', ...rest] = args
  const values = {}
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]
    const value = rest[index + 1]
    if (key === '--session' || key === '--command-id') {
      if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
      if (key === '--session') values.session = value
      else values.commandId = value
      index += 1
      continue
    }
    if (key?.startsWith('--')) throw new Error(`Unknown option ${key}`)
    throw new Error(`Unexpected argument ${key}`)
  }
  return { command, values }
}

async function runClient(command, values) {
  if (!['start', 'stop', 'status', 'doctor', 'backup'].includes(command)) throw new Error(`Unknown control command ${command}`)
  if (command === 'status') {
    let current
    try { current = await readState() } catch (error) { return { phase: 'error', daemon: 'state-invalid', processes: {}, error: redact(error) } }
    if (!current?.authToken) return { phase: 'stopped', daemon: 'not-running', processes: {} }
    try { return await request(current, 'status') } catch { return { phase: 'stopped', daemon: 'not-running', processes: {} } }
  }
  const current = command === 'start' ? await ensureDaemon() : await readState()
  if (!current?.authToken) throw new Error('Root control daemon is not running')
  const result = await request(current, command, values)
  if (command === 'stop') {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && await readState()) await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  return result
}

if (process.argv[2] === '--daemon') {
  runDaemon().catch(async error => {
    const detail = redact(error)
    if (bootErrorPath) await writeFile(bootErrorPath, detail, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined)
    await rm(`${statePath}.lock`, { force: true })
    process.exitCode = 1
  })
} else {
  const { command, values } = parseArguments(process.argv.slice(2))
  runClient(command, values).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { process.stderr.write(`${redact(error)}\n`); process.exitCode = 1 })
}
