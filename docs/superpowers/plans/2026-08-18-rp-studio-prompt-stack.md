# RP Studio Prompt Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Gateway-mediated, session-scoped prompt-method drawer to RP Studio with an empty-by-default optional stack, locked Agent/card runtime core, CAS updates, reset-to-card-default, and next-turn semantics.

**Architecture:** The Gateway owns the prompt-presets client and card manifest routing. It fetches only sanitized metadata for the UI, validates selected optional entry IDs against the card manifest, and writes the full locked-core-plus-optional profile stack to the loopback prompt-presets service. The React app renders the prompt drawer beside the existing inspector and keeps the current public-state and narrative contracts unchanged.

**Tech Stack:** TypeScript, Fastify, Zod, React 18, Zustand, Lucide React, Vitest, Testing Library, Playwright.

---

## File Map

- Modify `packages/protocol/src/index.ts`: add prompt catalog/session DTOs and session-detail prompt state.
- Modify `apps/gateway/src/cards.ts`: read and validate optional prompt profile IDs from each card manifest.
- Create `apps/gateway/src/prompt-presets-client.ts`: loopback HTTP client for catalog, profile metadata, session binding, overlay mutation, and reset.
- Modify `apps/gateway/src/app.ts`: add prompt routes and request validation.
- Modify `apps/gateway/src/session-service.ts`: load sanitized prompt state, validate selection, and apply/reset overlays.
- Modify `apps/gateway/src/server.ts`: configure the prompt-presets URL from `PROMPT_PRESETS_BASE_URL`.
- Modify `apps/gateway/src/*test.ts`: cover prompt client, API routes, card metadata, default-empty state, CAS update, reset, invalid selection, and redaction.
- Modify `apps/web/src/api.ts`: call the Gateway prompt endpoints.
- Modify `apps/web/src/store.ts`: track prompt panel state, unsaved selection, save/reset, conflicts, and notices.
- Modify `apps/web/src/App.tsx`: add the persistent narrative-method view to desktop and mobile inspector surfaces.
- Modify `apps/web/src/styles.css`: style the prompt drawer, locked core row, optional profile/entry controls, warning, and next-turn marker.
- Modify `apps/web/src/App.test.tsx`: cover default empty, locked core, entry toggles, blank warning, next-turn label, and prompt-service failure.
- Modify `tests/e2e/studio.page.ts`: add prompt panel helpers.
- Modify `tests/e2e/studio.spec.ts`: add desktop/mobile prompt workflow assertions.
- Modify `scripts/start.ps1`: pass or document the prompt-presets loopback URL.

### Task 1: Snapshot And Protocol Contract

**Files:**
- Create snapshot directory outside the source tree: `E:/WorkSpace/repos/dsh-rp-studio/.snapshots/2026-08-18-pre-prompt-stack`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/packages/protocol/src/index.ts`.
- Test: `E:/WorkSpace/repos/dsh-rp-studio/packages/protocol/src/index.test.ts`.

- [ ] **Step 1: Create a recoverable snapshot before edits**

Run PowerShell from `E:\WorkSpace`:

```powershell
$snapshot = 'E:\WorkSpace\repos\dsh-rp-studio\.snapshots\2026-08-18-pre-prompt-stack'
New-Item -ItemType Directory -Force -Path $snapshot | Out-Null
Copy-Item -Recurse -Force 'E:\WorkSpace\repos\dsh-rp-studio\apps' "$snapshot\apps"
Copy-Item -Recurse -Force 'E:\WorkSpace\repos\dsh-rp-studio\packages' "$snapshot\packages"
Copy-Item -Recurse -Force 'E:\WorkSpace\repos\dsh-rp-studio\tests' "$snapshot\tests"
Copy-Item -Force 'E:\WorkSpace\repos\dsh-rp-studio\package.json' "$snapshot\package.json"
```

Expected: the snapshot contains the current Studio source and tests and does not contain `C:\Users\Owner\.dsh\sessions`.

- [ ] **Step 2: Add failing schemas and types**

Add these schemas to `packages/protocol/src/index.ts`:

```ts
export const promptEntrySummarySchema = z.object({
  id: z.string().min(1), name: z.string().min(1), slot: z.string().min(1),
  group: z.string().optional(), selection: z.enum(['single', 'multiple', 'any']).optional(),
  tags: z.array(z.string()), enabledByDefault: z.boolean(), renderOnly: z.boolean(),
}).strict()

export const promptProfileSummarySchema = z.object({
  id: z.string().min(1), name: z.string().min(1), description: z.string(), version: z.number().int().positive(),
  entries: z.array(promptEntrySummarySchema),
}).strict()

export const promptSessionSchema = z.object({
  available: z.boolean(), message: z.string().optional(), revision: z.number().int().nonnegative(),
  coreProfileIds: z.array(z.string()), optionalProfiles: z.array(promptProfileSummarySchema),
  enabledEntryIds: z.array(z.string()), appliesFromNextTurn: z.boolean(),
}).strict()
```

Extend `cardSchema` with an optional strict `prompt` object containing `coreProfileIds` and `optionalProfileIds`. Extend `sessionDetailSchema` with `prompt: promptSessionSchema`. Add `promptPresetSelectionSchema` with `enabledEntryIds` and nonnegative `expectedRevision`.

Add tests that reject prompt entry content fields and accept the empty optional state with locked core IDs.

- [ ] **Step 3: Run the focused test to verify the contract fails before implementation**

Run: `pnpm --filter @dsh-rp/protocol test`

Expected: FAIL at the new assertions because the new schemas/types are not implemented yet.

- [ ] **Step 4: Implement the schemas and exports**

Export `PromptSession`, `PromptProfileSummary`, `PromptEntrySummary`, and `PromptPresetSelection` inferred from the schemas. Update all existing fixtures to include `prompt: { available: false, revision: 0, coreProfileIds: [], optionalProfiles: [], enabledEntryIds: [], appliesFromNextTurn: false }` where strict session-detail parsing requires it.

- [ ] **Step 5: Run protocol tests and typecheck**

Run: `pnpm --filter @dsh-rp/protocol test && pnpm typecheck`

Expected: PASS with no TypeScript errors.

### Task 2: Card Prompt Manifest Metadata And Loopback Client

**Files:**
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/cards.ts`.
- Create: `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/prompt-presets-client.ts`.
- Tests: `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/cards.test.ts`, `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/prompt-presets-client.test.ts`.

- [ ] **Step 1: Add card-manifest fixtures and client contract tests**

Add a card fixture with `prompt-manifest.json` containing:

```json
{
  "schemaVersion": 1,
  "cardId": "rp-runtime",
  "baseProfiles": ["rp-narrative-base"],
  "cardProfiles": ["hp-potion-master"],
  "optionalProfiles": ["dreamwhale-v3-agent"]
}
```

Test that discovery returns only IDs and that `PromptPresetsClient` rejects non-loopback URLs, rejects malformed `{ ok: false }` responses, and strips prompt content from profile metadata.

- [ ] **Step 2: Implement manifest metadata loading**

In `discoverCards`, read `prompt-manifest.json` beside `rp-card.json`. If it is valid and its `cardId` equals the card ID, add `prompt.coreProfileIds` from `baseProfiles + cardProfiles` and `prompt.optionalProfileIds` from `optionalProfiles`. If absent, keep the card usable with no prompt metadata. If malformed, log a path-free diagnostic and omit only prompt metadata.

- [ ] **Step 3: Implement `PromptPresetsClient`**

Expose:

```ts
interface PromptPresetsClient {
  catalog(): Promise<{ revision: number; profiles: PromptProfileMetadata[] }>
  profile(id: string, version?: number): Promise<PromptProfileDocument>
  effective(sessionId: string): Promise<{ revision: number; binding?: { profileIds?: string[]; overlay?: { enabledEntries?: string[] }; appliesFromNextTurn?: boolean } }>
  setOverlay(sessionId: string, profileIds: string[], enabledEntryIds: string[], expectedRevision: number): Promise<{ revision: number; appliesFromNextTurn: boolean }>
  resetOverlay(sessionId: string, expectedRevision: number): Promise<{ revision: number }>
}
```

Build URLs from `PROMPT_PRESETS_BASE_URL` default `http://127.0.0.1:3091/prompt-presets/api`; use `assertLoopbackUrl`-equivalent validation; cap profile metadata to the declared card profile IDs; never return prompt content from the client’s public result.

- [ ] **Step 4: Run focused Gateway tests**

Run: `pnpm --filter @dsh-rp/gateway test -- cards.test.ts prompt-presets-client.test.ts`

Expected: PASS, including URL validation and content-redaction assertions.

### Task 3: Gateway Session Prompt API

**Files:**
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/app.ts`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/session-service.ts`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/server.ts`.
- Tests: `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/app.test.ts`, `E:/WorkSpace/repos/dsh-rp-studio/apps/gateway/src/session-service.test.ts`.

- [ ] **Step 1: Add failing service tests for default-empty and CAS behavior**

Use a fake prompt client and a card fixture whose optional profile contains entries `style-a` and `pacing-slow`, with `pacing` defined as `single`. Assert:

```ts
expect(detail.prompt.enabledEntryIds).toEqual([])
expect(detail.prompt.coreProfileIds).toEqual(['rp-narrative-base', 'hp-potion-master'])
await service.applyPromptSelection('session-1', { enabledEntryIds: ['style-a'], expectedRevision: 4 })
expect(prompt.setOverlay).toHaveBeenCalledWith('session-1', ['rp-narrative-base', 'hp-potion-master', 'dreamwhale-v3-agent'], ['style-a'], 4)
await service.resetPromptSelection('session-1', 5)
expect(prompt.resetOverlay).toHaveBeenCalledWith('session-1', 5)
```

Also assert invalid IDs and two entries from the same single group return a 400-level `GatewayError` and never call `setOverlay`.

- [ ] **Step 2: Implement prompt state assembly and selection validation**

In `SessionService`, load the card prompt metadata, fetch the declared optional profiles, and map each profile to sanitized entry metadata. Read the current prompt binding from the client; use only `overlay.enabledEntries` for the enabled optional set. When no binding exists, return empty enabled IDs and `appliesFromNextTurn: false`.

For apply, validate every ID against the card’s optional profile entries, enforce `selection === 'single'` by group, derive optional profile IDs from selected entries, prepend the card core profile IDs, and call `setOverlay`. For an empty set, call `resetOverlay` and return the warning-compatible empty state.

- [ ] **Step 3: Add Fastify routes**

Add to `app.ts`:

```ts
app.get('/api/v1/sessions/:id/prompt-presets', async request => successEnvelope(promptSessionSchema.parse(await options.api.promptSettings(sessionId(request.params)))))
app.put('/api/v1/sessions/:id/prompt-presets', async request => successEnvelope(promptSessionSchema.parse(await options.api.applyPromptSettings(sessionId(request.params), promptPresetSelectionSchema.parse(request.body)))))
app.delete('/api/v1/sessions/:id/prompt-presets', async request => successEnvelope(promptSessionSchema.parse(await options.api.resetPromptSettings(sessionId(request.params), revisionFrom(request.body)))))
```

Use a stable bad-request message for malformed IDs and preserve the existing envelope and host-origin checks.

- [ ] **Step 4: Wire the client into `startServer`**

Construct `PromptPresetsClient` from `options.promptPresetsUrl ?? process.env.PROMPT_PRESETS_BASE_URL` and inject it into `SessionService`. A failed prompt request maps to `available: false` for reads; a failed write returns `upstream-unavailable` and does not claim the selection was applied.

- [ ] **Step 5: Run focused Gateway tests**

Run: `pnpm --filter @dsh-rp/gateway test -- app.test.ts session-service.test.ts cards.test.ts prompt-presets-client.test.ts`

Expected: PASS with zero prompt text, profile source path, or binding internals in serialized API responses.

### Task 4: RP Studio Prompt Drawer State And UI

**Files:**
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/apps/web/src/api.ts`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/apps/web/src/store.ts`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/apps/web/src/App.tsx`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/apps/web/src/styles.css`.
- Test: `E:/WorkSpace/repos/dsh-rp-studio/apps/web/src/App.test.tsx`.

- [ ] **Step 1: Add failing component tests**

Extend the session fixture with a prompt state containing one locked core profile and the disabled DreamWhale Agent entries. Assert:

```ts
expect(screen.getByText('Agent runtime core')).toBeInTheDocument()
expect(screen.getByRole('checkbox', { name: '梦鲸·实验文风（Agent）' })).not.toBeChecked()
expect(screen.getByText('当前没有启用任何叙事方法')).toBeInTheDocument()
```

Clicking the profile checkbox should check all its entries and call `api.applyPromptSettings` with the selected IDs. Unchecking all should call reset and show the empty warning with `下一轮生效`. A single-choice group must leave only the last selected entry checked. Prompt-service failure must show a drawer-level unavailable message while the composer remains enabled.

- [ ] **Step 2: Add API client methods**

Add `promptSettings`, `applyPromptSettings`, and `resetPromptSettings` to `apps/web/src/api.ts`, using the existing envelope parser and `promptSessionSchema`.

- [ ] **Step 3: Extend Zustand state**

Add `promptSettings`, `promptDraftEntryIds`, `promptOpen`, `loadPromptSettings`, `togglePromptEntry`, `togglePromptProfile`, `applyPromptSettings`, and `resetPromptSettings`. Keep a local draft until the user applies it; update the current session detail from the Gateway response; preserve the draft on revision conflict and set the existing error banner.

- [ ] **Step 4: Implement the drawer view**

Add `PromptMethodsPanel` to the inspector tabs. Render the locked core row with a disabled checkbox or lock icon, profile-level checkboxes, entry-level checkboxes, the next-turn label, and the empty-state warning. Use Lucide icons and the existing button/icon patterns. Do not add instructional paragraphs; use labels and status text that communicate the current state directly.

- [ ] **Step 5: Add responsive styles**

Keep the existing 336px inspector width and mobile sheet dimensions. Use stable row heights, `min-width: 0`, wrapping labels, and a scrollable method list so long profile names cannot push the composer or create horizontal overflow.

- [ ] **Step 6: Run component tests and accessibility-focused checks**

Run: `pnpm --filter @dsh-rp/web test && pnpm typecheck`

Expected: PASS; no checkbox overlaps or overflow assertions fail.

### Task 5: End-to-End Prompt Workflow And Packaging

**Files:**
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/tests/e2e/mock-server.ts`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/tests/e2e/studio.page.ts`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/tests/e2e/studio.spec.ts`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/scripts/start.ps1`.
- Modify: `E:/WorkSpace/repos/dsh-rp-studio/README.md`.

- [ ] **Step 1: Add mock prompt service state**

Make the mock server expose catalog/profile/effective/overlay/reset routes and record the last overlay request. Seed the DreamWhale Agent entries disabled and revision `4`.

- [ ] **Step 2: Add Playwright workflow**

At 1440x960, open `叙事方法`, verify core is locked and the empty warning is visible, enable the DreamWhale profile, assert the mock received the core plus optional profile IDs and selected entry IDs, and verify the next-turn marker. Reset to empty and verify the warning remains. At 390x844, open the prompt tab from the inspector sheet and assert no horizontal overflow.

- [ ] **Step 3: Run the complete Studio verification**

Run: `pnpm verify`

Expected: lint, typecheck, unit tests, build, and all Playwright cases pass.

- [ ] **Step 4: Start the local server and inspect the built UI**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1 -NoBuild`

Expected: a loopback RP Studio URL is printed; the page loads with the prompt drawer available when the local prompt service is running and with a clear unavailable state otherwise.

- [ ] **Step 5: Record verification evidence**

Update `docs/verification.md` with exact commands, exit codes, test counts, prompt-service availability result, and screenshot paths. Do not claim completion until the full commands have been rerun after the final edit.
