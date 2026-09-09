# DSH RP Studio Verification

Date: 2026-08-19 (Asia/Shanghai)

## Release Contract

```text
RP Studio http://127.0.0.1:4317
  -> RP Gateway /api/v1 + SSE
  -> DSH http://127.0.0.1:3080
  -> Prompt Presets http://127.0.0.1:3091
```

`rp-runtime` is a card-neutral factory template, not a playable profile. RP Studio lists only finalized cards under `/cards`, rejects new sessions for the template, and can still restore historical `rp-runtime` sessions as read-compatible template sessions. Optional prompt methods are disabled by default and take effect only after explicit next-turn activation.

## Automated Evidence

- `pnpm verify`: lint, strict TypeScript checks, production builds, 62/62 unit/component tests, and 7/7 Chromium E2E tests PASS.
- Test split: protocol 3, domain 4, Gateway 39, Web 16.
- E2E covers streaming, cancel, rollback, fork, autoplay, card switching, empty-by-default prompt methods, next-turn activation, responsive layouts, accessibility, and bounded mobile sheets.
- `npm run check` in Prompt Presets: 24/24 tests and host/client build PASS.
- `npm run check` in Preset Library: 52/52 tests and host/client build PASS.
- RP runtime suite: 31/31 tests PASS; smoke exposes 19 generic tools and seven prompt sections.
- Source and installed `rp-runtime` mountchecks: PASS with 38 registered tools each.
- All 21 files owned by the template manifest match their declared SHA-256 and the installed copy.
- HP source and installed domain suites: 8/8 tests each; 537 world entries, schema-v3 state, magic settlement, potion ledgers, canonical quest ids, secret boundaries, single-use anchors, direction-packet firewall, and first-person contract PASS.
- Deterministic 30-turn in-memory playtest: 97 domain events, 30 digest/context records, bounded ledgers, safe hidden-term filtering, one-shot anchor consumption, and evidence-gated secret reveal PASS without creating a DSH session.
- HP `standingKeyFor('hp-potion-master')`: PASS on the built rc.7 Web host with one standing mount, 68 total visible tools after host/plugin layering, and zero process-global service leaks.
- `pnpm smoke:real`: two playable cards and four historical sessions loaded with no forbidden public fields, foreign/write/failed requests, console errors, image failures, or horizontal overflow.
- Real 1440x960 and 390x844 browser checks render the HP art at its 1200x900 intrinsic size with no text clipping or horizontal overflow.
- DSH native UI: `zombie-world` and `rp-runtime` render as separate expandable workspace groups; grouped sessions no longer fall into `未分组`.

## Runtime Behavior

- `/cards` exposes finalized playable cards only; the current inventory contains `zombie-world` and `hp-potion-master`, and excludes `rp-runtime`.
- Every card resolves to its own `%DSH_HOME%/rp-workspaces/<card-id>` workspace.
- DSH maps that workspace to `%DSH_HOME%/sessions/--<encoded-card-workspace>--/`; every Studio session then has its own `<session-id>/session.jsonl.zstd` history path.
- A real `POST /sessions` attempt for `rp-runtime` returns `404 card-unavailable` and leaves the session count unchanged.
- Historical schema v2 template snapshots replay through the schema v3 compatibility path.
- Public state omits hidden/offscreen fields, reasoning, tool results, and backend `meta.rp` payloads.
- DSH rollback restores canonical state and replaces the derived model surface; append-only backend audit events and visible historical text remain by design.

## Recovery

- Pre-cleanup: `E:/WorkSpace/.snapshots/2026-08-19-rp-runtime-template-cleanup-pre`
- Prompt-profile removal: `E:/WorkSpace/.snapshots/2026-08-19-rp-runtime-template-cleanup-prompt-profile-pre`
- Final: `E:/WorkSpace/.snapshots/2026-08-19-rp-runtime-template-cleanup-final`
- HP pre-migration: `E:/WorkSpace/.snapshots/2026-08-19-hp-potion-master-dsh-migration-pre`
- HP final: `E:/WorkSpace/.snapshots/2026-08-19-hp-potion-master-dsh-final`

Snapshots omit DSH session data. Existing `.zstd` histories and historical snapshots are never rewritten by this cleanup.
