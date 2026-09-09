# DSH RP Studio Product API Contract

Status: Gateway contract v1, DSH compatibility pinned to `0.1.2-rc.1`.

The product API is served under `/api/v1/product`. The desktop React client and a paired mobile client use the same DTOs. The main Gateway remains loopback-only. A LAN listener is a separate HTTPS listener, is disabled by default, and exposes only the product API after bearer-token authentication.

Every JSON success uses:

```json
{ "ok": true, "protocolVersion": 1, "data": {} }
```

Every JSON failure uses the existing v1 failure envelope. Product error codes are `bad-request`, `not-found`, `conflict`, `payload-too-large`, `unsupported-media-type`, `storage-unavailable`, `unauthorized`, `forbidden`, `rate-limited`, and `internal`. Inputs and outputs are strict DTOs; unknown fields fail validation.

## Trust and ownership boundary

- A request scoped with `sessionId` is accepted only after `SessionService.session(sessionId)` confirms the session belongs to an installed RP card. The Gateway derives `workspaceId`, `cardId`, and `branchId` from the owned session/adapter scope; callers cannot override them. The adapter scope is `{ workspaceId, cardId, sessionId, branchId }`.
- RP memories, relationships, emotions, knowledge, and fictional locations are projections of public DSH state. Projection records carry `sessionId`, `branchId`, and source `seq`. A baseline/rebase replaces the affected branch range and removes rows whose source sequence is no longer valid. It is not a last-write-wins append.
- Projection input passes the same strict public-state boundary as the player UI. Objects marked hidden, private, secret, GM-only, or offscreen are rejected or removed before storage. Raw DSH events, prompts, credentials, tool calls, reasoning, and hidden fields never enter product DTOs.
- DSH logs remain the mechanical fact source. The product layer does not rewrite RP facts or raw logs.
- Ledger entries, user knowledge annotations, and asset metadata are authoritative user data. They are written to an append-only command journal or equivalent authoritative tables. Rebuilding RP projections must preserve them. Backups include both authoritative app data and rebuildable RP projections and label them separately.
- Locations are fictional world positions such as a region, scene, or landmark. They never contain latitude, longitude, device location, or other real-world GPS data.
- Ledger amounts are signed integers in the currency's minimum unit together with an uppercase ISO-style currency code. No route initiates a bank transfer or claims to represent a real bank balance.

## Scope and pagination

Collection routes accept `?sessionId=<owned-session>&cursor=<opaque>&limit=1..100`. `sessionId` is required for RP projections and recommended for app data. Asset and user-data writes require `sessionId` in v1. List responses use `{ "items": [], "nextCursor": null }`; cursors are opaque.

## Status

`GET /api/v1/product/status`

Returns storage readiness, projection state, pairing state, the API version, and the pinned DSH compatibility. A missing `local-data` adapter reports `storage: "unavailable"`; it does not silently switch to an in-memory database.

## Assets and stickers

- `GET /api/v1/product/assets?sessionId=...&category=portrait|background|audio|sticker|attachment`
- `POST /api/v1/product/assets?sessionId=...`
- `GET /api/v1/product/assets/:assetId?sessionId=...`
- `PATCH /api/v1/product/assets/:assetId?sessionId=...`
- `DELETE /api/v1/product/assets/:assetId?sessionId=...`

Upload JSON is `{ "fileName", "mimeType", "contentBase64", "category", "label"? }`. Decoded content is limited to 10 MiB. Allowed MIME types are PNG, JPEG, WebP, GIF, MP3, OGG, WAV, and PDF. HTML and SVG are forbidden. The ID is `sha256:<64 lowercase hex>` and is recomputed by the Gateway. File-system paths are never returned. Downloads set `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and an allowlisted content type.

The storage adapter must resolve asset roots canonically, reject absolute/traversal paths, reject symbolic links at every path component, use exclusive or atomic writes, and verify the byte hash on read. Sticker packs use `category: "sticker"`; there is no separate unsafe file pipeline.

## Ledger

- `GET /api/v1/product/ledger?sessionId=...`
- `POST /api/v1/product/ledger?sessionId=...`

Create body:

```json
{
  "commandId": "client-generated-idempotency-key",
  "amountMinor": -1250,
  "currency": "USD",
  "description": "旅店住宿",
  "occurredAt": "2026-09-08T12:00:00.000Z"
}
```

`commandId` makes appends idempotent. Entries are immutable; corrections append a compensating entry referencing `reversesEntryId`.

## Knowledge annotations

- `GET /api/v1/product/knowledge?sessionId=...`
- `POST /api/v1/product/knowledge?sessionId=...`
- `PATCH /api/v1/product/knowledge/:knowledgeId?sessionId=...`
- `DELETE /api/v1/product/knowledge/:knowledgeId?sessionId=...`

User annotations have `source: "user"` and are authoritative app data. RP-derived records have `source: "rp-projection"`, include provenance, and are read-only through these routes.

## Public RP read models

- `GET /api/v1/product/memory?sessionId=...`
- `GET /api/v1/product/relationships?sessionId=...`
- `GET /api/v1/product/locations?sessionId=...`

The memory response includes public memories and public emotional observations. Relationship and location responses are likewise projection-only. All projected records include `{ sessionId, branchId, sourceSeq }`. Hidden data causes fail-closed validation and cannot be returned.

## Notifications

- `GET /api/v1/product/notifications?sessionId=...&cursor=...`
- `GET /api/v1/product/notifications/stream?sessionId=...&cursor=...`
- `POST /api/v1/product/notifications/:notificationId/ack?sessionId=...`

SSE event IDs are opaque cursors. The stream emits `notification` events. Retention is bounded by the storage adapter. If a requested cursor predates retained data, the first event is `reset` and carries a current notification snapshot plus a replacement cursor. `Last-Event-ID` is accepted when the query cursor is absent. Acknowledgement only marks a notification read; it never approves a DSH permission, tool call, question, or model action.

## Backups and restore

- `GET /api/v1/product/backups?sessionId=...`
- `POST /api/v1/product/backups?sessionId=...`
- `POST /api/v1/product/backups/:backupId/stage-restore?sessionId=...`
- `POST /api/v1/product/backups/:backupId/commit-restore?sessionId=...`

A backup manifest contains `schemaVersion`, creation time, scope, content hashes, and separate entries for authoritative app data and RP projections. Creation validates a consistent snapshot before publishing it. Restore is two phase: stage and validate first, then commit with a short-lived `restoreToken`. Commit creates and reports a rollback backup before replacing app data. Operations are restricted to application-owned data.

Raw DSH session backups are not represented as online-complete snapshots. A complete DSH backup requires stopping DSH writes or using an official DSH export facility; the API reports this limitation explicitly.

## Pairing protocol

- `GET /api/v1/product/pairing`
- `POST /api/v1/product/pairing/codes`
- `POST /api/v1/product/pairing/confirm`
- `GET /api/v1/product/pairing/clients`
- `DELETE /api/v1/product/pairing/clients/:clientId`

Pairing is disabled by default. The desktop enables the independent HTTPS listener with an explicit certificate, private key, bind host, and allowed Origin list. Code generation is desktop-only and returns a one-time high-entropy code with at most a five-minute TTL. Confirmation is rate-limited per source and code, consumes the code exactly once, and returns a random bearer token only once. Only a SHA-256 token hash is persisted.

Tokens default to read-only scopes. Desktop confirmation may grant a subset of `assets:write`, `ledger:write`, `knowledge:write`, and `notifications:ack`. Remote requests cannot call DSH session commands, alter pairing policy, create backup restores, or receive DSH tokens, provider credentials, filesystem paths, raw logs, WebSocket credentials, or hidden RP state. Bearer authentication protects remote HTTP, asset downloads, SSE, and any future WebSocket endpoint. Revocation invalidates the token immediately.

Remote requests require an allowed `Origin`, valid `Host`, HTTPS transport, a non-expired token, an allowed product route, and the route's scope. The main Gateway never binds `0.0.0.0`.

### CLI opt-in

Normal CLI startup reads `DSH_RP_PAIRING_CONFIG` in the Gateway main process. The file must be top-level JSON with `enabled: true`, an explicit LAN `host` and `port`, one or more exact `https://` `allowedOrigins`, and `certFile`/`keyFile` paths. A nested `pairing` object is not accepted. Relative certificate, key, and optional `companionDir` paths resolve relative to the config file. Example:

```json
{
  "enabled": true,
  "host": "192.168.1.7",
  "port": 4319,
  "allowedOrigins": ["https://phone.example"],
  "certFile": "tls/cert.pem",
  "keyFile": "tls/key.pem",
  "companionDir": "../../apps/web/dist",
  "writeScopes": []
}
```

The Gateway reads the private key only in the main process and starts the independent HTTPS listener. Invalid or unreadable configuration fails startup with a diagnostic. The listener root redirects to `/companion`; `/companion` and `/assets/<hashed-file>` serve the shared `apps/web/dist` Vite build with same-origin CSP. The remote listener has no backup list/export/import/stage/commit routes.

## Adapter lifecycle

`ProductDataStore` is the Gateway-owned adapter port implemented later by `packages/local-data`. It exposes explicit open/close readiness, collection reads, authoritative writes, projection replacement, notification cursor reads, pairing-token hash storage, and two-phase backup calls. Gateway startup may proceed without it, but non-status product routes return `storage-unavailable`. On shutdown the Gateway closes the adapter exactly once and releases stream subscriptions and pairing listener resources.
