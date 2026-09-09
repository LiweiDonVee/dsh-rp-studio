export interface StoppableSupervisor { stop: () => Promise<void> | void }
export interface StudioRuntimeGuard {
  stop(): void
}

export function createStudioRuntimeGuard(dependencies: {
  subscribe(listener: (status: { state: string; lastError?: { code: string } | undefined }) => void): () => void
  revokeTrust(): void
  stopNotifications(): void
  showDiagnostics(url: string): void
  localUrl: string
}): StudioRuntimeGuard {
  let active = true
  let unsubscribe = (): void => undefined
  unsubscribe = dependencies.subscribe(status => {
    if (!active || (status.state === 'running' && status.lastError?.code !== 'child-exited')) return
    active = false
    unsubscribe()
    dependencies.revokeTrust()
    dependencies.stopNotifications()
    dependencies.showDiagnostics(dependencies.localUrl)
  })
  return {
    stop() {
      if (!active) return
      active = false
      unsubscribe()
    },
  }
}

export function createShutdownCoordinator(supervisor: StoppableSupervisor) {
  let stopped = false
  let stopping: Promise<void> | undefined
  return {
    async shutdown(): Promise<void> {
      if (stopped) return stopping ?? Promise.resolve()
      stopped = true
      stopping = Promise.resolve().then(() => supervisor.stop())
      return stopping
    },
  }
}
