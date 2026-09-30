# DSH 0.2.0-rc.2 compatibility

Checked 2026-09-30 against the installed official DeepSeek Harness runtime at `C:\Users\Owner\AppData\Local\Programs\DeepSeek Harness\resources\runtime`, whose `runtime.json` reports desktop version `0.2.0-rc.2`. The validation covers the compiled Remote definitions, Gateway stream protocol, preset registry, Web authentication, and Session controller types.

## Version boundary

The candidate declares Session format version 4 and marks `Session.eventAt()`, `snapshotEvents()`, and `ownEvents()` deprecated. Studio uses the shipped `session/follow`/`session/page` wire schema and does not call those synchronous APIs.

Studio has no in-process DSH SDK dependency. It never accesses `Session.events`, calls `eventAt()`/`snapshotEvents()`, creates Agent loops, or acquires persistence handles. Those operations, locks, and migrations stay with the DSH host. Session event numbers are treated as wire cursors, never byte offsets or array indexes.

## Remote contract

All unary calls POST a Connection envelope to `/api/<namespace>/<method>`:

```json
{"type":"client-request","rpcId":"uuid","method":"session/create","payload":{"args":{"request":{"agentPreset":"sample-world","workspaceId":"workspace-id"}}}}
```

Named arguments are significant: `session/list` uses `args._request`, most Session/Workspace commands use `args.request`, and `agentPresets/list` has empty `args`. Prompt requests carry a separately minted `requestId` for durable inbox correlation. No mutations are automatically retried.

| Operation | rc2 contract |
|---|---|
| Health / roster | `agentPresets/list`; the removed `host.describe` version is reported as `unknown`, with explicit transport and inspected capability names |
| Preset composition | `agentPresets/read` returns the plugin-bundle document; Studio no longer reads `.agent-presets` files |
| Session list / ownership | `session/list`; current preset comes from `projections.values.agentPreset`, never a stale creation-header selection |
| Workspace / archived sessions | First baseline from `workspace/follow`, then cancel that logical stream |
| Create / rename workspace | `workspace/create`, `workspace/rename` |
| Create / fork / prompt / cancel | `session/create`, `session/fork`, `session/prompt`, `session/cancel` |
| History / live narrative | `session/follow` snapshot and subsequent event frames; older pages use `session/page` at the snapshot's fixed `throughSeq` |
| Public RP state | `session/control` baseline/projection updates and the exact follow snapshot baseline |
| Running / removed events | `$events` forwards `api-session/status` and `api-session/removed` |

One authenticated `/api/remote.mux` WebSocket carries logical `{type: open, streamId, endpoint, payload: {args}}` streams. The carrier now also supports candidate rc2 uplink `{type: item}` and `{type: end}` frames, with cancellation and bounded reconnect. `session/follow` opts into `assistantStream` and maps candidate chunk frames to Studio deltas. Follow snapshots invalidate old transcript caches; concurrent detail requests share the pending history load. Candidate surface replacements use `startSeq`/`endSeq`; Studio preserves those sequence identities. Pagination rejects empty/non-progressing cursors instead of looping or silently truncating history.

`RemoteError` codes such as `session/agent-busy`, `session/not-found`, and `agent-preset/invalid` map to the existing player-safe error contract. Raw error details never cross the Gateway. The SPA/SSE schema stays at protocol version 1.

## Web authentication

The rc2 Connection checks cookies for both HTTP and WebSocket, including loopback clients. A root `GET /?token=...` returns a 303 and an authority-bound HttpOnly cookie; the Gateway accepts only the same-root `./` or `/` location. The Gateway handles this exchange with manual redirect handling and keeps the cookie only in process memory. HTTP calls and WebSocket upgrades reuse it. The two DSH profiles require separate tokens/cookies:

- `DSH_WEB_TOKEN` for `DSH_BASE_URL` (default port 3080).
- `PROMPT_PRESETS_WEB_TOKEN` for `PROMPT_PRESETS_BASE_URL` (default port 3091).

Programmatic clients can also supply `webToken`, or use a launch URL containing `?token=` as their base URL. Query secrets are removed from subsequent RPC/WebSocket URLs. A 401 invalidates the cookie and returns a safe authentication diagnostic. Use the fresh launch token and restart the Gateway if the old exchange no longer works. Do not disable DSH authentication or copy its signing credentials into Studio.

The candidate `createWebAuth()` exchange is used unchanged: a 303 launch-token exchange yields an HttpOnly cookie, and missing or expired authentication remains unavailable. The Gateway yields forwarded approval/question waterfalls with `outcome: {kind: next}` so the DSH Web client can handle them. It does not answer or approve them.

## Inspected unchanged boundaries

The candidate `dsh` CLI help still requires `dsh --profile web --host <loopback> --port <port> --no-open`; `packages/supervisor/src/index.ts` already launches exactly that argv and validates the token-bearing launch URL before starting Studio. Candidate `dsh-settings` documents one-time `settings.yaml` import into the active Profile plugin configuration; Studio does not duplicate or mutate that import. `apps/gateway/src/server.ts` remains loopback-only and constructs the authenticated client, while `web-auth.ts` fails closed when the 303 or cookie is missing.

## Tools and storage

Studio does not invoke `report` or `send_message`; these tools belong to DSH presets. Only human-source `user/message` and model-source assistant text are rendered. Agent/team message sources, reasoning, tool results, and packed private chunks remain excluded. The preset/runtime migration must be performed in its owning project.

There is no SQLite persistence dependency in Studio. Removal of DSH's optional SQLite Session backend does not remove old databases; export them with the older compatible DSH release before switching. The separately named DSH SQLite **query/index** package is not the removed Session persistence backend and must not be indiscriminately removed.

Studio does not migrate or rewrite DSH Session logs. For modern V4 formats use DSH's migration/export path; do not patch a header or bypass Session ownership.

## Verification limits

Integration update, 2026-09-28: candidate package inspection and disposable Web-host probes covered the rc2 CLI, cookie exchange, `agentPresets/list`, and `session/list` with no model call. Focused Studio regressions cover plugin-bundle discovery, rc2 follow assistant frames, bidirectional mux frames, source-only test discovery, explicit build cleanup, and private bootstrap removal. No paid provider generation or automatic conversion of existing user logs was performed.

Contract unit tests include real loopback HTTP/WebSocket transport with cookie enforcement; browser E2E uses deterministic Gateway fixtures. These checks do not claim a paid-model roundtrip or installed-preset runtime validation. `session/follow` can promote a cold Session and trigger host-managed persistence work even when Studio issues no gameplay command. Use a disposable DSH home for strict non-mutation acceptance.
