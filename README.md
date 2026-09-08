# DSH RP Studio — 1.0.1 preview

A local, content-free RP frontend for a compatible DeepSeek Harness (DSH) runtime. It starts with an empty card list. Bring your own user presets, worlds, characters and runtime implementation. No cards, stories, prompt packs, artwork, model credentials or card editor are included.

Studio preserves transcript rendering, live streaming, cancel, fork, public state, runtime rollback and optional autoplay controls. Its UI currently uses Chinese labels. The renderer's document layouts format user-supplied text; they are not story content.

## Install and run

Requires Node.js 24.x and pnpm 11.9.0. From this repository:

```sh
git clone https://github.com/LiweiDonVee/dsh-rp-studio.git
cd dsh-rp-studio
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open http://127.0.0.1:4317. The shell remains available if DSH is offline; API calls report the unavailable upstream and the UI retries. With DSH running and no registered RP presets, the card and session lists are empty and onboarding explains setup.

Start DSH separately using its own installation instructions. Export configuration in the Gateway process environment before starting Studio; `.env.example` is documentation, not an automatically loaded file:

| Variable | Default / purpose |
| --- | --- |
| `DSH_BASE_URL` | `http://127.0.0.1:3080`; compatible DSH Web HTTP loopback origin |
| `DSH_WEB_TOKEN` | Optional DSH Web launch token, exchanged for a server-side cookie |
| `DSH_HOME` | Current user's `.dsh`; must match DSH's local data directory |
| `DSH_RP_PORT` | `4317` |
| `DSH_RP_HOST` | `127.0.0.1`; loopback only |
| `DSH_RP_WEB_DIST` | Built `apps/web/dist`, resolved relative to the server module |
| `PROMPT_PRESETS_BASE_URL` | Unset: integration disabled; if enabled, full HTTP loopback API base |
| `PROMPT_PRESETS_WEB_TOKEN` | Optional separate Web launch token for that service |

For example, PowerShell: `$env:DSH_BASE_URL = 'http://127.0.0.1:3080'`, then `pnpm start`. On POSIX shells: `DSH_BASE_URL=http://127.0.0.1:3080 pnpm start`. Keep tokens out of frontend `VITE_` variables and source control. All renderer code and CSS are vendored locally; installation needs no sibling checkout.

## Supply your own preset

Install and register your own DSH **user** preset. In its `DSH_HOME/.agent-presets/<preset-id>/` directory, supply `rp-card.json` with these fields:

| Field | Contract |
| --- | --- |
| `schemaVersion`, `runtime` | `1`, `"dsh-rp"` |
| `id` | Exact registered preset ID; lowercase letters/digits/hyphens, starting with letter/digit |
| `title`, `world`, `protagonist` | Your own nonempty display labels |
| `description` | Optional display description |
| `accent` | `jade`, `crimson`, `graphite` or `gold` |
| `art` | Optional legacy identifier; defaults to ID. Studio uses a generic icon and loads no card images. |
| `kind` | Optional `card`; `template` is recognized for existing runtime sessions but excluded from playable cards |

A manifest only makes a preset discoverable. It does not implement a game engine. Broken, system, unregistered, mismatched and invalid presets are ignored. Reload presets from onboarding after installation. Studio creates/reconciles workspaces under `DSH_HOME/rp-workspaces/<id>` for discovered presets and resumes their sessions; DSH owns durable session storage.

## Required runtime contract

The adapter targets DSH's **0.1.2-rc.1 remote transport shape**. Synthetic protocol/workflow tests cover the capabilities below. A real rc.1 host with a disposable empty home also passed empty roster/session APIs and browser onboarding with no artwork or page errors. This does not certify live gameplay, paid-model generation or other DSH releases.

- HTTP RPC uses `POST /api/<method>` with `{type:"client-request", rpcId, method, payload:{args}}` and a matching `server-response` envelope. Methods include `agentPresets/list`, `session/list`, workspace create/rename, session create/page/prompt/cancel/fork. Health probes `agentPresets/list` and reports the adapter's compatibility target, not a discovered host version.
- `/api/remote.mux` provides `workspace/follow`, `session/control`, `session/follow` and `$events` streams. See `apps/gateway/src/dsh/client.ts` and its transport tests for exact frames. DSH handles approvals/questions; Studio yields those events.
- Session history carries durable sequence numbers, timestamps, user/assistant events, text content and append/replace surface operations. Studio excludes tool results and reasoning from transcripts, folds replacements, and backfills history on reconnect.
- Your runtime publishes `rp-state` projections containing `{game, meta}`. Public `game` fields include started, date/time, scene, protagonist, relationships, faction, inventory, memories, quests, eventLog, statusLines, driver and economy. Missing state yields empty collections. See `packages/domain/src/public-state.ts` and protocol schemas for allowed shapes.
- `meta.checkpoints` entries use `id`, `parentId` and `turn`, with `meta.activeCheckpointId`; only lineage counts reach the UI. Your runtime must handle `/rp-rollback`, restore state/history and publish updated projections. Studio sends that command; it cannot implement rollback for an arbitrary preset.
- Optional autoplay sends `/rp-autoplay <rounds> [objective]` or `/rp-autoplay off`. Your runtime must implement these commands to use the controls. Cancel and fork use DSH's session APIs.

Projection filtering is defense in depth: keep secrets out of public fields and generated prose. Studio cannot identify a secret embedded in an otherwise public string.

## Optional Prompt Presets

Studio has no dependency on a Prompt Presets package and ships no prompt text. To enable your own profiles, configure its API URL and add `prompt-manifest.json` beside your card manifest: `schemaVersion: 1`, matching `cardId`, and optional arrays `baseProfiles`, `cardProfiles`, `optionalProfiles` of profile IDs. IDs use the same lowercase letters/digits/hyphens rule.

The service must expose catalog, versioned profile metadata, session effective bindings and revision-checked overlay writes. Studio returns metadata only, enforces declared optional IDs and selection groups, and applies changes from the next turn. Base/card profile installation and binding are your runtime's responsibility. When the optional service is missing, transcript and session controls continue working.

## Development and checks

```sh
pnpm exec playwright install --with-deps chromium
pnpm verify
pnpm dev
```

Verification runs lint, type checks, unit/API tests, a clean build, compiled empty-production/content-isolation checks, and Chromium workflow/accessibility tests. CI defines Ubuntu and Windows jobs on Node 24 / pnpm 11.9. Test records are synthetic and excluded from production output. `pnpm build` removes only the four known package build directories before compiling.

MIT; see LICENSE, NOTICE and the vendored renderer's LICENSE/UPSTREAM files. This is a source application preview, not a published package or a DSH installer.
