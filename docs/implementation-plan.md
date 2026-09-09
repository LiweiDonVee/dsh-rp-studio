# DSH RP Studio Root Integration and Release Implementation Plan

> **For agentic workers:** Execute this plan inline in the shared live workspace. Do not dispatch subagents, commit, push, or modify files outside the approved root integration write set. Track every unchecked item with dated command evidence in `docs/release-acceptance.md`.

**Goal:** Integrate the independently owned Supervisor, Desktop, Gateway, local-data, and Web work into one repeatable Node 24/pnpm release pipeline whose acceptance evidence exercises real persistence, routing, Electron IPC, and snapshot restore behavior.

**Architecture:** The root is an orchestrator, not a second implementation layer. Root scripts validate the runtime, delegate lifecycle to the actual Supervisor API/CLI, aggregate package-local build/test/typecheck commands, run black-box integration tests against temporary homes, and record honest release gates. Authoritative product writes flow through the versioned Gateway API and atomically commit both their append-only journal event and authoritative SQLite table mutation; RP projections are rebuilt from public session events. Tests never write raw sessions directly.

**Tech stack:** Node.js 24, Corepack, pnpm workspaces, TypeScript, Vitest, Fastify Gateway routes, SQLite local-data store, Electron/electron-builder/esbuild, Playwright, and PowerShell installation helpers.

---

## Approved scope and ADRs

1. **Root orchestration ADR:** Keep the existing `apps/*` and `packages/*` workspace globs. Root commands are strict, repeatable aggregators and must never exclude tests, swallow failures, or weaken package checks. Package-local scripts own implementation details.
2. **Runtime ADR:** Node.js major version 24 is required. An executable version check runs before installation diagnostics and as part of `doctor` and `verify`. Corepack supplies the pinned pnpm version from `packageManager`.
3. **Supervisor ADR:** Supervisor owns single-instance enforcement, child process lifecycle, persisted owned-process state, safe status probing, and stop semantics. `scripts/start-stack.mjs` consumes the actual Supervisor API/CLI (`start`, `stop`, `status`, `doctor`, and `backup`) and must not spawn or track an independent service tree.
4. **Desktop ADR:** Electron owns the application window, tray, and public notifications. IPC is minimal and limited to native file/directory selection, with sender, frame, and origin validation. Desktop commands launch the real Electron CLI, never `tsx` for main; build compiles main, bundles preload to `dist/preload/preload.cjs`, and copies renderer assets. Smoke uses the real Electron binary with an ephemeral port and temporary `userData` and `HOME`. No static Electron type shim is acceptable.
5. **Persistence ADR:** SQLite contains both authoritative application tables and derived RP projection tables. Every authoritative table mutation and its append-only user journal event commit in the same SQLite transaction. No product path or test may direct-write raw sessions; tests write through the intended API/journal boundary and read back through SQLite and Gateway.
6. **Product semantics ADR:** Sticker packs and user knowledge use real product CRUD as authorized by the approved API. Ledger is append-only and corrections are compensating entries that reference the reversed entry; it has no arbitrary update/delete. Memory, relationships, emotions, and fictional locations are RP projections, so acceptance verifies projection create/update/clear/rebuild behavior rather than inventing product-user CRUD APIs for mechanical facts.
7. **Gateway ADR:** The versioned Gateway API provides HTTPS pairing, scopes, revocation, recovery cursor/rebase behavior, and notification projection. Default initialization uses the real local-data store and projector wiring rather than a metadata-only adapter.
8. **Backup ADR:** Backup is accepted only after archive/snapshot verification and restoration into an isolated temporary home, followed by data readback from the restored SQLite/Gateway state.
9. **Client ADR:** Deliver the Web management UI and Web companion. Mobile scope is Web companion and pairing-protocol readiness only; there is no React Native release in this scope.
10. **Scenario ADR:** Acceptance covers two playable cards, authorized product CRUD, append-only ledger compensation, RP projection rebuild semantics, a public notification, recovery cursor/rebase, and pairing scope enforcement plus revocation.
11. **Release ADR:** Release status is evidence-gated. Compilation, mocks, or adapter counts cannot substitute for the four mandatory exercises: real SQLite write/readback, real Gateway routing, real Electron preload/IPC, and snapshot backup restore.

## Workspace baseline and implementation task matrix

Baseline recorded 2026-09-08 before root implementation. The repository already contains historical and parallel-owner dirty changes; all are preserved. Root `package.json` has recursive build/test/typecheck plus lint/check/verify, but has no Node 24 executable gate, no `doctor`, no `test:integration`, and no Desktop release aggregation. `pnpm-workspace.yaml` contains the required globs but Electron build approval is unresolved. `scripts/start-stack.mjs` currently implements its own `child_process.spawn` lifecycle and therefore violates the Supervisor ADR. The release acceptance document and integration test directory do not yet exist.

| Area | Live owner | Baseline observed | Root integration action | Acceptance evidence |
| --- | --- | --- | --- | --- |
| Root runtime/install | Root integration | `packageManager` pins pnpm 11.9.0; Node 24 is not enforced by a script | Add executable Node-major check, `engines`, strict `doctor`, and lock/install verification | Node check exit 0; Corepack/pnpm install exit 0 |
| Root command pipeline | Root integration | Recursive build/test/typecheck exist; lint covers root paths; no integration target | Make build, test, typecheck, lint, doctor, verify, and `test:integration` explicit and fail-fast | Every exact root command and exit code recorded |
| Supervisor lifecycle | Supervisor owner + root wiring | Package exists; actual exports/CLI must be inspected after owner changes settle | Replace root child-process model with actual Supervisor API/CLI delegation only | Single-instance start/status/stop plus owned state test; doctor/backup command evidence |
| Desktop | Desktop owner + root aggregation | Package declares Electron toolchain; current build/smoke/package scripts must be validated | Ensure lock resolves real Electron/electron-builder/esbuild/TypeScript/Vitest/types/zod and aggregate exposed commands | Build output, real Electron preload/IPC smoke, package, portable artifact evidence |
| Gateway | Gateway owner | Versioned/product/pairing work is live; known metadata-only default adapter remains a blocker until rechecked | Use real routes in integration tests; do not patch Gateway from root | Route-level CRUD/readback, scopes, revocation, notification, cursor/rebase evidence |
| local-data | local-data owner | Package exists and is changing live | Exercise its actual journal/projector/SQLite API through Gateway; never direct-write sessions | SQLite contains API-written products and restored backup data |
| Web | Web owner | Management/companion work is live; pagination and compensation controls are known gaps | Build/test/typecheck through workspace pipeline; record feature evidence from owner tests/UI | Web package tests and build; pagination/compensation blocker recheck |
| Product data | Domain/Gateway/local-data owners | Product protocol files and routes are changing live | Cover sticker packs/knowledge CRUD, append-only ledger compensation, and RP projection create/update/clear/rebuild for memory, relationships, emotion, and fictional location | API responses, journal rows, and SQLite authoritative/projection readback prove correct semantics |
| Release evidence | Root integration | No release acceptance document | Maintain dated matrix with exact commands, key output, unmet items, and owner/API gaps | Four mandatory real-system gates independently marked |

## Execution tasks

### Task 1: Freeze the approved integration contract

**Files:**

- Create: `docs/implementation-plan.md`
- Create and update: `docs/release-acceptance.md`

- [x] Record the full approved scope, ADRs, dirty-workspace baseline, ownership boundaries, task matrix, and acceptance checklist before any other source edit.
- [ ] Create the release acceptance matrix and record dated evidence without converting known gaps into passing claims.

### Task 2: Establish the strict root runtime and workspace pipeline

**Files:**

- Modify: `package.json`
- Modify if required: `pnpm-workspace.yaml`
- Modify if required: `.gitignore`
- Modify if required: root `tsconfig*.json`
- Create: `scripts/check-node-version.mjs`
- Create or modify: root-owned diagnostics under `scripts/**`
- Mechanically update: `pnpm-lock.yaml`

- [ ] Add `engines.node` for Node 24 and an executable version check that rejects every other major version with a clear message.
- [ ] Add strict `doctor` and `test:integration` commands and include both runtime validation and integration tests in `verify`.
- [ ] Preserve recursive package-local build/test/typecheck execution and root lint coverage without ignores or failure suppression.
- [ ] Configure pnpm build approval so declared Electron and esbuild installations are usable without permitting unrelated lifecycle scripts.
- [ ] Run Corepack/pnpm install and confirm all declared Desktop tool binaries resolve from a normal workspace install and lockfile.

### Task 3: Integrate the actual Supervisor command surface

**Files:**

- Modify: `scripts/start-stack.mjs`
- Create or modify: `tests/integration/supervisor*.test.*`

- [ ] Inspect `packages/supervisor` exports, package scripts, and CLI entry points immediately before coding.
- [ ] Write a failing root integration/unit test that proves `start-stack` delegates to Supervisor and contains no independent `child_process` lifecycle.
- [ ] Replace the current root process model with thin delegation to the actual Supervisor API/CLI only when the export is present.
- [ ] Exercise `start`, `status`, `doctor`, `backup`, and `stop` in an isolated temporary `DSH_HOME` and `HOME`.
- [ ] Prove single-instance behavior, owned process-state persistence, and safe stop semantics.
- [ ] Recheck redirect probing with cookies; retain it as an explicit owner gap if fresh evidence does not prove cookie continuity.

### Task 4: Exercise genuine product integration

**Files:**

- Create or modify: `tests/integration/**/*.test.*`
- Create or modify: `tests/integration/**` fixtures and helpers

- [ ] Allocate only temporary `DSH_HOME`, `HOME`, Electron `userData`, ports, journals, SQLite databases, and backup destinations; assert no real-user path is selected.
- [ ] Start the real Gateway routes with the real default local-data initialization; use a deterministic DSH stub or temporary real DSH process only at the DSH protocol boundary.
- [ ] Write through the versioned Gateway API/journal path and read back the actual records through Gateway and real SQLite.
- [ ] Exercise two independently playable cards.
- [ ] Exercise authorized CRUD for sticker packs and user knowledge.
- [ ] Exercise append-only ledger creation and correction through a compensating entry; never update or delete ledger facts.
- [ ] Exercise projection create/update/clear/rebuild semantics for memory, relationships, emotions, and fictional locations from public RP events/rebase input.
- [ ] Prove every authoritative application table mutation and corresponding journal append committed atomically in one transaction.
- [ ] Exercise projector-driven public notification delivery.
- [ ] Exercise recovery cursor and rebase/compensation behavior.
- [ ] Exercise HTTPS pairing protocol readiness, scope denial/allowance, and token revocation.
- [ ] Reject metadata-only adapter evidence as a passing persistence result.

### Task 5: Verify backup and snapshot restoration

**Files:**

- Create or modify: `tests/integration/backup*.test.*`

- [ ] Seed data through Gateway/API journal writes in a temporary home.
- [ ] Invoke actual Supervisor/local-data backup behavior and verify the produced snapshot/archive.
- [ ] Restore into a separate temporary home without modifying the source home.
- [ ] Start/read the restored SQLite/Gateway state and assert the seeded values, cards, journal continuity, and recovery cursor.

### Task 6: Aggregate and validate Desktop release commands

**Files:**

- Modify: `package.json`
- Update: `docs/release-acceptance.md`

- [ ] Confirm Desktop resolves real `electron`, `electron-builder`, `esbuild`, `typescript`, `vitest`, `@types/node`, and `zod` from the workspace install/lock.
- [ ] Confirm root commands call package-local Desktop scripts and the Desktop main process launches through Electron CLI, never `tsx`.
- [ ] Run the exposed Desktop build and confirm compiled main, bundled `dist/preload/preload.cjs`, and copied renderer assets.
- [ ] Run the exposed real-Electron smoke with ephemeral port plus temporary `userData` and `HOME`; require a renderer/preload IPC assertion.
- [ ] Run Desktop package and portable commands when exposed and record artifacts or exact failures.
- [ ] Recheck native file/directory selection and secure sender/frame/origin validation; retain the known Unsupported/shim/unbundled-preload observations as blockers until fresh smoke evidence supersedes them.

### Task 7: Full verification, acceptance accounting, and boundary audit

**Files:**

- Update: `docs/implementation-plan.md`
- Update: `docs/release-acceptance.md`

- [ ] Run and record the Node check and Corepack/pnpm install.
- [ ] Run and record root `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm verify`, and `pnpm test:integration` with exit codes and key output.
- [ ] Run and record Desktop smoke/package/portable commands if present.
- [ ] Re-read live owner files and rerun affected commands after concurrent changes settle when useful.
- [ ] Perform a read-only `git status` and diff boundary audit; preserve historical/owner work and revert only accidental root-agent out-of-scope edits.
- [ ] Report every changed file, transient owner failure, exact expected-versus-actual API gap, remaining limit, and self-review; do not commit or push.

## Release acceptance checklist

### Supervisor and Desktop

- [ ] Supervisor enforces a single instance.
- [ ] Supervisor persists only owned process state and `stop` terminates only its owned daemon/services.
- [ ] Supervisor `start`, `stop`, `status`, `doctor`, and `backup` are available through the actual package API/CLI and root delegation.
- [ ] DSH redirect probing carries required cookies across redirects.
- [ ] Electron provides the application window, tray, and public notifications.
- [ ] Electron IPC is limited to native file/directory selection and validates sender, frame, and origin.
- [ ] Electron main is launched with the real Electron CLI; no `tsx` main launch and no static Electron type shim.
- [ ] Desktop build emits main code, bundled `dist/preload/preload.cjs`, and renderer assets.
- [ ] Real Electron smoke proves renderer/preload IPC with ephemeral port and temporary `userData`/`HOME`.
- [ ] Portable/package artifacts are produced by Desktop-owned commands.

### Persistence, assets, and Gateway

- [ ] Real Gateway/API writes append to the user raw-data journal without direct raw-session writes.
- [ ] Real SQLite authoritative-table and projection readback proves persisted user content and rebuilt RP state.
- [ ] Authoritative SQLite table mutation and append-only journal append are proven atomic.
- [ ] Sticker pack CRUD is exercised with content readback.
- [ ] Ledger append and compensating-entry semantics are exercised with content readback; arbitrary update/delete is absent.
- [ ] Knowledge CRUD is exercised with content readback.
- [ ] Memory projection create/update/clear/rebuild is exercised with readback.
- [ ] Relationship projection create/update/clear/rebuild is exercised with readback.
- [ ] Emotion projection create/update/clear/rebuild is exercised with readback.
- [ ] Fictional location projection create/update/clear/rebuild is exercised with readback.
- [ ] Versioned Gateway routing is exercised against the real store default initialization.
- [ ] HTTPS pairing readiness is exercised.
- [ ] Pairing scopes allow intended operations and deny operations outside scope.
- [ ] Revoked credentials are rejected.
- [ ] Recovery cursor and rebase/compensation behavior are exercised.
- [ ] Projector wiring produces a public notification from a committed change.

### Backup, clients, scenarios, and evidence

- [ ] Backup output is verified before restore.
- [ ] Snapshot restore into a separate temporary home yields real SQLite/Gateway readback.
- [ ] Web management UI build/tests pass and expose required real management operations.
- [ ] Web companion build/tests pass; mobile claim is limited to Web companion/pairing protocol readiness.
- [ ] No React Native release is claimed or required.
- [ ] Two playable cards are exercised end-to-end.
- [ ] Authorized new-product CRUD, ledger compensation, projection rebuild, notification, rebase, and scopes are each exercised.
- [ ] Mandatory gate 1: real SQLite write/readback is evidenced.
- [ ] Mandatory gate 2: real Gateway routing is evidenced.
- [ ] Mandatory gate 3: real Electron preload/IPC is evidenced.
- [ ] Mandatory gate 4: snapshot backup restore is evidenced.
- [ ] Release acceptance lists exact dated commands, exit codes, key output, unmet items, and owner/API gaps.

## Known blockers requiring fresh proof

- Supervisor `probeDsh` redirect following was reported not to carry cookies. This remains blocked until a current test proves cookie continuity.
- Electron asset selection was reported as Unsupported, with a type shim and unbundled preload. These remain blocked until current source inspection plus real Electron smoke prove native selection, real Electron types, and bundled preload behavior.
- Gateway was reported to use a metadata-only adapter. Persistence and notification acceptance remain blocked until current default initialization and a real SQLite/API/projector test prove otherwise.
- Web management was reported to lack pagination and compensation buttons. Web acceptance remains blocked until current UI tests or direct inspection prove both controls.

## Plan self-review

- Scope coverage: every requested lifecycle, Desktop security/build, atomic journal/authoritative persistence, append-only ledger, RP projection, Gateway pairing/recovery, backup, Web/mobile boundary, playable-card, and release-evidence requirement maps to a task and acceptance checkbox.
- Ownership boundary: root work only wires and tests package behavior; no task authorizes edits under `apps/**` or `packages/**`.
- Data safety: all integration writes are constrained to temporary `DSH_HOME`, `HOME`, `userData`, journal, SQLite, and backup paths, and raw sessions are never direct-written.
- Evidence integrity: no gate can pass from compilation, mocks, metadata counts, or owner assertions alone.
