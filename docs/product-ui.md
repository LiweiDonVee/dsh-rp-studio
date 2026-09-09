# Product UI

## Entry points

- `/` remains the narrative-first desktop surface. “打开产品管理” navigates to the current session's product console.
- `/product?sessionId=...` is the local management console. Session-scoped lists and writes always include the current owned `sessionId`; pairing/status remain reachable when no session exists.
- `/companion` is the responsive Web companion served from the same `apps/web/dist` Vite build. It confirms a one-time pairing code, keeps the returned bearer only in React memory, calls the bearer-protected bootstrap, and permits selection only from `bootstrap.sessions`.

## Implemented surfaces

- Assets: independent browse and upload categories, allowlisted file picker, 10 MiB client guard, image preview, label update, deletion, safe attachment download, and cursor pagination. Preview work is cancellable and scoped to the asset/session; blob URLs are revoked when scope changes or the preview unmounts.
- Ledger: signed integer `amountMinor`, uppercase currency, append-only entries, and explicit compensating corrections through `reversesEntryId`.
- Knowledge: complete create/edit/delete flow for authoritative user notes. RP-derived knowledge is visually separate and read-only.
- RP projections: read-only memories/emotions, relationships, and fictional locations. Provenance is available under a diagnostic disclosure rather than filling the normal UI.
- Notifications: list and acknowledgement, with acknowledgement failures shown to the user. Companion notifications use an authenticated `fetch` readable stream because native `EventSource` cannot set the bearer header. The reader tracks the latest cursor across bounded reconnects, deduplicates reset snapshots and incoming events by notification id, keeps at most 100 newest items, releases the stream reader, aborts on unmount, and permanently stops/clears the in-memory bearer after `unauthorized` or `forbidden`.
- Backups: create/list/paginate, stage validation, visible replacement scope (`workspaceId`, `cardId`, `sessionId`), explicit confirmation, short-lived in-memory restore token, expiry removal, restaging, commit, and rollback-backup reporting.
- Pairing: desktop code creation bound to the current session and read-only scope, paired-client list and revocation. Companion bootstrap exposes only token-authorized sessions. Revocation clears bearer, story state, notifications, errors, and the selected session before returning to the pairing form.

## Contract and security boundaries

The UI imports product DTO types and Zod schemas from `@dsh-rp/protocol`; it does not maintain a second DTO definition. JSON responses are strict v1 envelopes and malformed successful DTOs fail closed. Product errors preserve their contract code for diagnostics.

No HTTP input accepts an arbitrary filesystem path or a DSH/provider token. Asset downloads use the product asset identifier and current session only. Remote companion data calls, asset reads, and notification streaming carry the in-memory bearer. The companion does not call the ordinary desktop session roster and cannot type an arbitrary session ID.

## Build and serving

`apps/web/dist` is the only build output. The HTTPS companion listener should serve `index.html` for `/` and `/companion`, Vite-hashed files below `/assets/`, and same-origin `/api/v1/product/*`. Asset previews require `blob:` for `img-src`/`media-src`; scripts, styles, and connections otherwise remain same-origin.

## Known integration gaps

- The UI has no control for enabling the HTTPS listener or selecting certificates. That remains desktop/Gateway configuration, and the pairing panel reports the current unavailable/disabled state instead of bypassing it.
- The companion is a responsive Web client, not a separately published React Native/Expo application. No RN dependency is included.
- Complete raw DSH-session backup is intentionally absent from online restore. The UI identifies backups as user data plus rebuildable story data and directs complete session export to the official DSH path.
- The desktop notification screen currently refreshes its bounded snapshot after acknowledgement; live authenticated streaming is implemented for the remote companion, where bearer headers are mandatory.

## Verification coverage

`apps/web/src/ProductApi.test.ts` covers strict envelopes, scoped pagination requests, product error codes, local upload rejection, two-phase restore, and in-memory bearer behavior. `apps/web/src/ProductPanel.test.tsx` covers surface separation and restore gating. `tests/e2e/product.spec.ts` provides strict contract mock handlers and covers pagination, unknown-field rejection, the real 10 MiB limit, commit-before-stage conflict, expired/revoked tokens, forbidden session access, bearer bootstrap, authenticated notification streaming, and small-screen layout.

All session/category loaders use an abort controller and generation guard. A new session or category generation clears the previous data before loading; cursor pages are appended immutably only when both generation and expected cursor still match. Unit tests resolve old/new requests in reverse order to prevent stale-scope regressions. Ledger corrections remain append-only, use the selected entry's currency and exact inverse amount, and exclude entries that already have a compensating reversal.
