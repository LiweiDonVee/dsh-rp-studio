# Agent Loop Studio Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent Host and Client tasks, then integrate and review. User approved scope 1 in this conversation; execute continuously.

**Goal:** Ship an independent native dsh plugin that analyzes presets, visualizes their actual loop and controls supported model nodes.
**Architecture:** Versioned graph/routing kernel, native Host adapter, separate React graph UI, self-contained tarball. RP integration is an optional participant and a separate product.
**Tech Stack:** DSH 0.2.1-rc.2, Node 24, React 18 from host, esbuild, node:test, existing Vitest/Playwright.
**Spec:** ../specs/2026-10-24-agent-loop-studio-design.md

## Constraints and shared contracts

- No RP imports, extra server, copied credentials, paid smoke calls or source-preset writes.
- Keep graph definitions, policies, traces, adapter and UI separate. No arbitrary topology execution in v1.
- Follow the exact API/DTO signatures in the spec. Node IDs are `host.first` and `host.continuation`.
- Preserve user/session isolation and release owned listeners and subscriptions.

## Task 1: Kernel, policies and Host integration

Files: create `packages/loop-plugin/src/{core,store,host,routes}.mjs` and `packages/loop-plugin/tests/{core,store,host,routes}.test.mjs`.

- [x] Write and run a failing policy test:

```js
assert.deepEqual(resolvePolicy({enabled:true,routes:{'host.first':route}}, {enabled:false,routes:{}}), {enabled:false,routes:{}})
```

- [x] Implement graph construction, merging participant stages and policy resolution in `core.mjs`; keep filesystem and ctx out of this module.
- [x] Store `revision`, session and preset policy records in `DSH_HOME/app-data/loop-studio`. Test stale expectedRevision and restart reads.
- [x] Attach scoped assembly/request listeners to existing and newly created agents, capture policy at assembly, use exact captured provider/model for request, clear inherited effort after a route change, dispose on unload. Test with fake scoped ctx and two sessions.
- [x] Read roster/composition via public host capabilities and build the universal loop DTO. Replay and observe metadata only; do not expose raw arguments or text.
- [x] Implement exact Connection endpoints and bounded, abortable SSE. Tests include unsubscribe on request/body cancellation and no arbitrary proxy action.
- [x] Expose a documented optional participant API for independent future stages and route resolution; no RP-specific code.
- [x] Run `node --test packages/loop-plugin/tests/*.test.mjs` and provide changed files, API details and evidence for review.

## Task 2: Native graph and node model controls

Files: create `packages/loop-plugin/src/{client,LoopWorkspace}.jsx`, `src/{api.js,styles.css}`, and `apps/web/src/loop-workspace.test.jsx`.

- [x] Start a failing component test that renders `LoopWorkspace({sessionId,client})`, selects `host.first`, changes route and saves with current revision.
- [x] Use the shared inspect/save/reset DTO contract. Ignore stale responses on session changes and close the SSE on hide/unmount.
- [x] Draw a responsive, readable fixed loop graph with actual edges, selectable model nodes and metadata trace. Route panel chooses provider/model, reasoning effort when available, output cap, enabled state, and save scope. Native program nodes remain observe-only.
- [x] Native integration mirrors the working RP plugin: sidebar type/body, header action and blank hero action, injected style lifecycle. Use DSH theme tokens and host fullscreen.
- [x] Tests cover save/inherit/disabled, unknown driver and read-only nodes, stale session replies and subscription cleanup. Run from `apps/web`: `node ../../node_modules/vitest/vitest.mjs run src/loop-workspace.test.jsx --config vite.config.ts`.

## Task 3: Packaging, real Host acceptance and integration

Files: create `packages/loop-plugin/{package.json,cordis.patch.yml,README.md,LICENSE}`, scripts build/pack, `scripts/loop-smoke.mjs`; update root scripts and clean-build outputs/contract test; update acceptance documentation.

- [x] Bundle Host ESM and browser ModuleLoader CJS with React external; archive only compiled entries and installation resources. Strip workspace/dev dependencies from install manifest.
- [x] Build and install into a fresh disposable official DSH home with keyless mock providers and a custom preset. Exercise standard/custom preset inspection, per-node real routing, disable restore, native entry/fullscreen/narrow layouts and close/reopen.
- [x] Inspect the screenshots and actual adapter calls, not merely compilation. Run lint, relevant tests, workspace typecheck/build and existing E2E only as needed by changed integration.
- [x] Independent spec/code review; fix observed findings. Record final artifact and verification evidence, and publish reviewable changes according to existing user authorization.

## Separate RP work

The migration skill is a draft at `skills/adapting-sillytavern-rp-presets/`; its behavior is evaluated separately. RP runtime and its optional Loop Studio participant follow their own spec. Do not build RP semantics into Task 1 or Task 2.
