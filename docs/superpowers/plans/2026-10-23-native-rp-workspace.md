# Native RP Workspace Implementation Plan

> Execute inline with superpowers:executing-plans. User approved implementation in this conversation.

**Goal:** Install RP Studio as a native DSH sidebar workspace.
**Architecture:** Authenticated in-process Gateway bridge plus native session-scoped React tab.
**Tech Stack:** DSH 0.2.1-rc.2 Cordis/Slots, React 18, existing Fastify/Zod protocols, esbuild.
**Spec:** ../specs/2026-10-23-native-rp-workspace.md

## Constraints
- No second runtime, listener, or copied credentials.
- Existing public-state boundary, session ownership and mutations remain authoritative.
- Use the host sidebar/fullscreen lifecycle and theme.
- Never generate against a paid model during acceptance.

## Tasks
1. Repair the renderer dependency, install locked dependencies, add plugin package/build and failing native bridge contract tests.
2. Implement the authenticated host bridge using existing SessionService and ProductService; test route limits, ownership, SSE abort and unload.
3. Add per-session native workspace UI, registration, theme styles and behavior tests; cover opening, session changes, input, stream and state rendering.
4. Build/package; run existing relevant checks and real isolated DSH plugin acceptance. Document installation and exact evidence.
