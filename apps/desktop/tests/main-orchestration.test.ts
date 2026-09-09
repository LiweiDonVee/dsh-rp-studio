import { describe, expect, it } from 'vitest';
import { createShutdownCoordinator, createStudioRuntimeGuard } from '../src/main/orchestration.js';

describe('shutdown orchestration', () => {
  it('stops Supervisor exactly once during graceful quit', async () => {
    let stops = 0;
    const coordinator = createShutdownCoordinator({ stop: async () => { stops += 1; } });
    await coordinator.shutdown();
    await coordinator.shutdown();
    expect(stops).toBe(1);
  });

  it('revokes trust, stops notifications, and returns to the exact diagnostics URL on child exit', () => {
    let listener: ((status: { state: string; lastError?: { code: string } }) => void) | undefined
    let trusted = 'http://127.0.0.1:4317'
    const stopped: string[] = []
    const loaded: string[] = []
    const guard = createStudioRuntimeGuard({
      subscribe: next => { listener = next; return () => { listener = undefined } },
      revokeTrust: () => { trusted = '' },
      stopNotifications: () => { stopped.push('stopped') },
      showDiagnostics: url => { loaded.push(url) },
      localUrl: 'file:///C:/应用/dist/renderer/index.html',
    })

    listener?.({ state: 'running', lastError: { code: 'child-exited' } })

    expect(trusted).toBe('')
    expect(stopped).toEqual(['stopped'])
    expect(loaded).toEqual(['file:///C:/应用/dist/renderer/index.html'])
    guard.stop()
    expect(listener).toBeUndefined()
  })
});
