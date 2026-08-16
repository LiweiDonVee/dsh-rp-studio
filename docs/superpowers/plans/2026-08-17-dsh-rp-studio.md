# DSH RP Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-grade local RP frontend and versioned, player-safe Gateway over DSH, including deterministic snapshot rollback.

**Architecture:** A pnpm workspace contains a Fastify Gateway, a React/Vite web app, and shared protocol/domain packages. The Gateway is the only DSH client, folds raw event surfaces, redacts canonical state, serves SSE, and hosts the built SPA. Existing RP presets gain deterministic control commands that execute synthetic DSH tool turns and retain checkpoint lineage in `rp-state`.

**Tech Stack:** Node 24, TypeScript, pnpm, Fastify, ws, Zod, React 18, Vite, Zustand, Lucide React, dsh-tavern-renderer core, Vitest, Testing Library, Playwright, axe-core.

---

## File Map

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`: workspace commands and shared compiler policy.
- `packages/protocol/src/index.ts`: RP API DTOs and Zod contracts; no DSH types.
- `packages/domain/src/surface.ts`: append/replace surface folding.
- `packages/domain/src/public-state.ts`: canonical-to-player projection and secret firewall.
- `packages/domain/src/transcript.ts`: folded events to stable RP messages.
- `apps/gateway/src/dsh/client.ts`: DSH RPC and WebSocket adapter.
- `apps/gateway/src/cards.ts`: manifest discovery intersected with preset roster.
- `apps/gateway/src/server.ts`: API v1, SSE fanout, static hosting.
- `apps/web/src/*`: application shell, campaign rail, narrative, composer, inspector, responsive sheets.
- `apps/web/public/cards/*`: local bitmap card artwork.
- `scripts/start.ps1`: local launcher and health checks.
- RP preset `plugins/rp-runtime.js`: checkpoint lineage and scoped commands.
- RP preset `rp-card.json`: discoverable player-facing metadata.

### Task 1: Workspace And Contract Skeleton

**Files:** Create root workspace files, `packages/protocol/package.json`, `packages/protocol/src/index.test.ts`, and `packages/protocol/src/index.ts`.

- [ ] Write a failing protocol test that parses a v1 success envelope and rejects a public state containing `secrets`.
- [ ] Run `pnpm --filter @dsh-rp/protocol test`; expect failure because the exported schemas do not exist.
- [ ] Implement versioned envelopes, card/session/message/public-state DTOs, and API error codes with Zod.
- [ ] Run the focused test and workspace typecheck; expect zero failures.
- [ ] Commit `feat: define rp gateway protocol`.

### Task 2: Durable Runtime Checkpoints And Controls

**Files:** Modify both installed RP runtimes and the source template; create `05-delivery/tests/rp-checkpoints.test.mjs` and `05-delivery/tests/rp-controls.test.mjs`; add both card manifests.

- [ ] Write failing reducer tests for `checkpoints`, `activeCheckpointId`, normal versus control turns, and two consecutive rollbacks moving backward.
- [ ] Run the tests; expect missing checkpoint fields and command registrations.
- [ ] Replace positional rollback history with lineage checkpoints while retaining legacy history migration.
- [ ] Add scoped `/rp-rollback` and `/rp-autoplay` commands. Each command uses `agent.runMaintenance`, appends a control user message plus assistant tool call, calls `ctx.tools.execute`, appends the paired result with `meta`, and closes the synthetic step/turn in `finally` blocks.
- [ ] Run reducer, mount, projection, resume, and control transaction tests; expect all pass.
- [ ] Mirror the tested runtime into installed `rp-runtime` and `zombie-world`, then run the real loader mountcheck.
- [ ] Commit source artifacts when a Git owner exists; otherwise record hashes in the Studio install manifest.

### Task 3: Player-Safe Domain Layer

**Files:** Create `packages/domain/src/{surface,public-state,transcript}.ts` and matching tests.

- [ ] Write failing tests with raw append/replace events and canary values under `secrets`, `offscreen`, hidden visibility, tool meta, reasoning, and private plugin control messages.
- [ ] Run `pnpm --filter @dsh-rp/domain test`; expect missing exports.
- [ ] Implement surface folding by event sequence, strict top-level public allowlists, recursive visibility filtering, checkpoint summaries, and transcript conversion.
- [ ] Assert serialized public outputs do not contain any canary string.
- [ ] Run focused tests and typecheck; expect zero failures.
- [ ] Commit `feat: add player-safe rp projections`.

### Task 4: DSH Adapter And Card Discovery

**Files:** Create `apps/gateway/src/dsh/{client,wire}.ts`, `apps/gateway/src/cards.ts`, fixtures, and tests.

- [ ] Write failing tests for unary envelopes, business errors, dual WebSocket readiness, reconnect, manifest id mismatch, broken presets, and missing upstream.
- [ ] Run gateway tests; expect missing adapter and registry.
- [ ] Implement exact-version DSH wire handling behind an internal interface, loopback-only URL validation, bounded retries, and path-free diagnostics.
- [ ] Implement manifest discovery under `DSH_HOME/.agent-presets`, intersected with `agentPreset.list`.
- [ ] Run focused tests; expect all pass and no raw filesystem path in API DTOs.
- [ ] Commit `feat: adapt dsh sessions and rp cards`.

### Task 5: Gateway API And SSE

**Files:** Create `apps/gateway/src/{app,server,session-service,event-hub}.ts` and API tests.

- [ ] Write failing Fastify injection tests for health, cards, list/create/load/send/cancel/fork/rollback/autoplay, 404, validation failure, and secret-free session payloads.
- [ ] Write a failing SSE test that receives only text delta, completion, public state, status, and rebase events for its requested RP session.
- [ ] Implement API v1 envelopes, session ownership checks, DSH error mapping, command-based controls, initial SSE snapshot, heartbeat, and resync notification.
- [ ] Run gateway tests; expect all pass without listening on a public interface.
- [ ] Commit `feat: serve versioned rp gateway`.

### Task 6: Frontend Data Model And Application Shell

**Files:** Create the Vite app, API client, Zustand store, shell, rail, header, narrative, inspector, composer, CSS tokens, and component tests.

- [ ] Write failing tests for card loading, campaign creation, empty state, session selection, streaming delta assembly, reconnect resync, and disabled controls while running.
- [ ] Run web tests; expect missing components.
- [ ] Implement the three-region desktop shell and mobile sheet navigation using protocol DTOs only.
- [ ] Implement command controls with Lucide icons, accessible labels/tooltips, focus management, stable composer dimensions, and reduced motion.
- [ ] Run component tests and typecheck; expect zero failures.
- [ ] Commit `feat: build rp studio shell`.

### Task 7: Narrative And Inspector Experience

**Files:** Create Tavern renderer adapter, document styles, message components, state tabs, timeline, and tests.

- [ ] Write failing tests that render Markdown, escaped HTML, one `:::letter`, one `:::newspaper`, player messages, and rollback-rebased transcript.
- [ ] Implement `dsh-tavern-renderer/core` integration and preserve all eight document class families.
- [ ] Implement structured status, relationships, quests, inventory, event log, checkpoint count, and autoplay state without exposing raw JSON.
- [ ] Run tests; expect sanitized HTML and no secret canaries in the DOM.
- [ ] Commit `feat: render narrative and campaign state`.

### Task 8: Visual Assets And Responsive Polish

**Files:** Add two bitmap card covers, responsive CSS, loading/error skeletons, and visual tests.

- [ ] Generate distinct inspectable cover art for the potion and apocalypse cards; store optimized WebP assets locally with attribution metadata indicating generated origin.
- [ ] Add 1440, 1024, 390, and 360 viewport tests for overflow, overlap, keyboard focus, and sheet behavior.
- [ ] Run Playwright screenshots and inspect them; adjust layout until text, controls, and media remain coherent.
- [ ] Run axe; expect no serious or critical findings.
- [ ] Commit `feat: finish responsive campaign experience`.

### Task 9: Packaging And Local Installation

**Files:** Create production build config, static hosting, `.env.example`, `scripts/start.ps1`, `scripts/install.ps1`, and README.

- [ ] Write failing launcher/config tests for loopback enforcement, occupied port selection, missing DSH, and upstream health.
- [ ] Implement one-command install/build/start, defaulting to ports 4317 and 3080 without storing API keys.
- [ ] Build the SPA and verify the Gateway serves deep links and immutable assets.
- [ ] Run the installer against this workspace, preserving existing profile and session files.
- [ ] Commit `build: package local rp studio`.

### Task 10: Final Acceptance

**Files:** Create Playwright mock DSH fixture, E2E specs, network leak audit, and verification report.

- [ ] Run full unit tests, typecheck, lint, and production build.
- [ ] Run E2E flows: create, send/stream, cancel, rollback twice, fork, autoplay arm/disarm, reload/resume, card switch, mobile navigation.
- [ ] Scan every captured HTTP/SSE body for secret canaries and raw `meta.rp`; expect none.
- [ ] Run a real read-only smoke against DSH 3080 for host, cards, and sessions.
- [ ] Start the production server, inspect desktop/mobile screenshots, and verify no console or network errors.
- [ ] Review this plan and the design requirement-by-requirement; record exact commands and results in `docs/verification.md`.
- [ ] Commit `test: verify rp studio release`.
