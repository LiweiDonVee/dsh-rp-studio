import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const electronEntry = require.resolve('electron/cli.js')
const electronBinary = require('electron')
if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) throw new Error('Electron smoke requires a genuine installed Electron binary')

const temporaryHome = await mkdtemp(join(tmpdir(), 'dsh-rp-studio-smoke-'))
const userData = join(temporaryHome, 'user-data')
const screenshot = join(temporaryHome, 'smoke.png')
const retainedScreenshot = process.env.DSH_DESKTOP_SMOKE_RETAIN_SCREENSHOT
await mkdir(userData, { recursive: true })
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}') })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Electron smoke could not allocate a dynamic loopback port')

const environment = {
  ...process.env,
  DSH_DESKTOP_SMOKE: '1',
  DSH_DESKTOP_SMOKE_HEALTH_URL: `http://127.0.0.1:${address.port}/health`,
  DSH_DESKTOP_SMOKE_SCREENSHOT: screenshot,
  HOME: temporaryHome,
  USERPROFILE: temporaryHome,
  APPDATA: join(temporaryHome, 'app-data'),
  LOCALAPPDATA: join(temporaryHome, 'local-app-data'),
}
delete environment.ELECTRON_RUN_AS_NODE
let stdout = ''
let stderr = ''
let child
try {
  child = spawn(process.execPath, [electronEntry, '--disable-gpu', '--disable-software-rasterizer', `--user-data-dir=${userData}`, process.cwd()], { cwd: process.cwd(), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await Promise.race([
    new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Electron smoke timed out')), 20_000)),
  ])
  if (code !== 0) throw new Error(`Electron smoke exited with ${code}\n${stderr}`)
  const line = stdout.split(/\r?\n/u).find(value => value.startsWith('DSH_DESKTOP_SMOKE_RESULT:'))
  if (!line) throw new Error(`Electron smoke returned no validated result\n${stdout}\n${stderr}`)
  const result = JSON.parse(line.slice('DSH_DESKTOP_SMOKE_RESULT:'.length))
  if (result.title !== 'DSH RP Studio Diagnostics' || result.bridge !== true || result.ipcReady !== true || result.healthStatus !== 200 || result.sandboxed !== true) throw new Error(`Electron smoke assertion failed: ${JSON.stringify(result)}`)
  if (!existsSync(screenshot)) throw new Error('Electron smoke did not produce a screenshot')
  if (retainedScreenshot) await copyFile(screenshot, retainedScreenshot)
  process.stdout.write(`${line}\nScreenshot: ${screenshot}\n`)
} finally {
  if (child && child.exitCode === null) child.kill()
  await new Promise(resolve => server.close(resolve))
  await rm(temporaryHome, { recursive: true, force: true })
}
