# DSH RP Studio Release Acceptance

Evidence date: 2026-09-09 (Asia/Shanghai). This document records fresh commands and does not treat compilation, mocks, metadata-only adapters, or owner assertions as release proof.

## Status

`DONE_WITH_CONCERNS`. Root runtime/install, authenticated cross-process Supervisor control, real Gateway/default local-data routing, SQLite/API persistence scenarios, public projection privacy canary, HTTPS pairing scopes/revocation, recovery cursor, real release-card discovery/session creation, Web E2E, and Desktop build/artifact/Diagnostics evidence are fresh-green. Full release still has explicit limits and development-dependency audit residue below.

## Acceptance Matrix

| Gate | Evidence | Status | Remaining concern |
| --- | --- | --- | --- |
| Node 24 executable gate | `node --version` reported `v24.15.0`; `node scripts/check-node-version.mjs` and root runtime tests passed | PASS | None observed |
| Normal workspace install | `corepack pnpm install --reporter append-only` exit 0; Electron build approvals explicit for electron/electron-winstaller/esbuild | PASS | Seven deprecated transitive packages remain as warnings |
| Real package-local Electron provision | Fresh doctor resolves Electron `39.8.10`, electron-builder `26.15.3`, esbuild `0.28.2`, TypeScript `5.9.2`, Vitest `4.1.11`, and Node types `24.13.3` | PASS | Full-audit residual is limited to Desktop's Electron `extract-zip` path |
| Root control daemon | Exact `vitest run tests/integration/start-stack.test.ts`: 2/2 passed, including persistent daemon PID reuse, authenticated status/doctor/backup, stop cleanup, and real child PID ownership over separate CLI processes | PASS | Requests are newline-framed; stream transports use `socket.end`, while Windows named pipes write the frame and let the daemon reply before close |
| Supervisor lifecycle | Exact package test: 20/20 passed; `createSupervisor(config)` exposes `start`, `stop`, `restart`, `status`, `doctor`, manual 303 cookie propagation, stale-lock reclamation, cancellation serialization, and owned process-tree cleanup | PASS | No Supervisor CLI/bin/backup export by design |
| Root integration command | `pnpm test:integration` now runs Vitest with `--no-file-parallelism`; fresh run passed 4 files and 12/12 tests, including real-host DSH release-card creation under serial file scheduling | PASS | Serial scheduling is required because real DSH homes and process cleanup are host-sensitive |
| Real Gateway/default local-data path | Fresh serial `pnpm test:integration`: product integration starts `startServer` without injected store/factory and reads `storage: ready`, schema 1, real `local-data.sqlite3` tables | PASS | No remaining concern in this evidence set |
| Authoritative SQLite and journal | Fresh root integration covers Gateway writes, real SQLite readback, append-only journal, and backup restore | PASS | No direct raw-session writes used |
| Sticker/knowledge/ledger semantics | Fresh root integration covers sticker and knowledge CRUD, append-only ledger plus compensating entry, backup stage/commit and readback | PASS | None observed |
| RP projections | Fresh root integration covers projection update, clear, rebuild, memory/relationship/location readback and private/secret/gm-only/offscreen canary | PASS | None observed |
| Gateway notifications/recovery | Fresh root integration covers projector notification and stale cursor reset snapshot after retention | PASS | None observed |
| HTTPS pairing/scopes/revocation | Fresh root integration covers real TLS listener, scoped token permissions, denied asset write, and revoked-token 401 | PASS | Certificate is test-only and not a distributable secret |
| Backup verification/restore | Fresh root integration covers same-home Gateway create, manifest hash, stage, commit, deletion and readback restore | PASS, NARROW | Cross-independent-home restore is not exposed by current public APIs: no import/register snapshot route; manual copying is not counted |
| Real release cards | Temporary DSH_HOME copies release presets; real sibling DSH + Gateway discovers `zombie-world` and `hp-potion-master`, creates each session and reads prompt methods | PASS, NARROW | Proves discovery/session creation only, not actual HP/Zombie LLM gameplay |
| Desktop package gates | Fresh Desktop `npm test` passed 48 tests; `npm run typecheck`, `npm run build`, `npm run smoke`, `npm run portable`, and `npm run package` all exited 0 | PASS, NARROW | Full Desktop startup chain is not directly proven by the Diagnostics smoke |
| Electron Diagnostics smoke | Fresh Electron39 `npm run smoke` exit 0: bundled preload, real Electron, bridge, IPC ready, health 200, sandbox true; `desktop-smoke.png` is 33,382 bytes with verified SHA-256 `4A981C9B8191C35BAFBF4ECFF72F5FCEDB463ED9F57919CB52F05DE7C2629641` | PASS, NARROW | Does not prove Desktop -> Supervisor -> DSH -> Gateway -> Studio |
| Portable artifact | Fresh Electron39 portable/package rerun exited 0; `apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.exe` is 85,541,737 bytes with verified SHA-256 `37F76FCA4E4BEDEBCB227A46532722D7CD64CDA8471EE8B9C3B802190D6DEA62` | PASS | Artifact is unsigned; no independent Authenticode verification was performed |
| Zip artifact | Fresh package rerun exited 0; `apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.zip` is 132,623,655 bytes with verified SHA-256 `C7E631FB9B2EC946225E108D16179BAE3613A7429F8CB7E2B15E4FCB7083DB72` | PASS | Artifact is unsigned; no independent Authenticode verification was performed |
| Web management/companion | Fresh Web E2E report: 11/11 passed; Web typecheck/build are included in the root gates | PASS | Mobile-device validation is not included |

## Security Audit Evidence

The root workspace override is the narrowest permitted root-only dependency mechanism because `apps/gateway/package.json` cannot be edited in this task. Exact selectors in `pnpm-workspace.yaml`:

- `fast-uri@3.1.5: 3.1.6`
- `fast-uri@4.1.2: 4.1.3`
- `fastify: 5.12.1` (same declared `^5.6.1` compatibility range)
- `app-builder-lib>@electron/get: 3.1.0` (same app-builder compatible major; provides the enum required by electron-builder 26.15.3)

The lockfile must be checked for `fast-uri@3.1.6`, `fast-uri@4.1.3`, and Fastify `5.12.1` after normal install.

Fresh audit commands run on 2026-09-09:

```text
corepack pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org --json
corepack pnpm audit --prod --audit-level moderate --registry=https://registry.npmjs.org --json
corepack pnpm audit --audit-level moderate --registry=https://registry.npmjs.org --json
```

The fresh production high and moderate audits both returned exit 0 with zero vulnerabilities, confirming the Fastify `5.12.1`, `fast-uri`, and effective `ansi-regex@5.0.1` resolution in the installed lockfile. The current full audit has exactly 2 high findings, both for `extract-zip@2.0.1` under Desktop's Electron dependency. The npm registry publishes versions only through `2.0.1`; `pnpm view extract-zip@2.0.2 version --registry=https://registry.npmjs.org` returned `ERR_PNPM_PACKAGE_NOT_FOUND`. A root override to `2.0.2` was also rejected by pnpm install, so no invalid override was retained. This remains unresolved Desktop dependency risk and is not suppressed.

The latest `pnpm verify` run reached `pnpm check` but stopped at the Web typecheck stage with `apps/web/vite.config.ts(17,3)` reporting that `test` is not accepted by the current Vite `UserConfigExport` type. It did not reach the verify command's integration or E2E phases. The Web source is outside this task boundary; this document therefore does not claim a fresh full-verify pass.

## Required Final Commands

```text
node --version
corepack pnpm install --reporter append-only
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm verify
corepack pnpm test:integration
corepack pnpm desktop:smoke
corepack pnpm desktop:portable
corepack pnpm desktop:package
corepack pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org --json
corepack pnpm audit --prod --audit-level moderate --registry=https://registry.npmjs.org --json
corepack pnpm audit --audit-level moderate --registry=https://registry.npmjs.org --json
```

## Known Unmet Gates and Owner Gaps

- Root Supervisor and package lifecycle gates are fresh-green: 20/20 Supervisor tests, 2/2 start-stack tests, and 12/12 root integration tests.
- The fresh serial root integration run is green at 12/12; the latest full `pnpm verify` is blocked before integration by the Web Vite typecheck error `apps/web/vite.config.ts(17,3)` recorded above.
- Desktop smoke and artifacts are fresh-green, but remain Diagnostics/artifact evidence only; they do not prove the full Desktop -> Supervisor -> DSH -> Gateway -> Studio runtime chain.
- Cross-home snapshot restore lacks a public import/register/verify route. Current public stage/commit APIs locate a backup row/file in the same store; manual file copying is excluded.
- Mobile-device behavior has not been tested.
- Real-model gameplay has not been tested; release-card evidence covers discovery and session creation only.
- Portable and ZIP artifacts are unsigned; no independent Authenticode verification was performed.
- Full audit residuals must be resolved or explicitly accepted by release owners; no audit finding is suppressed here.

## Boundary Self-Review

Root edits are limited to the approved `packages/supervisor/**`, `scripts/start-stack.mjs`, root tests/scripts, and `docs/release-acceptance.md`; no Gateway/Web/Desktop/LocalData source was edited. Real-host tests use temporary DSH_HOME/HOME/userData-like paths, detach the profile node_modules junction before deleting the exact temporary home, restore environment tokens in finally, and never copy the temporary home into Desktop artifacts. No commit or push was performed.
