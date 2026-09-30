# DSH RP Studio Release Acceptance

Evidence date: 2026-09-30 (Asia/Shanghai). This document records fresh commands and does not treat compilation, mocks, metadata-only adapters, or owner assertions as release proof.

## Status

`DONE_WITH_CONCERNS`. The complete root verification pipeline is fresh-green: doctor, lint, typecheck, tests, build, integration (12/12), and E2E (11/11). Desktop package verification, isolated real-stack smoke, and normal packaged launch evidence are also fresh-green. Full release still has explicit limits and the `extract-zip` audit finding below.

## Acceptance Matrix

| Gate | Evidence | Status | Remaining concern |
| --- | --- | --- | --- |
| Node 24 executable gate | `node --version` reported `v24.15.0`; `node scripts/check-node-version.mjs` and root runtime tests passed | PASS | None observed |
| Normal workspace install | `corepack pnpm install --reporter append-only` exit 0; Electron build approvals explicit for electron/electron-winstaller/esbuild | PASS | Seven deprecated transitive packages remain as warnings |
| Real package-local Electron provision | Fresh doctor resolves Electron `39.8.10`, electron-builder `26.15.3`, esbuild `0.28.2`, TypeScript `5.9.2`, Vitest `4.1.11`, and Node types `24.13.3` | PASS | Full-audit residual is limited to Desktop's Electron `extract-zip` path |
| Root control daemon | Exact `vitest run tests/integration/start-stack.test.ts`: 2/2 passed, including persistent daemon PID reuse, authenticated status/doctor/backup, stop cleanup, and real child PID ownership over separate CLI processes | PASS | Requests are newline-framed; stream transports use `socket.end`, while Windows named pipes write the frame and let the daemon reply before close |
| Supervisor lifecycle | Exact package test: 20/20 passed; `createSupervisor(config)` exposes `start`, `stop`, `restart`, `status`, `doctor`, manual 303 cookie propagation, stale-lock reclamation, cancellation serialization, and owned process-tree cleanup | PASS | No Supervisor CLI/bin/backup export by design |
| Root verification pipeline | `pnpm verify` exit 0; doctor, lint, typecheck, tests, build, integration 12/12, and E2E 11/11 all passed | PASS | Serial scheduling remains required for host-sensitive real DSH homes and process cleanup |
| Root integration command | Fresh integration phase passed 12/12 tests, including real-host DSH release-card creation under serial file scheduling | PASS | Serial scheduling is required because real DSH homes and process cleanup are host-sensitive |
| Real Gateway/default local-data path | Fresh serial `pnpm test:integration`: product integration starts `startServer` without injected store/factory and reads `storage: ready`, schema 1, real `local-data.sqlite3` tables | PASS | No remaining concern in this evidence set |
| Authoritative SQLite and journal | Fresh root integration covers Gateway writes, real SQLite readback, append-only journal, and backup restore | PASS | No direct raw-session writes used |
| Sticker/knowledge/ledger semantics | Fresh root integration covers sticker and knowledge CRUD, append-only ledger plus compensating entry, backup stage/commit and readback | PASS | None observed |
| RP projections | Fresh root integration covers projection update, clear, rebuild, memory/relationship/location readback and private/secret/gm-only/offscreen canary | PASS | None observed |
| Gateway notifications/recovery | Fresh root integration covers projector notification and stale cursor reset snapshot after retention | PASS | None observed |
| HTTPS pairing/scopes/revocation | Fresh root integration covers real TLS listener, scoped token permissions, denied asset write, and revoked-token 401 | PASS | Certificate is test-only and not a distributable secret |
| Backup verification/restore | Fresh root integration covers same-home Gateway create, manifest hash, stage, commit, deletion and readback restore | PASS, NARROW | Cross-independent-home restore is not exposed by current public APIs: no import/register snapshot route; manual copying is not counted |
| Official DSH rc2 host | Fresh isolated DSH_HOME; official launcher and Gateway return ready health and read-only empty cards/session list | PASS, NARROW | No private cards or paid-model gameplay are installed in the disposable home |
| Desktop package gates | Current Desktop unit suites passed: desktop 54, supervisor 20, gateway 94, web 34, domain 11, local data 22, protocol 3; package typecheck/build and package verification passed | PASS, NARROW | Full paid-model gameplay is not covered |
| Packaged real-stack smoke | Packaged EXE with isolated home returned health `upstream=ready`, `cards=[]`, `sessions=[]`, and `modelRequests=0`; evidence: `audit/dsh-desktop-20260929/rp-studio-packaged-smoke.json` | PASS, NARROW | No paid model turn and no real private card are present in the isolated home |
| Packaged normal launch | Packaged EXE with isolated `DSH_HOME` and `user-data-dir` opened `DSH RP Studio` at `http://127.0.0.1:56503/`; empty cards were expected and the 1264x795 viewport had no horizontal overflow; screenshot: `test-results/visual/packaged-normal-launch.png` | PASS, NARROW | This evidence uses an isolated home and does not include a real private card |
| Package verification | `node apps/desktop/scripts/verify-package.mjs` passed | PASS | Artifacts remain unsigned |
| Portable artifact | `apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.exe` is 85,930,009 bytes with verified SHA-256 `23DE48B1512330E85B8843040220BCC314D2C9AC82CDA8FAD2D7F6C53CE9B126` | PASS | Artifact is unsigned; no independent Authenticode verification was performed |
| Zip artifact | `apps/desktop/artifacts/DSH RP Studio-1.0.0-x64.zip` is 133,487,491 bytes with verified SHA-256 `C4276601BD1286354736083A3B15CEF1CE840868EFE80340F735956768CFC6E3` | PASS | Artifact is unsigned; no independent Authenticode verification was performed |
| Web management/companion | Fresh Web E2E report: 11/11 passed; Web typecheck/build are included in the root gates | PASS | Mobile-device validation is not included |

## Security Audit Evidence

The root workspace override is the narrowest permitted root-only dependency mechanism because `apps/gateway/package.json` cannot be edited in this task. Exact selectors in `pnpm-workspace.yaml`:

- `fast-uri@3.1.5: 3.1.6`
- `fast-uri@4.1.2: 4.1.3`
- `fastify: 5.12.1` (same declared `^5.6.1` compatibility range)
- `app-builder-lib>@electron/get: 3.1.0` (same app-builder compatible major; provides the enum required by electron-builder 26.15.3)

The lockfile must be checked for `fast-uri@3.1.6`, `fast-uri@4.1.3`, and Fastify `5.12.1` after normal install.

The audit evidence remains bounded by the known Desktop dependency finding. The full audit retains exactly two high findings for Electron's `extract-zip` path; this finding is not suppressed or overstated as resolved.

```text
corepack pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org --json
corepack pnpm audit --prod --audit-level moderate --registry=https://registry.npmjs.org --json
corepack pnpm audit --audit-level moderate --registry=https://registry.npmjs.org --json
```

The known full-audit finding concerns `extract-zip@2.0.1` under Desktop's Electron dependency. It remains an accepted release concern pending an upstream/package-compatible resolution; no invalid override is retained and no audit finding is suppressed.

The current `pnpm verify` run completed with exit 0. It covered doctor, lint, typecheck, tests, build, integration 12/12, and E2E 11/11.

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
- The complete `pnpm verify` run is green: doctor, lint, typecheck, tests, build, integration 12/12, and E2E 11/11.
- Packaged EXE real-stack smoke and normal launch are fresh-green with empty isolated-home cards and sessions; no paid model turn or real private card was exercised.
- Cross-home snapshot restore lacks a public import/register/verify route. Current public stage/commit APIs locate a backup row/file in the same store; manual file copying is excluded.
- Mobile-device behavior has not been tested.
- No paid model turn has been tested; the isolated packaged smoke reports `modelRequests=0`.
- Portable and ZIP artifacts are unsigned; no independent Authenticode verification was performed.
- Full audit residuals must be resolved or explicitly accepted by release owners; no audit finding is suppressed here.

## Boundary Self-Review

This worker changed only `docs/release-acceptance.md` and `docs/desktop.md`; no source, tests, artifacts, lockfile, or private cards were edited. Real-host tests use isolated homes and user-data directories. No commit or push was performed.
