import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopSettings } from './settings.js'
import type { DesktopDoctor, DesktopStatus } from '../shared/ipc-schema.js'

export interface SupervisorConfig {
  nodeExecutable: string
  dshBin: string
  gatewayEntry: string
  dshHome: string
  dshPort: number
  studioPort: number
  cwd: string
  startupTimeoutMs?: number
}

export interface SupervisorStatusSnapshot {
  phase: string
  studioUrl?: string
  dshUrl?: string
  processes: { dsh?: number; studio?: number }
  logs?: readonly unknown[]
  lastError?: { code: string; message: string }
}

export interface SupervisorInstance {
  start(): Promise<{ studioUrl: string; dshUrl: string; launchUrl: string }>
  status(): SupervisorStatusSnapshot
  doctor(): Promise<{ phase: string; entries: readonly { component: string; path: string; exists: boolean; version?: string; status: string }[]; services: { dsh: string; studio: string } }>
  stop(): Promise<void>
  onStatus?(listener: (status: SupervisorStatusSnapshot) => void): () => void
}

export interface SupervisorConstructor { new(config: SupervisorConfig): SupervisorInstance }
export type SupervisorCreator = (config: SupervisorConfig) => SupervisorInstance

export function supervisorCreatorFromModule(module: { Supervisor?: SupervisorConstructor; createSupervisor?: SupervisorCreator }): SupervisorCreator | undefined {
  const Constructor = module.Supervisor
  const create = module.createSupervisor
  if (Constructor) return config => new Constructor(config)
  if (create) return config => create(config)
  return undefined
}

export interface DesktopSupervisor {
  start(): Promise<{ studioUrl: string }>
  status(): Promise<DesktopStatus>
  doctor(): Promise<DesktopDoctor>
  stop(): Promise<void>
  subscribeStatus(listener: (status: DesktopStatus) => void): () => void
}

export function createSupervisorConfig(settings: DesktopSettings): SupervisorConfig {
  return {
    nodeExecutable: settings.nodeExecutable,
    dshBin: settings.dshBin,
    gatewayEntry: settings.gatewayEntry,
    dshHome: settings.dshHome,
    dshPort: settings.dshPort,
    studioPort: settings.studioPort,
    cwd: settings.runtimeRoot || dirname(settings.gatewayEntry),
    startupTimeoutMs: 30_000,
  }
}

export function projectSupervisorStatus(status: SupervisorStatusSnapshot): DesktopStatus {
  const states = new Set(['stopped', 'starting', 'running', 'stopping'])
  const state = states.has(status.phase) ? status.phase as DesktopStatus['state'] : 'error'
  return {
    state,
    ...(status.studioUrl ? { studioUrl: status.studioUrl } : {}),
    processes: {
      ...(status.processes.dsh ? { dsh: status.processes.dsh } : {}),
      ...(status.processes.studio ? { studio: status.processes.studio } : {}),
    },
    ...(status.lastError?.code ? { lastError: { code: status.lastError.code } } : {}),
  }
}

export function createSupervisorAdapter(supervisor?: SupervisorInstance): DesktopSupervisor {
  return {
    async start() {
      if (!supervisor) throw new Error('Supervisor integration unavailable')
      const result = await supervisor.start()
      return { studioUrl: result.studioUrl }
    },
    async status() { return supervisor ? projectSupervisorStatus(supervisor.status()) : { state: 'unavailable', processes: {} } },
    async doctor() {
      if (!supervisor) return { ok: false, diagnostics: [{ code: 'supervisor-unavailable', message: 'Supervisor integration is unavailable' }] }
      const result = await supervisor.doctor()
      const diagnostics = result.entries.filter(entry => entry.status !== 'ready').map(entry => ({ code: `${entry.component}-${entry.status}`.slice(0, 100), message: `${entry.component} runtime is ${entry.status}`.slice(0, 500) }))
      for (const [service, state] of Object.entries(result.services)) if (state === 'unhealthy') diagnostics.push({ code: `${service}-unhealthy`, message: `${service} service is unhealthy` })
      return { ok: diagnostics.length === 0, diagnostics }
    },
    async stop() { if (supervisor) await supervisor.stop() },
    subscribeStatus(listener) {
      if (!supervisor) return () => undefined
      if (supervisor.onStatus) return supervisor.onStatus(status => listener(projectSupervisorStatus(status)))
      let polling = false
      const timer = setInterval(() => {
        if (polling) return
        polling = true
        try { listener(projectSupervisorStatus(supervisor.status())) } finally { polling = false }
      }, 500)
      timer.unref()
      return () => clearInterval(timer)
    },
  }
}

export async function loadSupervisorConstructor(appPath: string): Promise<SupervisorConstructor | undefined> {
  const candidates = [
    '@dsh-rp/supervisor',
    pathToFileURL(join(appPath, 'node_modules', '@dsh-rp', 'supervisor', 'dist', 'index.js')).href,
    pathToFileURL(join(appPath, '..', '..', 'packages', 'supervisor', 'dist', 'index.js')).href,
    pathToFileURL(join(appPath, '..', '..', 'packages', 'supervisor', 'src', 'index.ts')).href,
  ]
  for (const candidate of candidates) {
    try {
      if (candidate.startsWith('file:')) await access(new URL(candidate))
      const loaded = await import(candidate) as { Supervisor?: SupervisorConstructor }
      if (loaded.Supervisor) return loaded.Supervisor
    } catch {
      continue
    }
  }
  return undefined
}

export async function loadSupervisorCreator(appPath: string): Promise<SupervisorCreator | undefined> {
  const candidates = [
    '@dsh-rp/supervisor',
    pathToFileURL(join(appPath, 'node_modules', '@dsh-rp', 'supervisor', 'dist', 'index.js')).href,
    pathToFileURL(join(appPath, '..', '..', 'packages', 'supervisor', 'dist', 'index.js')).href,
    pathToFileURL(join(appPath, '..', '..', 'packages', 'supervisor', 'src', 'index.ts')).href,
  ]
  for (const candidate of candidates) {
    try {
      if (candidate.startsWith('file:')) await access(new URL(candidate))
      const loaded = await import(candidate) as { Supervisor?: SupervisorConstructor; createSupervisor?: SupervisorCreator }
      const create = supervisorCreatorFromModule(loaded)
      if (create) return create
    } catch {
      continue
    }
  }
  return undefined
}
