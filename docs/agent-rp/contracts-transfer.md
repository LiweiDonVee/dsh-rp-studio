> Public copy of the frozen development design. See [status and versions](README.md); complete native acceptance is a separate gate.

# Transfer and document contracts v1 [FROZEN]

Complements contracts.md, contracts-story-kit.md and contracts-runtime.md. Approved P6 must implement content/reading export plus legal saved-game restore validation. Public host probe now establishes exact-ID persistence restore is possible on rc.3; do not treat restoration as unavailable without testing the defined route. No media.

## 1. Document/index service (Database owner)

```ts
DocumentRef={documentId:string,version:number}
ChunkRef={documentId:string,documentVersion:number,chunkId:string,page?:number,paragraph?:number}
importDocument({name,mimeType,dataBase64?,text?,expectedRevision,requestId,signal?})
 -> {revision,documentId,version,databaseId,sourceKeySuggestion,diagnostics,chunkCount}
document({documentId,version?,signal?}) -> {document,extraction,diagnostics}
indexState({signal?}) -> {model?:string,readyChunks,staleChunks,lastErrorCode?}
rebuildIndex({databaseIds?:string[],signal?}) -> {indexedChunks,skippedChunks,diagnostics}
```

Implement TXT/Markdown and PDF with real text layer. PDF extraction library runs inside packaged Node runtime; no external installed CLI requirement. An image-only PDF yields explicit NO_TEXT_LAYER, not invented text or OCR. Preserve original bytes and version, text extraction version, content hashes and deterministic chunks with page/paragraph source. Entries used by retrieval carry document/chunk provenance as bounded metadata. Existing library entries remain editable under original policies; raw documents are immutable versions. New extracted document database uses ordinary source binding; import does not auto-bind a story.

Cache vectors by text hash + extraction/chunking version + explicit provider/model identity and dimension. Do not store API keys as identity. Changed content invalidates affected cache; model switch reindexes or uses explicit lexical degradation. Query vectors generated per query. Rebuildable cached vectors never decide active branches: filter current effective source/ref/disabled state before provider requests and result projection. Reranking uses configured service only; no inferred external endpoint. Owner UI shows indexing state/errors and source locations.

## 2. Saved story snapshot (different from content pack)

```ts
SavedStory={format:'dsh-rp-saved-story',schemaVersion:1,identityMode:'preserve',
 exportedAt,selectedSessionId,
 sessions:[{header,events,inheritedEventCount:number}],
 pluginState:{database,context,lastStep,gm,storyKit},
 resources:[],requirements:[]}
```

sessions include selected story plus required ancestor sessions for lineage. Export each via public Session observations/persistence interfaces and preserve exact headers/events/IDs/seq/sourceEventSeqs. No hidden provider credentials or plugin executable code. Plugin payloads are versioned DTOs owned/validated by each plugin; contain only required source versions, bindings, causal overlays/receipts/drafts/settings/asset refs, not unrelated whole stores.

Exact-ID restore only. Any destination Session ID collision not already owned by the same resumable restore job fails RESTORE_ID_CONFLICT without mutation. No automatic remapping, prefix overwrite, private JSONL copying or synthetic historical tools. Content-library ID/version collisions may reuse byte/structure-identical immutable content; conflicting content fails. Stable refs stay intact.

Host positive mechanism: public ctx.sessionPersistence.create(originalHeader), handle.append(originalEvents), flush, close, then ctx.agents.resume only after plugin state is ready. This is in-process owner service, not an invented session/import Remote. Native rc.3 tests must cold-read and restart destination, show original prefix equality and zero historical model/tool execution. Fork/rollback across imported prefix must work before restoration is called complete.

## 3. Plugin transfer seam

Database, Context, LastStep, GM and StoryKit implement:

```ts
exportState({sessionIds:string[],signal?}) -> {schemaVersion:1,revision:number,payload:object}
preflightRestore({sessionIds:string[],state:{schemaVersion,revision,payload},signal?})
 -> {supported:boolean,conflicts:[{code,id}],requirements:string[]}
restoreState({restoreId:string,sessionIds:string[],state,expectedRevision:number,signal?})
 -> {revision,restoredSessionIds:string[]}
contentRevision({signal?}) -> {revision}
```

Only owner/plugin service, no model tools. exportState includes immutable source/version dependencies and active+audit causal data needed for legal rewind within exported prefix. It must never manufacture accepted history solely from plugin receipts. Plugin reference validation uses actual supplied canonical sessions. Existing unrelated data not overwritten. restoreState is idempotent for same restoreId+same payload and conflicts on different payload; atomic within its own store. Source maps are exact identity, no plugin independently remaps events.

StoryKit orchestrates save export/restore with a small durable restore journal. Preflight all host and plugin dependencies/collisions before starting writes. Keep GM binding status restoring while partial. Import plugin content/state and exact Session records using supported services; no model request/resume play before all components pass. If interrupted, retain progress and resume the same restoreId; do not promise cross-store atomicity or delete preexisting data. Other restore jobs may not claim partially created IDs.

Capture only idle selected stories; use public maintenance serialization and compare relevant store revisions before/after snapshot. Changed state returns EXPORT_CHANGED for explicit retry, never a torn successful bundle. Ancestor data requirements are included or reported before export. No scanning arbitrary filesystem paths.

```ts
rpStoryKit.exportSavedStory({sessionId,signal?}) -> {snapshot:SavedStory}
rpStoryKit.previewSavedStory({snapshot,signal?}) -> {supported,conflicts,requirements,identityMode:'preserve'}
rpStoryKit.restoreSavedStory({snapshot,restoreId,signal?}) -> {status:'complete'|'pending'|'failed',sessionId,diagnostics}
```

Restore feature must validate actual rc.3 APIs. If a required scenario (e.g. imported ancestry rollback) cannot be legally supported, return a narrow supported:false with probe evidence for that scenario; ship complete content/reading functions rather than claiming full restore. Conditional support is not permission to skip restore implementation when evidence supports it.

## 4. Frozen errors and output interpretation

RESTORE_ID_CONFLICT, RESTORE_CONTENT_CONFLICT, RESTORE_REQUIREMENT_MISSING, RESTORE_PAYLOAD_INVALID, EXPORT_CHANGED are structured safe errors. Successful text export is not save recovery. Successful live append is not cold recovery. Screenshot/fixture output is not paid-model story-quality evidence.

## Amendment T1 — Loop policy and owner restore completeness [FROZEN]

SavedStory adds optional loopPolicies:[{sessionId,policy}] capturing only effective routing policy, not trace, prompts or credentials. No Loop release change is needed: existing loopStudio.inspect(sessionId,signal) exposes effectivePolicy/revision; existing savePolicy({sessionId,scope:'session',policy,expectedRevision},signal) restores a session override. Never mutate destination preset/global defaults. If exported policy requires unavailable provider/model/node, preview reports it; no implicit fallback. Existing model credentials are configured independently on destination.

The coordinator can resume an imported Agent without prompting to make its native graph available, while GM binding remains restoring. Apply validated per-session policy, then rpGM.activateRestored. Probe proves resume does not reexecute tools/models; product smoke must confirm this with real plugins. Missing required Loop or route capability is explicit, not silently ignored.

GM exportState contains binding/launch metadata only, Database carries facts/receipts, LastStep carries profiles/receipts/drafts/frozen snapshots, Context carries plans/summaries/notes. StoryKit carries referenced assets/resources and transfer journal. No component may overwrite another's store to satisfy restore. Independent owner restore/export methods must be implemented even when end-to-end orchestration belongs to the launch/transfer implementation.

## Amendment T2 — destination validation order [FROZEN]

preflightRestore performs structure, supported schema, identity/conflict and dependency checks; destination canonical sessions need not already exist. It does not claim source validity until host cold validation.

Coordinator order: (1) preflight all identities/content/providers; (2) rpGM.reserveRestore gates the approved IDs; (3) public persistence imports exact logs, flush/close, cold Session validation; (4) each plugin restoreState reads actual destination canonical sessions via owner reader and validates refs before its atomic store write; (5) restore binding status stays restoring, safely resume Agent without prompting, apply optional session Loop policy; (6) activateRestored and mark complete. No invented source-manifest protocol or private log writes. A resumable journal tracks successful phases and its owned IDs.

## Amendment T3 — restored consumed-note evidence [FROZEN]

Context restore must apply the same semantic evidence rule as normal presentationOutcome: an assistant anchor alone never proves that a presentation was accepted or consumed an author note.

For every imported consumed outcome, validate (a) an actual canonical successful rp_present call/result lineage with the finishing presentationId in the supplied/imported Session log, and (b) the matching already-restored LastStep material's frozen contextPreparation.authorNote id/version/claimId, including rewrite lineage. A callback/status flag or a forged payload status is insufficient. The receipt material must be owner-authorized and belong to the same valid story/ancestry.

Distinguish stored audit from effective state: a genuinely accepted historical outcome whose source is now rolled back may remain as audit only when both proofs exist in the complete imported log/material; it cannot make the current note consumed. Effective consumed status requires its finishing presentation still active; otherwise R5 projects the matching latest note pending. If the exported prefix contains no such accepted source, do not invent the event or accept the consumed flag.

LastStep receipt/material state must therefore be restored before Context validates consumed claims. If absent/unavailable, Context restore rejects atomically with RESTORE_REQUIREMENT_MISSING and leaves its store unchanged; coordinator retains progress and restores the dependency first. Invalid supplied lineage is RESTORE_PAYLOAD_INVALID. No new source manifest or trust exception. Existing provider read methods and public canonical owner reader supply the evidence.

## Amendment T4 — document/extraction/provenance and derived cache [FROZEN]

Exact DTOs (all IDs nonempty strings; versions positive integers; hashes lowercase SHA-256 hex):

```ts
Document = {
 id:string,version:number,name:string,mimeType:string,
 sha256:string,dataBase64:string,databaseId:string,
 extractionVersion:string,chunkingVersion:string
}
ChunkRef = {
 documentId:string,documentVersion:number,chunkId:string,
 page?:number,paragraph?:number
}
Extraction = {text:string,chunks:[{ref:ChunkRef,text:string,sha256:string}]}
DocumentChunkProvenance = ChunkRef & {
 kind:'document-chunk',extractionVersion:string,chunkingVersion:string,textSha256:string
}
// Optional on an ordinary entry:
Entry.provenance?:DocumentChunkProvenance
DocumentContent = {document:Document,extraction:Extraction}
```

Document.sha256 hashes exact decoded original bytes; dataBase64 retains those bytes even for TXT/MD. Extraction is a derived versioned result, not a replacement original. Chunk.sha256 and provenance.textSha256 hash exact UTF-8 chunk text. page/paragraph, when present, are 1-based positive integers. chunkId is deterministic and unique within document version. PDF chunks must not mislabel text crossing pages as one page; split at page boundaries. TXT/MD use paragraph locations. Existing no-document entries remain valid.

Entry provenance is source metadata, not a model-editable field. If permitted content overlay edits change an extracted entry, provenance continues to point at its original chunk; do not alter raw document/extraction or pretend the edited content is an exact source quote. The effective content hash (not provenance.textSha256) drives embedding cache identity. Owner inspection can distinguish edited material from original chunk.

Vector cache may live in the same state.json under a distinct derived/cache schema. Cache writes use the same serialized atomic queue, read the latest state and preserve concurrent content changes, but DO NOT increment content revision. Content revision still tracks library/world/document/transfer transactions. Cache entries/index timestamps are omitted from exportContent and exported plugin content state; restore rebuilds them. Therefore a search/cache update alone cannot cause EXPORT_CHANGED or alter exported story facts. UI index-state notifications may be separate metadata invalidation. Effective branch/ref/disabled filtering remains mandatory regardless of cached rows.

## Amendment T5 — idempotency conflict codes [FROZEN]

A content import/coordinator requestId reused with different semantic payload returns REQUEST_ID_CONFLICT across Database, LastStep and StoryKit. Same requestId and same payload remains idempotent. expectedRevision changes alone are not a new content payload.

A restoreId reused with a different payload or target Session set returns RESTORE_ID_CONFLICT. Preexisting destination Session identity conflict uses the same established code. Keep unchanged-data guarantees. This does not rename launchId conflicts (LAUNCH_CONFLICT), version conflicts or revision conflicts.

## Amendment T6 — LastStep local restore and revision [FROZEN]

Accept LastStep-owned staging, validated merge, restore journal and directory switch for existing preset/receipt/draft stores. No need to consolidate these stores or create a generic transaction platform.

- Acquire a LastStep restore gate, reject new mutations/admissions, and drain owner work, writer/candidates, canonical-result handlers and store queues. Agent idle alone is insufficient. During commit reads see complete old state or busy, never a mixture.
- Stage only this owner's data and preserve unrelated LastStep stories/content. Validate merged stores and canonical references. No Session or other-plugin state writes.
- Journal remains discoverable outside the moved directory; staging/backup/journal use a verified owner-only same-filesystem namespace, never payload-supplied paths. Persist intent before rename. Two directory moves are crash-recoverable phases, not a claimed single OS-atomic operation.
- Startup recovers before opening services. After commit refresh store handles, bindings/admissions and caches before releasing gate. Clean backup only after validated success; failures retain recoverable state.
- Fault-inject before switch, between renames and after new-root installation; restart must expose complete old or complete restored state, preserving unrelated data.

contentRevision becomes a durable monotonic aggregate for preset/receipt/draft/restore persistence. Existing state().revision and legacy preset-edit expectedRevision remain unchanged. New transfer APIs compare expectedRevision against aggregate inside a shared short mutation gate, then obtain current preset revision for internal preset mutation; do not compare the two numeric domains or translate outside serialization. Transfer result revision is aggregate; legacy editing remains preset-local.

Reserve/persist next aggregate generation before corresponding mutation (failed-write gaps allowed), and do not expose that generation as stable while the write is in flight. Every supported persistence path participates, including canonical receipt status and draft edits. An in-memory counter bumped only after writing is insufficient. Network/model work stays outside the short storage gate. Export reads stable state and excludes journal/staging/backup artifacts. This is owner-local observable atomicity/recovery, not cross-plugin atomicity or a promise to arbitrary external file readers.

## Amendment T7 — seeded Session metadata and nonmutating Loop preview [FROZEN]

SavedStory.sessions items are now {header,events,inheritedEventCount:number}. inheritedEventCount is a required nonnegative integer taken from the source public observation/persistence metadata, bounded by events.length. Preserve it in public sessionPersistence.create(header,{inheritedEventCount}). Never infer it from longest common prefix, parent ID or event similarity. Missing authoritative export metadata returns EXPORT_SOURCE_METADATA_MISSING; do not guess a child seed count. Update unreleased schema-v1 fixtures to include it.

previewSavedStory stays read-only: no Session create/resume and no loop.inspect call for a nonexistent destination. It validates policy shape, known supported stage IDs, required installed services and available provider/model information through existing public capabilities. This build supports host.first/host.continuation, rp-context.prepare/rp-context.summarize and rp-last-step.migrate/assemble/render; unsupported external participant requirements are explicit, not assumed available.

Preview response adds deferredChecks:[{code:'LOOP_NODE_VALIDATION',sessionId:string,nodeIds:string[]}]. Only actual destination graph eligibility is deferred. supported:true with nonempty deferredChecks means the restore mechanism supports conditional staging, NOT fully verified route compatibility; UI must show that distinction. No new Loop API is assumed.

restoreSavedStory reruns all available identity/content/dependency preflight before writes, reserves execution gates, and imports/cold-validates into restoring state. After safe no-prompt Agent resume, existing loopStudio.inspect(sessionId) validates the actual nodes/control capability before savePolicy and activateRestored. Failure retains a pending/failed restore journal and inactive story; it never silently drops routes, chooses another model, or reports complete. This is an explicit deferred activation check, not a mutating preview or retroactive claim that all preflight passed. A future pure graph catalog is not required for this release.

## Amendment T8 — absent optional Context owner [FROZEN]

SavedStory.pluginState.context is explicitly null when Context was absent from the source story/export environment. Do not fabricate an empty owner payload. Omission in unreleased fixtures normalizes to null; new exports write null. If Context existed (even disabled), export its real versioned state.

For null, no Context restoreState call or requirement is manufactured. If destination has Context, preserve the no-Context behavior for restored sessions through its normal owner configure(enabled:false) API before activation; this is explicit destination configuration recorded in restore journal, not invented source state. Do not alter unrelated sessions. If destination has no Context, simply skip. Content/runtime dependencies must still allow GM stories without Context.

## Amendment T9 — restore identity/error precedence [FROZEN]

Each owner's restoreState follows this order:

1. Validate transport/minimal envelope enough to identify restoreId, a well-formed distinct sessionIds list, expectedRevision and serializable versioned state/payload. A malformed envelope returns the existing invalid-request/payload error; no log/material lookup.
2. Under the owner serialization/journal identity gate, check an existing pending/completed restoreId fingerprint and normalized Session set, excluding expectedRevision from payload identity. Any different payload or Session set returns RESTORE_ID_CONFLICT BEFORE deeper schema, canonical log or LastStep proof checks. An identical completed job is idempotent and does not reimport data.
3. For a new or identical unfinished job, perform full payload schema/cross-field validation and applicable revision checks.
4. Check required actual destination canonical sessions and owner dependencies, then semantic reference/note proof. Missing dependency returns RESTORE_REQUIREMENT_MISSING; invalid lineage returns RESTORE_PAYLOAD_INVALID.
5. Only after these pass, atomically merge owner data and record completion. Serialize identity check with the merge so competing calls cannot change the job's payload binding.

Thus same restoreId with a structurally valid changed note version reports RESTORE_ID_CONFLICT even if that version would fail proof; a changed Session set reports RESTORE_ID_CONFLICT even when those logs are absent. No new source manifest or weaker semantic validation is introduced.

## Amendment T10 — one proven host header normalization [FROZEN]

For current verified rc.3 cross-home/cold comparison, header.delegationDepth absent/undefined is semantically equivalent to numeric 0. This is the only newly allowed normalization, based on actual cold-prefix comparison evidence. null, string '0', nonzero values or other header changes are not equivalent.

Normalize this one header field for structural identity comparison; preserve/export original observed data and let the public host API apply its own default. Original events, seqs, message IDs, sources and tool metadata remain strictly equal. The only expected resume suffix remains the verified end-seed; historical execution counters must stay zero. Do not generalize into dropping unknown/defaulted fields or accepting arbitrary host rewrites.

## Amendment T11 — GM restore atomicity and export lock ownership [FROZEN]

GM.restoreState does NOT persist a new pending identity journal or increment its contentRevision before canonical proof. The coordinator's durable restore journal and the already-defined GM.reserveRestore execution reservation supply recovery/gating; do not add another proof-before-write exception.

Within GM's existing owner serialization queue: validate minimal envelope and existing restore identity (T9), validate full schema/revision, perform the available owner/canonical proof, then merge binding metadata and record restore result in one atomic state write. A proof failure leaves GM.restoreState's data/revision unchanged. Existing reserveRestore metadata is not erased. Proof code must not recursively enter the same GM store queue; use its captured state and the frozen owner-readable services. Agent-only checks remain deferred to activation as R20 already specifies.

StoryKit owns cross-component public Agent.runMaintenance coordination for export. GM.exportState must not nest another maintenance acquisition for the same Agent. It takes its own atomic store snapshot, checks that involved live Agents are not generating and checks relevant revision/source stability before/after; coordinator-held maintenance is not itself story generation. Changed state rejects EXPORT_CHANGED. Cold data is read through public owner readers without fabricating an Agent.

exportState is an owner-local snapshot method, not a promise of cross-plugin atomicity when called alone. StoryKit's orchestrator supplies the aggregate maintenance scope and final consistency checks. No browser/model-controlled 'alreadyLocked' flag, new Database API, or source manifest is introduced.

## Amendment T12 — saved pinned-asset dependency closure [FROZEN]

SavedStory includes the typed dependency closure of every pinned Character/Persona/template asset included in that snapshot, not only currently bound runtime libraries. A pinned Character.databaseRefs/profileRef remains an operational asset default; do not silently reclassify it as inert audit text or leave it dangling while claiming complete asset restoration.

For the example Character defaults WorldV1/StyleV1 but current launch sources=[] and profile=null: export and restore WorldV1/StyleV1 as library-only content dependencies, while the restored current story still has sources=[] and its actual GM builtin profile. Never auto-bind the unused defaults, apply their policies to current runtime selection, or make them a reason to require the current story to use that style. A library-only draft profile is preserved as draft; ready-profile validation applies to actual runtime binding, not every stored asset default.

Extend owner export seams additively (defaults empty):

```ts
rpDatabase.exportState({sessionIds,additionalDatabaseRefs?:[{databaseId,version}],signal?})
rpLastStep.exportState({sessionIds,additionalProfileRefs?:[{profileId,version}],signal?})
```

Their result shape remains {schemaVersion:1,revision,payload}. StoryKit derives these explicit refs from its own selected immutable assets/templates and requests them from each owner; it must not splice fabricated entries into another owner's private payload. Owners include exact requested versions plus their ordinary source/document dependencies, deduplicate, and preserve exact IDs for SavedStory restore. Existing callers without additional refs remain unchanged.

This closure covers defined typed refs only, not arbitrary strings/URLs in original provenance, scripts, or the user's entire library. If an explicit referenced version is missing at source, fail export with EXPORT_REQUIREMENT_MISSING and identify the safe ref; do not substitute latest, drop it, or mutate the pinned asset. Preview/export summary distinguishes current runtime dependencies from retained unused asset defaults.

Required test: snapshot the example with explicit empty sources/builtin override, restore into a clean home, verify the Character defaults resolve to their exact original library versions AND the current story still uses its explicit empty sources/builtin. No model/tool execution is caused by adding these passive dependencies.

## Amendment T13 — exact document-owner dependency, no implicit V1 [FROZEN]

Document.databaseId is an ID-only owner association; it does not declare an owner database version. When requested/captured database V2 already supplies that ID, it satisfies this association. Do NOT additionally export versions[0], V1 or latest merely because a document names the database ID. T12 requires closure of explicit typed dependencies, not every historical version of an entity.

Export only explicitly required runtime/additional database versions and their actual source/document dependencies. Preserve unrelated destination versions; an unrequested V1 must not become a new conflict just because V2 is restored. Genuine conflicts in a requested version or its actual immutable source/document still reject. If a different case requires an owner version not specified/satisfied by supplied refs, report the missing explicit dependency rather than guessing first/latest.

Required regression: additionalDatabaseRefs requests document library V2 only; exported database versions contain V2, not unrequested V1. With V2/source/document valid, an unrelated destination V1 difference does not block preflight solely through this invented dependency.

## Amendment T14 — informational dependency-use summary [FROZEN]

SavedStory may add optional dependencySummary with no content or authority:

```ts
DependencySummary = {
 databases:[{databaseId:string,version:number,uses:('current-binding'|'asset-default')[]}],
 profiles:[{profileId:string,version:number,uses:('current-binding'|'asset-default')[]}]
}
```

Deduplicate by ID/version and merge uses. current-binding means the SELECTED story's actual captured binding, not every historical/ancestor dependency. asset-default comes from included pinned assets/templates. An asset-default without current-binding is not used by the selected current binding; do not claim it was never used historically. This is not an exhaustive restore manifest.

StoryKit constructs the summary from its own typed pinned refs plus existing PUBLIC owner binding/effective responses captured consistently with export (Database effectiveV2.binding.sources and LastStep public state binding profileId/version). Never inspect or splice foreign exportState.payload to derive it. If a list cannot be obtained through a defined public response, omit the summary or show not recorded; do not infer it from private layout.

exportSavedStory keeps {snapshot}; the optional summary travels inside snapshot. previewSavedStory may return the same validated-shape dependencySummary for display. UI uses fixed labels and marks it recorded informational use. Legacy snapshots without it show not recorded. No model calls or restore mutations are needed for this display.

The summary cannot authorize, add/drop dependencies, satisfy requirements, change bindings, or replace each owner's real preflight/reference validation. Restores ignore it for execution. No new provider API or source manifest is introduced.

## Amendment T15 — initial style dependency and unattributed creation window [FROZEN]

SavedStory closure also retains each included GM StoryBinding.profile initial reference as library-only provenance. StoryKit collects it through the public GM binding DTO and passes it in LastStep.exportState.additionalProfileRefs. LastStep independently exports actual runtime bindings and profile/receipt dependencies. Do not fabricate its payload or replace current binding with initial style.

Informational summary current-binding labels come only from actual LastStep binding. asset-default labels retain their T14 meaning. An initial launch ref matching neither need not enter that nonexhaustive two-role summary; it may be shown in launch information. Do not mislabel it current or introduce a second style authority.

Public rc.3 persistence provides no durable restore-job ownership witness atomically coupled to create+flush. If the host created/flushed a destination Session but the StoryKit createdIds checkpoint was not durably recorded before crash, matching header/prefix is NOT sufficient to claim ownership on restart. Treat this as the narrow unsupported automatic-recovery window: preserve pending/conflict state with RESTORE_ID_CONFLICT and explain that creation attribution was not recorded. No append, overwrite, automatic deletion or completion claim for that unowned existing identity.

Recorded owned progress may continue under existing checks. The unrecorded window requires explicit owner resolution or an empty destination; do not add header markers, source manifests, private log edits or an invented host witness. Document this limitation honestly rather than promising unconditional crash-resumability. This does not invalidate the proven normal exact-ID restore or justify unsafe takeover of all matching sessions.

## Amendment T16 — retain initial GM source references [FROZEN]

For every included GM binding, SavedStory also collects initial binding.sources through the existing public GM.binding response. Merge their {databaseId,version} pairs with collectAssetDependencies' typed additionalDatabaseRefs and pass the deduplicated set to the existing Database.exportState. SourceBinding.key is launch provenance, not part of the library-version identity. No new DTO, API or manifest is introduced.

This works even when an included story has selected StoryKit assets but no StoryKit launch journal. Existing reviewed launch refs remain included; do not rely on journal presence as the only way to preserve GM initial sources. After owner restore, verify the same exact initial/source library refs through Database.database before activation, alongside existing current binding, asset-default and initial profile checks. Missing explicit export refs use EXPORT_REQUIREMENT_MISSING; unavailable restored refs remain a restoration requirement.

These additional initial versions are passive library content. Database's restored actual binding remains authoritative and is not extended/reset to the initial list. dependencySummary retains only its two existing roles: current-binding from actual Database, asset-default from actual asset/template defaults. An initial-only source need not appear in that nonexhaustive summary.

Required focused regression: launch with source A, legally add source B while keeping GM facts/receipts, then export/restore and activate with actual sources A+B and unchanged initial GM sources A. Also cover an initial-only library version whose StoryKit launch journal is absent: the exact library is retained without being rebound. This closes the cross-owner initial/current contradiction; it is not a new migration format.

## Amendment T17 — one aggregate maintenance owner [FROZEN]

T11's no-nested-maintenance rule also applies to Context.exportState and every owner exportState invoked by StoryKit's withIdleSessions. StoryKit alone acquires the cross-owner Agent maintenance scopes; each provider preserves its own serialized/stable state snapshot, authorization, reference validation and before/after source/revision checks. No provider attempts a second acquisition for the same Agent, and no caller-supplied alreadyLocked flag is introduced.

Minimal Context verification: an actual StoryKit-held maintenance scope reaches real Context export without a second acquisition; independent standalone export still rejects concurrent generation, source or revision changes and preserves authorization/canonical checks. Existing cold-child inheritance stays covered. Re-run the affected real seven-package SavedStory path with the corrected approved Context archive; neither a typed fixture nor omission of Context is a successful substitute.

## Amendment T18 — fresh seeded Session bootstrap order [FROZEN]

For the handle returned by THIS invocation's successful public sessionPersistence.create(originalHeader,{inheritedEventCount}), append the complete original contiguous events first, flush them, then invoke/persist the coordinator's onCreated checkpoint. Only afterwards read back/validate the prefix and perform the existing cold validation. Do not flush/read the incomplete empty seeded log as if it were already a valid source Session: its inherited end-seed marker is supplied by the original events.

This fresh-handle path does not open or claim a preexisting identity. Preexisting unowned IDs and create collisions still reject before append; an existing recorded-owned partial path retains its existing strict header/count/prefix rules. Keep original header, event sequence/content and inheritedEventCount unchanged, including the source inherited end-seed event. No fabricated marker, Session, private file edit or format-check bypass.

The onCreated checkpoint means actual successful public create + complete original append + flush, not advance reservation or proof of cold validity. A crash/error after creation and before that durable checkpoint remains T15's unattributed window: a later attempt must safely conflict if the identity exists without recorded ownership. Do not automatically delete, overwrite or recognize it by identical content. Mark imported/validated/complete only through the existing later checks, not merely onCreated.

Minimal native verification uses the actual seeded child from the real source snapshot: fresh create → original events → flush → checkpoint → strict read/cold/restart succeeds, inheritedEventCount and inherited end-seed unchanged, historical execution zero. Retain ordinary root-session and occupied-ID tests. This is a correction to public persistence bootstrap ordering, not a new restore format or a broader partial-log recovery promise.
