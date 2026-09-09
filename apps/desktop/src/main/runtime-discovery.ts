import { execFile } from 'node:child_process'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { validateNodeExecutable } from './runtime-doctor.js'
import type { DesktopSettings } from './settings.js'

type NodeValidator = (path: string) => Promise<boolean>
type NodeLocator = () => Promise<string[]>

async function exists(path: string): Promise<boolean> {
  if (!path) return false
  try { await access(path); return true } catch { return false }
}

function absolutePath(candidate: string): boolean {
  return isAbsolute(candidate) || win32.isAbsolute(candidate)
}

async function locateNodeOnPath(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  return new Promise(resolveCandidates => {
    execFile(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'where.exe'), ['node.exe'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) { resolveCandidates([]); return }
      resolveCandidates(stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean))
    })
  })
}

export async function resolveIndependentNode(
  env: NodeJS.ProcessEnv = process.env,
  validate: NodeValidator = async path => (await validateNodeExecutable(path)).length === 0,
  locate: NodeLocator = locateNodeOnPath,
): Promise<string> {
  const discovered = env.DSH_NODE_EXECUTABLE && absolutePath(env.DSH_NODE_EXECUTABLE) ? [] : await locate().catch(() => [])
  const candidates = [env.DSH_NODE_EXECUTABLE, ...discovered].filter((value): value is string => Boolean(value?.trim()))
  for (const value of candidates) {
    const candidate = value.trim()
    if (!absolutePath(candidate)) continue
    if (process.versions.electron && resolve(candidate).toLowerCase() === resolve(process.execPath).toLowerCase()) continue
    if (/electron(?:\.exe)?$/iu.test(candidate)) continue
    if (await validate(candidate)) return candidate
  }
  return ''
}

async function resolveDshCli(dshRoot: string): Promise<string> {
  if (!dshRoot) return ''
  const packageRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh')
  try {
    const manifest: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object') return ''
    const bin = (manifest as { bin?: unknown }).bin
    const entry = typeof bin === 'string'
      ? bin
      : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).dsh === 'string'
        ? (bin as Record<string, string>).dsh
        : ''
    if (!entry) return ''
    const candidate = resolve(packageRoot, entry)
    const local = relative(packageRoot, candidate)
    if (!local || local.startsWith('..') || isAbsolute(local)) return ''
    return await exists(candidate) ? candidate : ''
  } catch { return '' }
}

export async function discoverRuntimeSettings(
  current: DesktopSettings,
  desktopPath: string,
  defaultDshHome: string,
  env: NodeJS.ProcessEnv = process.env,
  validate: NodeValidator = async path => (await validateNodeExecutable(path)).length === 0,
  development = true,
): Promise<DesktopSettings> {
  const studioRoot = development ? resolve(desktopPath, '..', '..') : env.DSH_STUDIO_ROOT?.trim() || ''
  const defaultDshRoot = development ? resolve(studioRoot, '..', 'deepseek-harness-local') : ''
  const explicitDshRoot = env.DSH_ROOT?.trim() || ''
  const dshRoot = explicitDshRoot || current.runtimeRoot || defaultDshRoot
  const configuredDshBin = env.DSH_BIN?.trim() || (!explicitDshRoot ? current.dshBin : '')
  const dshBin = configuredDshBin || await resolveDshCli(dshRoot)
  const configuredGateway = env.DSH_GATEWAY_ENTRY?.trim() || current.gatewayEntry
  const gatewayCandidate = configuredGateway || (studioRoot ? join(studioRoot, 'apps', 'gateway', 'dist', 'server.js') : '')
  const nodeEnvironment = { ...env, DSH_NODE_EXECUTABLE: env.DSH_NODE_EXECUTABLE?.trim() || current.nodeExecutable }
  return {
    ...current,
    nodeExecutable: await resolveIndependentNode(nodeEnvironment, validate),
    dshBin: await exists(dshBin) ? dshBin : current.dshBin,
    gatewayEntry: await exists(gatewayCandidate) ? gatewayCandidate : current.gatewayEntry,
    dshHome: env.DSH_HOME?.trim() || current.dshHome || (env.DSH_DESKTOP_BOOTSTRAP_HOME === '1' ? defaultDshHome : ''),
    runtimeRoot: dshRoot,
  }
}

export async function validateRuntimeSettings(settings: DesktopSettings, validate: NodeValidator = async path => (await validateNodeExecutable(path)).length === 0): Promise<string[]> {
  const invalid: string[] = []
  if (!settings.nodeExecutable || !(await validate(settings.nodeExecutable))) invalid.push('nodeExecutable')
  for (const field of ['dshBin', 'gatewayEntry', 'dshHome', 'runtimeRoot'] as const) {
    try {
      if (!absolutePath(settings[field])) throw new Error('Not absolute')
      const info = await stat(settings[field])
      if (field === 'dshBin' || field === 'gatewayEntry' ? !info.isFile() : !info.isDirectory()) throw new Error('Wrong type')
    } catch { invalid.push(field) }
  }
  if (settings.dshHome && !invalid.includes('dshHome')) {
    try {
      const presets = await readdir(join(settings.dshHome, '.agent-presets'), { withFileTypes: true })
      if (!presets.some(preset => preset.isDirectory())) invalid.push('dshHome')
    } catch { invalid.push('dshHome') }
  }
  if (settings.gatewayEntry && !invalid.includes('gatewayEntry') && !await exists(resolve(settings.gatewayEntry, '..', '..', '..', 'web', 'dist', 'index.html'))) invalid.push('webDist')
  return invalid
}
