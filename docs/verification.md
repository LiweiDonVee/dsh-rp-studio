# DSH RP Studio Verification

Date: 2026-08-17 (Asia/Shanghai)

## Release Outcome

```text
React SPA http://127.0.0.1:4317
  -> RP Gateway /api/v1 + SSE
  -> DSH http://127.0.0.1:3080
```

The latest production build is deployed. Both processes listen only on `127.0.0.1`; Studio runs as `node --conditions=dsh-rp-production dist/server.js` and reports DSH `0.0.1` ready.

## Automated Checks

`pnpm verify` covers:

- Oxlint with `--deny-warnings` over application, package, script, and test sources.
- Strict TypeScript checks for protocol, domain, Gateway, and Web.
- 39 unit/component tests: protocol 2, domain 4, Gateway 20, Web 13.
- Production builds for both TypeScript packages, Gateway, and Vite SPA.
- 6 Playwright tests covering create, resume, send/stream, cancel, two rollbacks, fork, autoplay arm/disarm, card switching, mobile sheets, four target viewports, secret scanning, and accessibility.
- Axe with no serious or critical findings and no horizontal overflow at 1440x960, 1024x768, 390x844, or 360x800.

`scripts/install.ps1 -SkipSnapshot` passed the frozen install and complete `pnpm check` path. `pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org` reported no known vulnerabilities.

## Runtime Checks

- `node 05-delivery/tests/smoke.mjs`: `SMOKE ALL PASS`, including 19 RP tools, seven prompt sections, projection replay, rollback surface replacement, world lookup, and status projection.
- `node 05-delivery/tests/rp-checkpoints.test.mjs`: `RP CHECKPOINTS PASS`.
- `node 05-delivery/tests/rp-controls.test.mjs`: `RP CONTROLS PASS`.
- `node 05-delivery/tests/preset-tools-smoke.mjs`: `PRESET-TOOLS SMOKE ALL PASS`.
- Installed `rp-runtime` mountcheck: PASS, 38 tools.
- Installed `zombie-world` mountcheck: PASS, 43 tools.
- Runtime residue scan: zero raw patch/update gameplay APIs; the renderer's intentional `{{char}}`/`{{user}}` macros remain.

## Real DSH Smoke

`pnpm smoke:real` made only read requests and sent no model prompt:

- `/health`, `/cards`, `/sessions`, and one session detail returned valid protocol-version-1 envelopes;
- both `rp-runtime` and `zombie-world` were available;
- two RP sessions were visible and the selected detail matched its list/card identity;
- public JSON and DOM contained no secret/offscreen fields, reasoning, tool results, or `meta.rp`;
- all three rendered cover instances loaded at 1200px natural width;
- document and body width exactly matched the 1440px viewport;
- there were no foreign-origin requests, write requests, failed requests, or console errors.

## Recovery Points

- `.snapshots/2026-08-17-runtime-pre-install`
- `.snapshots/2026-08-17-runtime-post-install`
- Final Git release commit on `feat/rp-studio`

Snapshot manifests contain SHA-256 hashes and omit all DSH session data. Future installer snapshots include `preset.yml`, `agent.cordis.yml`, `rp-card.json`, and both runtime plugins. No command in this acceptance edited `C:\Users\Owner\.dsh\sessions`.

## Platform Boundary

DSH remains append-only. Rollback restores canonical state and replaces the derived surface; raw backend audit events are retained by design. Live 20-30-turn model play was not run because this release's real-system acceptance is deliberately prompt-free; deterministic runtime and browser tests cover the changed mechanics.
