# DSH RP Studio Verification

Date: 2026-08-17 (Asia/Shanghai)

## Release Outcome

The local split is operational:

```text
React SPA http://127.0.0.1:4317
  -> RP Gateway /api/v1 + SSE
  -> DSH http://127.0.0.1:3080
```

The browser has no DSH RPC types or 3080 endpoint. Gateway card discovery returned `rp-runtime` and `zombie-world`. The existing zombie session resumed through the public projection, and a separate no-model smoke session exercised the installed deterministic control command.

## Automated Checks

`pnpm verify` passed from a clean command invocation:

- TypeScript: protocol, domain, Gateway, and Web all passed strict typecheck.
- Unit tests: 21 passed (`protocol` 2, `domain` 3, `gateway` 9, `web` 7).
- Production build: Gateway TypeScript and Vite SPA built successfully.
- Production launcher: `node --conditions=dsh-rp-production dist/server.js` served the built Gateway without the TypeScript development loader.
- Playwright: 5 passed in parallel.
- Viewports: 1440x960, 1024x768, 390x844, and 360x800 had no horizontal overflow.
- Accessibility: axe reported no serious or critical violations.
- E2E secret audit: JSON responses and DOM contained none of the mock canary, `secrets`, or `meta.rp`.

Runtime verification also passed:

- `node 05-delivery/tests/smoke.mjs`: `SMOKE ALL PASS`.
- `node 05-delivery/tests/rp-checkpoints.test.mjs`: `RP CHECKPOINTS PASS`.
- `node 05-delivery/tests/rp-controls.test.mjs`: `RP CONTROLS PASS`.
- `node 05-delivery/tests/preset-tools-smoke.mjs`: `PRESET-TOOLS SMOKE ALL PASS`.
- Installed `rp-runtime` mountcheck: PASS, 38 tools.
- Installed `zombie-world` mountcheck: PASS, 43 tools.

## Real DSH Checks

DSH was restarted with the installed runtime and returned:

- `host.describe`: version `0.0.1`.
- `agentPreset.list`: both RP presets available and not broken.
- `session.list`: existing RP session idle and resumable.
- Gateway session detail: HTTP 200, 2 visible transcript messages, 1 rollback checkpoint.
- Public payload scan: no `secrets`, `offscreen`, hidden-canonical ids, reasoning, tool results, or `meta.rp`.

`pnpm smoke:real` opened the production app without sending a prompt:

- document and body width exactly matched the 1440px viewport;
- all three rendered card images completed at 1200px natural width;
- no foreign-origin requests, including no browser request to port 3080;
- no failed requests or browser console errors;
- no forbidden state markers in the rendered page.

Deterministic command smoke:

- Created isolated session `session-4a141a48-5ef2-46df-b2f4-f24f41514498` with card `rp-runtime`.
- Sent only `PUT /api/v1/sessions/:id/autoplay` with `{ "off": true }`.
- Gateway returned `accepted: true`; final state was idle with autoplay disarmed.
- No model prompt was sent; transcript stayed empty; sensitive-field scan was clean.

Reconnect recovery checks:

- The Gateway reports recovery only after both DSH WebSocket channels are open.
- A recovered stream invalidates cached transcript history so the next public snapshot backfills outage events.
- Live events arriving during an initial history request are merged by durable sequence rather than overwritten.

## Recovery Points

- Pre-install runtime snapshot: `.snapshots/2026-08-17-runtime-pre-install`.
- Post-install runtime snapshot: `.snapshots/2026-08-17-runtime-post-install`.
- Both manifests contain SHA-256 hashes and omit all DSH session data.
- `scripts/install.ps1` creates another timestamped preset snapshot before future install verification.

## Platform Boundary

DSH remains append-only. Rollback does not physically erase backend audit events; the runtime restores canonical state and writes a surface replacement, and the Gateway folds that surface so rejected prose disappears from the Studio transcript. Hidden canonical state and raw audit data remain server-side.
