# DSH RP Studio Completion Audit

Date: 2026-08-17 (Asia/Shanghai)

## Decision

The DSH-backed frontend split is viable and implemented as a local production application. DSH remains the authority for models, presets, tools, events, canonical `rp-state`, projections, and append-only persistence. The Studio owns the player-safe transcript, public projections, controls, Tavern rendering, and responsive interaction surface.

## Requirement Matrix

| Requirement | Implementation | Direct evidence |
|---|---|---|
| One local process, Gateway plus SPA | Fastify serves `/api/v1` and the Vite build | `server.test.ts`; production process on `127.0.0.1:4317` |
| DSH remains an independent backend | Gateway adapter targets loopback DSH; browser has no DSH types or URL | `dsh/client.ts`; real smoke has zero foreign requests |
| Loopback-only boundary | Bind, upstream URL, Host header, and write Origin are validated | Gateway tests cover public bind, IPv6, DNS-rebinding Host, and cross-origin writes |
| Versioned fail-closed protocol | Strict Zod DTOs and `{ ok, protocolVersion, data/error }` envelopes | protocol tests; Gateway non-public DTO rejection test |
| Stable public errors | DSH business codes map to short messages and safe `upstreamCode` values | DSH adapter and rollback-unavailable tests |
| Card discovery | User manifests are intersected with the live DSH preset roster; paths are never returned | card discovery tests; real `/cards` returns `rp-runtime` and `zombie-world` |
| Player-safe state | Top-level allowlist, recursive hidden/private filtering, public checkpoint lineage depth | domain projection tests with secret canaries |
| Player-safe transcript | Folded DSH surface keeps only human user text and assistant text blocks | domain transcript and surface replacement tests |
| Safe SSE | Seven event families are schema-validated and bound to the subscribed session id | Gateway SSE whitelist, cross-session, and malicious payload tests |
| Stream recovery | Dual DSH streams reconnect with capped backoff; history is invalidated and merged by durable seq | DSH client and SessionService recovery tests |
| Create/resume/switch | Last session is persisted; navigation generation prevents stale requests and old streams winning | Web out-of-order navigation test; reload E2E |
| Send/stream/cancel | Optimistic player text is reconciled with real DSH `user/message`; cancel suppresses delayed completion | SessionService live event test; cancel E2E |
| Consecutive rollback | Runtime cursor follows checkpoint parents; Gateway reports current rollback depth; surface replacement rebases the transcript | runtime checkpoint tests; domain lineage test; two-rollback E2E |
| Fork and autoplay | Deterministic `/rp-rollback` and `/rp-autoplay` controls remain backend-owned | runtime control test; fork and autoplay arm/disarm E2E |
| Tavern compatibility | Existing renderer core handles safe Markdown and all eight document families | renderer tests; XSS assertion |
| Responsive and accessible UI | Three-region desktop, narrative-first mobile sheets, focus trap/restore, fixed composer | four viewport screenshots; axe; component focus tests |
| Offline behavior | Shell remains available and initial load retries from 500 ms to a 5 s cap | server offline test; Web retry test |
| Packaging and recovery | Frozen install, production build/start, bounded port selection, preset snapshots with SHA-256 | installer run; launcher tests; `.snapshots` manifests |

## Runtime Compatibility

The installed `rp-runtime` and `zombie-world` presets retain the DV Fork ownership model:

- canonical state is replayed from `tool/result.data.meta.rp`;
- rollback restores a turn-start snapshot and emits a DSH surface replacement;
- the seven GM prompt modules remain ordered runtime sections;
- mutating tools publish post-mutation state through `rp-state`;
- 38 and 43 tools respectively pass the real loader mountcheck.

The residue scan found no universal `update_state`, `patch_state`, or JSON Patch gameplay surface. The only ST-style tokens are intentional `{{char}}` and `{{user}}` Tavern display macros supported by the selected renderer. Existing source plans use the established `world-data/<card>/runtime-plan-dsh.json` name; they are runtime source documentation, not part of the Studio's public contract.

## Security And Data Boundary

- Official npm registry production audit: no known vulnerabilities.
- HTTP DTOs and every SSE event are parsed before transmission.
- Secret canaries, `meta.rp`, hidden/offscreen data, reasoning, and tool results are absent from captured API bodies and the DOM.
- The production browser made no request to DSH port 3080 and no write request during real smoke.
- No API key is stored by the Studio.

## Deliberate Limits

DSH session history is append-only. A rollback removes rejected prose from the folded/model-visible surface and restores canonical state, but does not physically erase backend audit events. The final real-system smoke is read-only and intentionally sends no paid model prompt; runtime mechanics are exercised through deterministic plugin, projection, mount, and browser fixtures instead.
