import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ManagedChildProcess, ServiceSpec } from './index.js'

const execute = promisify(execFile)
const managed = new WeakSet<ManagedChildProcess>()

export async function nodeVersion(executable: string): Promise<string | undefined> {
  try {
    const { stdout } = await execute(executable, ['--version'], { windowsHide: true, timeout: 2_000, maxBuffer: 4096 })
    return /^v(\d+\.\d+\.\d+)\s*$/u.exec(stdout)?.[1]
  } catch { return undefined }
}

export async function processIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().Ticks.ToString() }`,
    ], { windowsHide: true, timeout: 5_000, maxBuffer: 4096 })
    return stdout.trim() || undefined
  }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000, maxBuffer: 4096 })
  return stdout.trim() || undefined
}

export function spawnTree(spec: ServiceSpec): ChildProcess {
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./windows-tree.ps1', import.meta.url))], {
      cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    : spawn(spec.executable, spec.args, {
      cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
  managed.add(child)
  if (process.platform === 'win32') child.stdin?.write(`${JSON.stringify({ executable: spec.executable, args: spec.args })}\n`)
  return child
}

async function waitForExit(child: ManagedChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Owned process tree did not exit.')), 15_000)
    const onExit = () => finish()
    function finish(error?: Error) {
      clearTimeout(timer)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    child.once('exit', onExit)
  })
}

export async function killTree(child: ManagedChildProcess): Promise<void> {
  if (!managed.has(child)) throw new Error('Refusing to stop an unowned process.')
  if (process.platform === 'win32') {
    // Closing the control pipe triggers TerminateJobObject and an active-process wait.
    ;(child as ChildProcess).stdin?.end()
    await waitForExit(child)
    return
  }
  const pid = child.pid
  if (!pid) return
  const alive = () => {
    try { process.kill(-pid, 0); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }
  if (alive()) process.kill(-pid, 'SIGTERM')
  const deadline = Date.now() + 5_000
  while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  if (alive()) process.kill(-pid, 'SIGKILL')
  const forcedDeadline = Date.now() + 5_000
  while (alive() && Date.now() < forcedDeadline) await new Promise(resolve => setTimeout(resolve, 25))
  if (alive()) throw new Error('Owned process group did not exit.')
  await waitForExit(child)
}
