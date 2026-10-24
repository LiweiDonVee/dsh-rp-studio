# RP Preset Kernel Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. This common layer is authorized by the user's explicit ST import, user locks, agent hot assembly and immutable-source requirements. The user confirmed presentation-only scope; existing agents/tools own facts and simulation.

**Goal:** Provide a tested content-free ST import and permission-aware preset compilation kernel for the independent RP last-step plugin.
**Architecture:** Pure Node kernel for source/profile/overlay data, separate revisioned JSON store. No DSH control, UI, model calls or game state in this task.
**Tech Stack:** Node24 builtin crypto/fs, node:test. No third-party runtime dependencies.
**Spec:** ../specs/2026-10-24-rp-last-step-design.md and skills/adapting-sillytavern-rp-presets/SKILL.md.

## Task 1: Source, profiles, overlays and compile

Files: packages/rp-last-step/src/core.mjs, store.mjs, tests/core.test.mjs, store.test.mjs.

Exports and contracts are specified in the implementer brief in the task ledger. Preserve ST original raw text exactly; raw extensions are inert. Phases: unclassified|agent|render|shared. User policy flags required and locked are separate. Agent changes affect session overlay, cannot edit original/policy/phase or profile binding. Locked module fills cannot be changed indirectly by another module. Default-disabled entries stay disabled. Enabled unclassified or unmapped marker entries block production compilation. Agent-phase instructions cannot enter render compilation.

- [x] Write a failing roundtrip/locked-entry test and run it:

```js
const imported = importSillyTavern(sourceText)
assert.equal(imported.source.rawText, sourceText)
assert.throws(() => applyAgentOperations(profile, emptyOverlay(), [{op:'disable',entryId:'locked'}]))
```

- [x] Implement importSillyTavern, createProfile, validateProfile, emptyOverlay, applyAgentOperations and compileProfile with immutable return snapshots. See the exact brief for fields. Include readonly original and agent/render splitting regressions.
- [x] Implement createPresetStore({directory}) with revisioned source/profile versions and session bindings/overlays. Require expectedRevision on every owner/agent mutation; serialize writes and atomically replace owned state file. Never modify user source files. No HTTP or DSH imports.
- [x] Tests: original text/unknown extension preservation; selected prompt_order enablement/order; duplicate entry errors; default-off retention; mandatory disable rejection; readonly content/fill rejection; editable required content allowed; temporary entry limitations; agent phase excluded from render; unresolved macros/markers diagnosed; stale revisions; restart and pinned binding version.
- [x] Run `node --test packages/rp-last-step/tests/*.test.mjs`, report exact exports/shapes and evidence for review. Parent owns manifest/build/UI/runtime in subsequent tasks, not this worker.

## Task 2: Preset library editor (common to either simulation scope)

Files: packages/rp-last-step/src/PresetWorkspace.jsx, api.js, styles.css; apps/web/src/rp-preset-workspace.test.jsx. Parent supplies native registration, host API and actual model operations separately. The pure editor must not depend on RP Studio or Loop Studio source code.

- [x] Red/green an import-original preservation UI path, owner module policy edit and pinned-story binding.
- [x] Implement empty startup, JSON file/text import, blank profile creation, module list and owner fields (enabled, phase, required, Agent readonly, role, order, content), readonly original viewer, version/status save, apply ready profile version to current story, agent overlay visibility and compile preview.
- [x] Keep draft revision/profile identity fixed while dirty; 409 preserves edits, explicit reload discards. Hidden/unmounted/session-changed requests cannot commit old data.
- [x] Use exact API described in .runtime/rp-last-step-work/client-brief.md. No standalone mock/preview site; parent verifies real native host after wiring.
- [x] Run focused existing Vitest config, report tests and accessible controls. No model calls in this worker.
