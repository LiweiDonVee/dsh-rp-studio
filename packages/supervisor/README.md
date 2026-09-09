# `@dsh-rp/supervisor`

Process supervisor for the local DSH Web host and the RP Studio Gateway. It is
intended to be owned by an Electron **main process** (or another trusted local
controller), not by a renderer or preload script.

## API

```ts
import { createSupervisor, Supervisor } from '@dsh-rp/supervisor'

const config = {
  nodeExecutable: process.execPath,
  dshBin: '/path/to/@deepseek-ai/dsh/lib/bin.js',
  gatewayEntry: '/path/to/apps/gateway/dist/server.js',
  dshHome: '/path/to/.dsh-rp',
  dshPort: 0,
  studioPort: 0,
  cwd: '/path/to/dsh-rp-studio',
}

const supervisor = createSupervisor(config)
// Equivalent: const supervisor = new Supervisor(config)

const { studioUrl, dshUrl, launchUrl } = await supervisor.start()
// Load studioUrl in BrowserWindow.loadURL(). Keep launchUrl in main memory.
await supervisor.stop()
```

The factory requires a complete `SupervisorConfig`; it does not infer runtime
paths or copy Desktop/runtime shell-building logic. Its public call shapes are:

```ts
createSupervisor(config: SupervisorConfig): Supervisor
new Supervisor(config: SupervisorConfig): Supervisor

supervisor.start(): Promise<StartResult>
supervisor.stop(): Promise<void>
supervisor.restart(): Promise<StartResult>
supervisor.status(): SupervisorStatus       // synchronous snapshot
supervisor.doctor(): Promise<DoctorResult>
supervisor.onStatus(listener): () => void   // synchronous subscribe; returns unsubscribe
```

`StartResult` is `{ studioUrl, dshUrl, launchUrl }`. `SupervisorStatus` is
`{ phase, studioUrl?, dshUrl?, processes, services, logs, lastError? }` where
`services.dsh` and `services.studio` are `ServiceStatus` snapshots. A status
listener is called on lifecycle changes, including an unexpected child exit;
Desktop should immediately block privileged IPC and navigation on any phase
other than `running`, before displaying diagnostics. Listener snapshots never
contain `launchUrl`, cookies, or tokens.

`start()` returns the clean Studio URL, the clean DSH Web base URL, and a
credential-bearing `launchUrl` for a main-process-only local login window.
`status()` is synchronous and includes phase (`stopped`, `starting`, `running`,
or `stopping`), clean URLs, owned PIDs, bounded redacted logs, and a safe last
error. `doctor()` asynchronously reports path existence, DSH version (when
available), and identity-checked service health. It never returns a token.
`restart()` serializes a stop followed by a start.

## Gateway/DSH contract

The supervisor starts one DSH Web host with `--profile web --host 127.0.0.1
--no-open`. The same host serves DSH Web APIs and Prompt Presets. Studio is
started with `DSH_BASE_URL`, `PROMPT_PRESETS_BASE_URL`, `DSH_WEB_TOKEN`, and
`PROMPT_PRESETS_WEB_TOKEN` in the Gateway child environment. The token is
generated and discovered from DSH stdout/stderr, retained only in supervisor
memory and the Gateway child's environment, and passed to neither status,
doctor, logs, thrown messages, nor preload.

Studio readiness requires `GET /api/v1/health` to return the versioned Gateway
envelope (`ok: true`, `protocolVersion: 1`, `data.upstream: "ready"`). DSH
readiness requires an HTTP response from the owned DSH launch URL whose body
identifies DeepSeek Harness/DSH. The launch token is cleared on stop and is
never written to disk or logs. An arbitrary HTTP 200 is not accepted.

## Electron security and lifecycle

Expose only non-secret methods/values through IPC: `start`, `stop`, `restart`,
`status`, and `doctor`, plus `studioUrl`/`dshUrl`. Do **not** expose
`launchUrl`, child environment variables, raw logs, or the supervisor instance
through `contextBridge`; if a local DSH login window is needed, call
`launchUrl` directly in the main process. Treat all returned paths and status
text as diagnostic data, not shell commands.

The DSH home has an exclusive `.dsh-rp-supervisor.lock`; a second instance gets
`SupervisorError` code `home-locked`. Fixed occupied ports fail with
`port-occupied`; port `0` asks the OS for a free loopback port. Spawn failures,
identity failures/timeouts, and unexpected child exits use stable error codes.
Stopping or a child exit cleans up only processes spawned by this instance (on
Windows via `taskkill /PID /T /F`, with hidden windows); unrelated PIDs are not
terminated. If either child exits while running, the sibling is stopped and the
public phase becomes `stopped`.

Always await `stop()` before app quit. Concurrent `start()` calls coalesce;
`stop()` and `restart()` are serialized. The supervisor binds loopback only and
does not provide LAN exposure, TLS, or user authorization.
