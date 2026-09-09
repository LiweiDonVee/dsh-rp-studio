import { spawn } from 'node:child_process'
import { basename, isAbsolute, resolve, win32 } from 'node:path'

export interface RuntimeDiagnostic { code: string; message: string; detail?: string }

export async function validateNodeExecutable(executable: string | undefined, spawnProcess: typeof spawn = spawn): Promise<RuntimeDiagnostic[]> {
  const candidate = executable?.trim() || ''
  if (!candidate) return [{ code: 'node-missing', message: 'An independent Node.js 24 executable must be selected.' }]
  if (!isAbsolute(candidate) && !win32.isAbsolute(candidate)) return [{ code: 'node-path', message: 'The Node executable path must be absolute.' }]
  if ((process.versions.electron && resolve(candidate).toLowerCase() === resolve(process.execPath).toLowerCase()) || /electron(?:\.exe)?$/iu.test(basename(candidate))) {
    return [{ code: 'electron-runtime', message: 'Gateway/DSH must use an independent Node 24 executable, not Electron.', detail: candidate }]
  }
  return new Promise(resolve => {
    let child: ReturnType<typeof spawnProcess>
    try { child = spawnProcess(candidate, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
    catch (error) {
      resolve([{ code: 'node-missing', message: 'Configured Node executable could not be started.', detail: error instanceof Error ? error.message : String(error) }])
      return
    }
    let output = ''
    let settled = false
    const finish = (diagnostics: RuntimeDiagnostic[]) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(diagnostics)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish([{ code: 'node-timeout', message: 'Configured Node executable did not complete its version check.' }])
    }, 5_000)
    timeout.unref()
    child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-4096) })
    child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-4096) })
    child.once('error', error => finish([{ code: 'node-missing', message: 'Configured Node executable could not be started.', detail: error.message }]))
    child.once('close', code => {
      if (code !== 0) return finish([{ code: 'node-failed', message: 'Configured Node executable failed its version check.', detail: output.trim() }])
      const match = /^v(\d+)\.\d+\.\d+\s*$/u.exec(output.trim())
      if (!match || match[1] !== '24') return finish([{ code: 'node-version', message: 'Gateway/DSH requires Node.js major version 24.', detail: output.trim() }])
      finish([])
    })
  })
}
