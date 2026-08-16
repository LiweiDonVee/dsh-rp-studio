# DSH RP Studio Design

## Product

`DSH RP Studio` is a local-first roleplay client for DeepSeek Harness. DSH remains the model, agent, tool, session, projection, and persistence runtime. The Studio owns only the player-facing product surface and exposes no general DSH administration APIs.

The initial release supports every installed preset that publishes an `rp-card.json` manifest. The current acceptance set is `rp-runtime` and `zombie-world`.

## Architecture

The product is one Node process with two faces:

- A versioned RP Gateway at `/api/v1` that talks to DSH on loopback, folds raw session events, removes backend-only data, and emits a player-safe SSE stream.
- A React SPA served by the Gateway. The SPA never imports DSH event or RPC types and never calls port 3080 directly.

DSH remains an independently running local process. The default upstream is `http://127.0.0.1:3080`, configurable through `DSH_BASE_URL`. The Studio listens on `127.0.0.1:4317` by default.

## Runtime Control And Rollback

Roleplay presets register two deterministic slash commands:

- `/rp-rollback`
- `/rp-autoplay [off|1-64] [objective]`

The commands do not ask a model to choose a tool. They reserve the agent with `runMaintenance`, append a valid synthetic DSH turn and tool-call pair, execute the existing RP tool, and commit its `tool/result.data.meta.rp` through the normal projection path.

Rollback is based on bounded, durable key checkpoints:

- A checkpoint captures the full canonical game state at a normal `turn/start`.
- Checkpoints form a lineage through `parentId`, so repeated rollback moves backward instead of alternating between two states.
- A control command marks its turn before `turn/start`; control turns do not create player-history checkpoints.
- A rollback result records the restored checkpoint and the next rollback cursor in `meta.rp.rollback`.
- The existing `history` field remains readable for migration, but the current runtime uses `checkpoints` and `activeCheckpointId`.
- Projection replay reconstructs checkpoints from durable DSH events. Forked sessions inherit the same rollback lineage.

Visible transcript text is not physically deleted. The rollback tool writes a DSH surface replacement, and the Gateway folds that surface so rejected prose disappears from the Studio while the append-only audit log remains intact.

## Card Discovery

Each RP preset may publish `rp-card.json` with schema version 1:

```json
{
  "schemaVersion": 1,
  "runtime": "dsh-rp",
  "id": "rp-runtime",
  "title": "魔药宗师",
  "world": "1994 · 魁地奇世界杯营地",
  "protagonist": "加斯帕·拉尚斯",
  "art": "potion-master",
  "accent": "jade"
}
```

The Gateway intersects manifests with `agentPreset.list`; broken or missing presets are not offered. It never exposes preset paths. A copied manifest whose `id` does not match its directory is rejected rather than silently presenting the wrong card.

## Public Data Boundary

Raw DSH events and `rp-state` never cross the Studio API. The Gateway applies both an allowlist and visibility filtering:

- Exclude `secrets`, `offscreen`, backend audit fields, reasoning, tool calls, tool results, and objects whose visibility contains `hidden`.
- Include the scene, protagonist-visible traits and conditions, inventory, relationships, faction, quests, player memories, event log, driver status, and status lines.
- Expose checkpoint metadata only as `count`, `canRollback`, and the active turn. Full checkpoint snapshots stay server-side.
- Build transcript messages only from the folded surface's human user messages and assistant text blocks. Plugin control messages are omitted.

Tests use canary secret strings and fail if any API or SSE payload contains them.

## RP API v1

- `GET /api/v1/health`
- `GET /api/v1/cards`
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:sessionId`
- `POST /api/v1/sessions/:sessionId/messages`
- `POST /api/v1/sessions/:sessionId/cancel`
- `POST /api/v1/sessions/:sessionId/rollback`
- `POST /api/v1/sessions/:sessionId/fork`
- `PUT /api/v1/sessions/:sessionId/autoplay`
- `GET /api/v1/sessions/:sessionId/events`

Every response has `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. The Gateway reports protocol version `1`. SSE events are `connected`, `message.delta`, `message.completed`, `state.updated`, `session.status`, `session.rebased`, and `error`.

On reconnect, the browser reloads the session snapshot. This is required because DSH v1 ignores the stream `since` cursor.

## Interface

The visual direction is an editorial campaign dossier, not a generic chat dashboard. The palette is paper white, ink, muted jade, signal red, and neutral gray. It avoids gradients and decorative cards.

Desktop uses three stable regions: a 272px campaign rail, an unframed narrative column, and a 336px inspector. Mobile uses the narrative as the primary screen with sessions and inspector in accessible sheets. The composer remains fixed in size as content streams.

Expected workflows:

- Select a card and create a campaign.
- Resume a campaign after DSH or Studio restart.
- Read streaming prose and Tavern document directives.
- Inspect status, relationships, quests, inventory, and timeline.
- Send, cancel, rollback, fork, and control autoplay without leaving the narrative.

The UI uses Lucide icons, tooltips, keyboard focus, reduced-motion support, safe-area padding, and no instruction-heavy onboarding copy.

## Rendering

Assistant prose uses the existing `dsh-tavern-renderer/core` pipeline so macros, safe Markdown, sanitization, and all eight `:::document` formats remain compatible. Studio-specific CSS restyles the surrounding transcript but preserves document semantics.

## Error Handling

- DSH unavailable: retain the shell, show a reconnecting state, and retry with capped backoff.
- DSH business errors: preserve their stable code and render a short command-level error.
- Running-agent control attempt: return `agent-busy`; do not queue rollback behind unknown work.
- Invalid card manifest: omit the card and log a path-free diagnostic.
- Stream loss: reconnect, then reload the complete public snapshot.
- Invalid or unexpected upstream payload: fail closed and do not forward it.

## Verification

Acceptance requires:

- Runtime unit tests for checkpoint lineage, repeated rollback, control-turn suppression, and synthetic tool transaction shape.
- Gateway unit tests for DSH envelopes, surface folding, public-state redaction, transcript conversion, card discovery, and API errors.
- Browser component tests for loading, empty, connected, streaming, rollback, and responsive navigation states.
- Playwright desktop and mobile runs against a deterministic mock DSH server.
- Screenshot inspection at 1440x960, 1024x768, 390x844, and 360x800.
- Accessibility scan with no serious or critical findings.
- A real loopback smoke check against DSH `host.describe`, `agentPreset.list`, and `session.list` without sending a paid model prompt.
- Production build and a running local URL.

## Explicit Boundaries

The first release is local single-user software. It does not bind publicly, implement remote authentication, edit cards, expose hidden GM state, or replace DSH's model configuration UI. Two-pass settlement/render remains a runtime upgrade independent of the frontend split; the Studio protocol already accepts a future filtered direction-packet renderer without exposing canonical state.
