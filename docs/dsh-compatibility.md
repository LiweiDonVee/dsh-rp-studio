# DSH 0.1.2-rc.1 compatibility

Checked 2026-09-07 against the installed `@deepseek-ai/dsh` 0.1.2-rc.1 packages in `E:\WorkSpace\repos\deepseek-harness-local\node_modules\@deepseek-ai`, especially the compiled Remote definitions, Connection browser authentication, Session history controller, and stream protocol. The older source checkout reports 0.1.0-rc.5 and is not the contract authority for this upgrade.

## Version boundary

The September release notes place on-demand Session events, `send_message`, removal of the optional SQLite persistence backend, and Web launch-token authentication in 0.1.2-rc.1. **Session v2, lifecycle-scoped `SessionHandle`, and asynchronous `agentLoop.create()` belong to 0.1.3-alpha.1**, which also has an upstream performance-regression notice. This project targets rc.1; it does not claim validation against the alpha's settlement/event format.

Studio has no in-process DSH SDK dependency. It never accesses `Session.events`, calls `eventAt()`/`snapshotEvents()`, creates Agent loops, or acquires persistence handles. Those operations, locks, and migrations stay with the DSH host. Session event numbers are treated as wire cursors, never byte offsets or array indexes.

## Remote contract

All unary calls POST a Connection envelope to `/api/<namespace>/<method>`:

```json
{"type":"client-request","rpcId":"uuid","method":"session/create","payload":{"args":{"request":{"agentPreset":"zombie-world","workspaceId":"workspace-id"}}}}
```

Named arguments are significant: `session/list` uses `args._request`, most Session/Workspace commands use `args.request`, and `agentPresets/list` has empty `args`. Prompt requests carry a separately minted `requestId` for durable inbox correlation. No mutations are automatically retried.

| Operation | rc.1 contract |
|---|---|
| Health / roster | `agentPresets/list`; the removed `host.describe` version is reported as `unknown`, with explicit `transport: remote` and compatibility target |
| Session list / ownership | `session/list`; current preset comes from `projections.values.agentPreset`, never a stale creation-header selection |
| Workspace / archived sessions | First baseline from `workspace/follow`, then cancel that logical stream |
| Create / rename workspace | `workspace/create`, `workspace/rename` |
| Create / fork / prompt / cancel | `session/create`, `session/fork`, `session/prompt`, `session/cancel` |
| History / live narrative | `session/follow` snapshot and subsequent event frames; older pages use `session/page` at the snapshot's fixed `throughSeq` |
| Public RP state | `session/control` baseline/projection updates and the exact follow snapshot baseline |
| Running / removed events | `$events` forwards `api-session/status` and `api-session/removed` |

One authenticated `/api/remote.mux` WebSocket carries logical `{type: open, streamId, endpoint, payload: {args}}` streams. Reconnect reopens active subscriptions with bounded backoff. Follow snapshots invalidate old transcript caches; concurrent detail requests share the pending history load. Final messages retain their durable seq; packed reasoning/tool/text delta rows are excluded from the historical player transcript and never treated as surface messages. Pagination rejects empty/non-progressing cursors instead of looping or silently truncating history.

`RemoteError` codes such as `session/agent-busy`, `session/not-found`, and `agent-preset/invalid` map to the existing player-safe error contract. Raw error details never cross the Gateway. The SPA/SSE schema stays at protocol version 1.

## Web authentication

The actual rc.1 Connection checks cookies for both HTTP and WebSocket, including loopback clients. A root `GET /?token=...` returns a 303 and an authority-bound HttpOnly cookie. The Gateway handles this exchange with manual redirect handling and keeps the cookie only in process memory. HTTP calls and WebSocket upgrades reuse it. The two DSH profiles require separate tokens/cookies:

- `DSH_WEB_TOKEN` for `DSH_BASE_URL` (default port 3080).
- `PROMPT_PRESETS_WEB_TOKEN` for `PROMPT_PRESETS_BASE_URL` (default port 3091).

Programmatic clients can also supply `webToken`, or use a launch URL containing `?token=` as their base URL. Query secrets are removed from subsequent RPC/WebSocket URLs. A 401 invalidates the cookie and returns a safe authentication diagnostic. Use the fresh launch token and restart the Gateway if the old exchange no longer works. Do not disable DSH authentication or copy its signing credentials into Studio.

The Gateway yields forwarded approval/question waterfalls with `outcome: {kind: next}` so the DSH Web client can handle them. It does not answer or approve them. Players may need to open DSH Web for a pending upstream approval.

## Tools and storage

Studio does not invoke `report` or `send_message`; these tools belong to DSH presets. Only human-source `user/message` and model-source assistant text are rendered. Agent/team message sources, reasoning, tool results, and packed private chunks remain excluded. The preset/runtime migration must be performed in its owning project.

There is no SQLite persistence dependency in Studio. Removal of DSH's optional SQLite Session backend does not remove old databases; export them with the older compatible DSH release before switching. The separately named DSH SQLite **query/index** package is not the removed Session persistence backend and must not be indiscriminately removed.

`migrateCompressedSessionLog()` is an existing offline legacy-v0 header relocation helper, not a DSH version upgrader. It returns bytes without writing files, preserves event-frame bytes, and rejects missing/unknown versions and v1/v2 logs. Do not apply it to live/locked data. For modern formats use DSH's migration/export path; do not patch a v2 header or bypass `SessionHandle` ownership.

## Verification limits

Integration update, 2026-09-07: the main upgrade task fixed the strict public health schema and cold-session ownership discovery. Ownership probes use bounded, separate follow streams; they cannot cancel an active narrative follower. Full verification passes 83 unit tests and 7 Playwright scenarios. A disposable real rc.1 Web host also passed token/cookie authentication, preset and prompt settings pages, Studio health/roster/session APIs, and both playable cards' creation/detail/prompt-method requests. `pnpm start:stack` now starts one DSH Web host and Studio with process-local token exchange; its health/roster were verified in a disposable home. No paid provider generation or automatic conversion of existing user logs was performed.

Contract unit tests include real loopback HTTP/WebSocket transport with cookie enforcement; browser E2E uses deterministic Gateway fixtures. These checks do not claim a paid-model roundtrip or installed-preset runtime validation. `session/follow` can promote a cold Session and trigger host-managed persistence work even when Studio issues no gameplay command. Use a disposable DSH home for strict non-mutation acceptance.
