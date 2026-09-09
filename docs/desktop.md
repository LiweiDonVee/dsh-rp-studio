# Desktop shell

`apps/desktop` is the Windows Electron shell for DSH RP Studio. It owns the window, tray, trusted native dialogs, local settings, and the adapter around `@dsh-rp/supervisor`. It does not implement a second process supervisor or a remote updater.

## Security model

- Every `BrowserWindow` uses `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- Studio navigation is allowed only after Supervisor starts successfully and returns `http://127.0.0.1:<port>`. Navigation and redirects must stay on that exact origin. The only allowed `file:` URL is the exact bundled settings/diagnostics page.
- New windows, permission requests, downloads, external protocols, `shell.openExternal`, arbitrary shell execution, and renderer file access are unavailable.
- Preload exposes a frozen set of named operations over one IPC channel. It validates both requests and responses. Main validates the request again, then checks the owning `webContents`, top-level frame, page origin, and per-page capability before dispatch.
- The local page alone may view diagnostics and edit runtime configuration. It receives opaque selection IDs and basenames, never absolute paths. The Studio page alone may request session-scoped asset import, backup selection, and public notifications.
- Asset content is read in main only after a native picker, with a bounded read capped at 10 MiB, and uploaded to the Gateway asset endpoint. The renderer receives only an asset ID or a bounded diagnostic. Backup export creates a Gateway backup, downloads bytes through `GET /api/v1/product/backups/:backupId/export`, and writes a `.dsh-rp-backup` file into the native-selected directory. Backup import accepts only a native-selected `.dsh-rp-backup` file, performs a bounded read capped at 32 MiB, and posts bytes to `POST /api/v1/product/backups/import`; it returns the staged backup ID and never commits restore automatically.
- Supervisor `launchUrl`, tokens, child environments, paths, raw logs, databases, and error messages are never exposed. Renderer-visible status is restricted to phase, owned PIDs, clean Studio URL, and a stable error code. Notifications are mapped from a fixed public event allowlist.

The app holds a single-instance lock and uses a tray. Closing the window hides it while the tray is active. Quit awaits `Supervisor.stop()` exactly once and stops the notification stream first, allowing Supervisor to close its owned process trees. No code downloads or automatic remote updates exist.

## Runtime configuration and Node 24

Electron's embedded Node must never own DSH/Gateway `node:sqlite`. DSH and Gateway always run through the independently configured `nodeExecutable`. The doctor executes the selected binary with `--version`, rejects Electron itself, and reports missing, failed, or non-Node-24 runtimes.

The bundled settings page selects these values with native dialogs:

- independent Node 24 executable;
- DSH entry script;
- prebuilt Gateway entry (`apps/gateway/dist/server.js` in a checkout);
- DSH home directory;
- runtime root and optional DSH/Studio loopback ports.

Settings are schema-validated and atomically persisted beneath Electron `userData`. Windows `safeStorage` encrypts them when available; the fallback is explicit validated local JSON containing paths but no token or database content. The renderer sees only opaque one-use selection IDs and file/directory labels. Environment defaults are supported through `DSH_NODE_EXECUTABLE`, `DSH_BIN`, `DSH_GATEWAY_ENTRY`, `DSH_HOME`, and `DSH_STUDIO_ROOT`.

At normal boot, the shell constructs Supervisor and attempts startup without user clicks. Supervisor owns hidden Windows child startup, token discovery, identity health checks, loopback URL selection, locks, process ownership, and process-tree teardown. On failure the shell remains on the bundled diagnostics page; it does not render the thrown error or any private path.

## Supervisor contract and integration status

The adapter consumes the actual package only through:

```text
new Supervisor(config)
start() -> { studioUrl, dshUrl, launchUrl }
status()
doctor()
stop()
```

Only `studioUrl` crosses the adapter from `start`; credential-bearing `launchUrl` stays in main/Supervisor memory. Status and doctor responses are projected to strict public schemas.

Integration status on 2026-09-08: `packages/supervisor` is present and exports `Supervisor`. Desktop first resolves `@dsh-rp/supervisor`, then the repository `dist/index.js` build when workspace linking is unavailable. If neither is present, the same local contract compiles and the diagnostics page reports `supervisor-unavailable`; the desktop never substitutes its own spawn/kill logic.

Security toolchain status on 2026-09-08: Desktop uses Electron `39.8.10` (upgraded from `38.8.6`) and Vitest `4.1.11`; the Electron 39 API, unit tests, smoke test, and electron-builder packaging all completed successfully. Workspace overrides pin vulnerable transitive `ini` to `1.3.6`, `semver<6` to `5.7.2`, `ejs<3.1.10` to `3.1.10`, and `ansi-regex<5.0.1` to `5.0.1`.

## Commands and artifacts

Run from `apps/desktop`:

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
npm run package
```

The package independently declares its build, test, typecheck, smoke, portable, and packaging scripts. Build bundles main and sandbox preload code, and copies the local renderer, writing only under `apps/desktop/dist`. Packaging uses the package-local Electron distribution and writes only beneath `apps/desktop/artifacts`.

No signing certificate is needed or purchased. `forceCodeSigning` is false and Windows executable signing/resource editing is explicitly disabled. Successful x64 outputs are expected at:

```text
apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.exe
apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.zip
```

## Verification results and real limitations

TDD covers URL/origin policy, page capabilities, request and response schemas, preload validation, settings encryption and opaque paths, Node-runtime validation, bounded main-process Gateway reads, backup-extension filtering, fake-Supervisor start/status/doctor/stop projection, graceful one-time shutdown, and public notification filtering. RED runs were observed for the new bounded-read/filter/schema/tray assertions before their implementations; the final suite includes those regression checks.

Fresh results on 2026-09-08:

- `npm run typecheck`: passed (exit 0).
- `npm test`: passed (exit 0) — 17 files, 48 tests.
- `npm run build`: passed (exit 0); emitted `dist/main/main.js` (40.8 KiB) and `dist/preload/preload.cjs` (126.6 KiB), and copied renderer/assets.
- `npm run smoke`: passed (exit 0) using Electron 39.8.10 with temporary profile and dynamic loopback fixture. Validated result: `{"title":"DSH RP Studio Diagnostics","status":"Studio status: stopped","bridge":true,"ipcReady":true,"healthStatus":200,"sandboxed":true}`. Retained screenshot: `apps/desktop/artifacts/desktop-smoke.png` (33,382 bytes). The temporary profile was removed by the smoke test.
- `pnpm --filter @dsh-rp/desktop portable`: passed after one transient `EBUSY` retry while replacing the prior unpacked executable; Electron-builder used Electron 39.8.10.
- `pnpm --filter @dsh-rp/desktop package`: passed after the portable cache was repopulated. It produced `apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.exe` (85,541,738 bytes) and `apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.zip` (132,623,655 bytes). Electron-builder used Electron 39.8.10 and reported the default Electron icon because no application icon is configured. No independent Authenticode verification was performed. The tray icon is a separate bundled runtime asset at `dist/assets/tray-icon.svg`.

Current artifact SHA-256: EXE `0565C59B70684BCF7F27391C2A650376C60453375B1EB2C257DF546A57DF7BED` (85,541,738 bytes); ZIP `5967BD5C4143E615966372890B44348776706A15E809A9D252B3A591D6A0C6B2` (132,623,655 bytes).

The retained artifacts are generated outputs under `apps/desktop/artifacts`. `pnpm audit --registry=https://registry.npmjs.org` exits 1 with exactly two remaining high findings: both concern Electron 39.8.10's `extract-zip@2.0.1`; the requested patched `extract-zip@2.0.2` is not published (registry query returns 404), and Electron's package contract still requests `^2.0.1`. No incompatible or fabricated override was added. The smoke test treats a missing renderer bridge, failed loopback health check, non-sandboxed renderer, missing screenshot, timeout, or non-zero Electron exit as a hard failure.
