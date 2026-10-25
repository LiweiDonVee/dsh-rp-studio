> Public copy of the frozen development design. See [status and versions](README.md); complete native acceptance is a separate gate.

# P1–P6 contracts v1 — frozen Database foundation

Frozen development contract for P1–P6; media/P7 is excluded. Each plugin owns its state and public service contracts.

Current host is official DSH 0.2.1-rc.3; reference source is rc.2 at 687f282e8625c6b8d11ff58211a90524be2e4317. Label static and actual-host evidence separately. No frozen main-loop mutation, custom Session event type, NPC ACL, per-card runtime or source imports across repos.

## 1. Qualified references [FROZEN]

```ts
EntryRef = {sourceKey:string, entryId:string}
EntryVersionRef = EntryRef & {version:number}
SourceBinding = {key:string, databaseId:string, version:number}
BindingV2 = {schemaVersion:2,sources:SourceBinding[],factEntryRefs:EntryRef[]}
EntryView = ExistingEntry & {ref:EntryRef,sourceVersion?:number}
entryKey(ref) = JSON.stringify([ref.sourceKey,ref.entryId])
```

Source key identifies a stable story binding slot, not uploaded source UUID. Duplicate raw entry IDs across sources stay distinct. Source order controls iteration only, not truth precedence. Reserved sourceKey @session holds new story-local additions and GM state. Human source bindings cannot use it.

V1 migration: one source slot legacy, original baseline and anchored changes preserved; do not flatten effective fork state. Old v1 additions remain under legacy for compatibility. New v2 additions use @session. Preserve original source text, IDs, policies and pinned versions.

Add service API v2 beside legacy:

```ts
rpDatabase.apiVersion = 2
bindSources({sessionId,sources,expectedRevision,resetOverlay:false,signal?})
effectiveV2({sessionId,agent?,signal?}) -> {revision,binding,entries,notes,changes}
catalogV2({sessionId,agent?,signal?}) -> {revision,binding,entries:metadataWithRef[],notes}
readV2({sessionId,agent?,refs:EntryRef[],signal?}) -> {revision,entries}
searchV2({sessionId,agent?,query,limit?,signal?})
 -> {revision,candidates:[{ref,score,reasons}],required:EntryRef[],degraded:string[]}
patchV2({sessionId,agent?,expectedRevision,operations:ScopedOperation[],signal?})
```

ScopedOperation update/remove/note uses ref instead of bare id. add is {op:'add',entry:ExistingEntry}; always @session, no model-controlled ownership/source key. The model-facing tools may accept program-generated entryKeys, translated once at their boundary; typed service contracts use refs. Context's JSON planner uses entryKeys for shallow selectors.

Legacy catalog/read/search/patch retain one-source behavior; ambiguous multi-source calls return QUALIFIED_REFERENCE_REQUIRED. Never select a source by matching title.

Initial bind creates. Identical mapping preserves overlay. Retained slots with same database/version preserve causal changes. Removing/changing a slot with dependent changes returns BINDING_CHANGE_REQUIRES_RESET unless an owner explicitly supplies resetOverlay:true after the UI explains the discarded changes. Models cannot reset/rebind. Existing old bind action keeps documented reset semantics.

Disabled/readOnly/required apply to all paths including fact owner. Required selection unions refs. Returned snapshots detached; all writes revision checked. Fork/rollback retains source-qualified causal prefix.

## 2. Fact ownership and receipts [FROZEN]

GM owns interpretation and submission. Database remains sole world/entry store. Context is material preparation, not a second factual GM. Generic DB patch and material-stage operations cannot modify registered factEntryRefs; no NPC knowledge permissions are introduced.

MVP registered @session entries:
- gm.scene content JSON {schemaVersion:1,title:string,location:string,time?:string,presentActorIds:string[]}
- gm.facts content JSON {schemaVersion:1,items:[{id:string,text:string}]}

User policies always win. Protected refs do not grant access to disabled entries or bypass readOnly. New planner entries are working material, cannot register themselves as facts. Pure legacy Database/Context usage without a GM binding stays supported.

Trusted plugin-only service contracts (never expose stage/owner/anchors in tool JSON):

```ts
initializeStoryState({sessionId,entries:ExistingEntry[],factEntryRefs:EntryRef[],launchId,expectedRevision,signal?})
 -> {revision,factEntryRefs}
factAccess({sessionId,agent,signal?})
 -> {snapshot(),commit(FactCommitInput),getReceipt(id),currentReceipt(turnKey)}
materialAccess({sessionId,agent?,signal?})
 -> {snapshot(),search({query,limit?,signal?}),apply(entries,ops),select(entries,keys),commit({operations,expectedRevision,signal?})}
```

initializeStoryState is idempotent by launchId; it creates seed once and cannot overwrite an existing story. Facades bind trusted session/stage in closures. materialAccess checks registered refs at both staging and commit. Its snapshot is v2 effective shape; apply consumes planner operations whose selectors are entryKeys (translate to refs internally); select consumes entryKeys and returns EntryView[]. search returns {revision,candidates:[{key,ref,score,reasons}],required:[{key,ref}],degraded}. Exact facade shapes are for Context only; public searchV2 remains refs.

```ts
CanonicalSource = {assistantMessageId:string,callId:string,callSeq?:number,turnStartSeq:number}
FactCommitInput = {
 turnKey:string,source:CanonicalSource,expectedRevision:number,
 operations:ScopedOperation[],summary:string,packet:PublicDirectionPacket,
 kind:'turn'|'opening',openingText?:string
}
FactReceipt = {
 schemaVersion:1,id:string,sessionId:string,turnKey:string,source:CanonicalSource,
 kind:'turn'|'opening',databaseRevision:number,changeId:string|null,
 stateRefs:EntryVersionRef[],summary:string,packet:PublicDirectionPacket,
 openingText?:string,createdAt:string
}
```

PublicDirectionPacket remains Last Step's existing whitelist (playerAction,sceneInstruction,resolvedChanges,visibleConsequences,openHooks,proseConstraints,publicFactRefs,variables:string values). New receipt IDs are separate parameters/metadata, not smuggled into packet unknown fields.

GM derives turnKey/source from actual native execution and Session records: turnKey combines session ID and canonical turn/start seq, never provider callId alone. First active commit owns that turn. Identical duplicate returns existing receipt; conflicting second commit returns TURN_ALREADY_COMMITTED plus existing ID. Persist receipt and operations together in the existing Database queue/atomic write. GM must not maintain a duplicate fact store. A caller lost after commit can recover receipt without reapplying changes.

Validate source is active; getReceipt/currentReceipt reject inactive sources. Fork copies causal facts/receipts, not flat effective state; rewinding an inherited prefix removes later state/receipts. Writer failure does not roll facts back or permit resubmission. All input shape and owner/policy checks precede mutation. No semantic guarantee that arbitrary GM prose is true.

## 3. Coordination and downstream seams

Database owns sections 1–2 and the document/index services; these contracts do not transfer write ownership to consumers.

GM will add real native rp_begin_story and rp_commit_turn tools; Last Step adds exclusive rp_present({factReceiptId}) alongside legacy packet/rewriteOf. Opening receipt comes from selected owner-reviewed seed and is committed as exact text by the real rp_present call, not fabricated events. Ordinary receipts flow Context→modules→writer. Those downstream contracts are specified in contracts-runtime.md; Sections 1–2 remain frozen.

Changes to field names or semantics require an explicit contract revision. Actual rc.3 native verification required; old rc.2 source is reference only.

## Amendment A1 — DB implementer questions [FROZEN]

1. initializeStoryState requires an existing sources binding, but that story may already have ordinary overlay changes. Preserve those changes and append entirely new @session seed entries. Existing colliding seed IDs return SEED_CONFLICT, never overwrite. Same launchId and identical seed+fact refs replay the stored result with no write (including when caller repeats its now-stale revision). Same launchId with different payload returns LAUNCH_CONFLICT. A different initialization already owns the story: STORY_ALREADY_INITIALIZED.
2. turnKey is exactly JSON.stringify([sessionId,source.turnStartSeq]). Core verifies this equality; native factAccess also verifies an actual active assistant message and its real rp_begin_story/rp_commit_turn tool block/callId, matching canonical tool/call turn/step, and the actual enclosing turn/start seq. Model tool arguments cannot set this source. A normal receipt does not become a transferable permission for another session.
3. materialAccess.apply follows existing planner shape: operations update/remove/note use id whose value is program-generated entryKey, add remains entry; return {entries,notes}. select returns EntryView[]. Preserve rp_db_* tool names and entryIds/operations[].id fields; catalog/search add key/ref. Translate entryKey once at tool boundary. A bare legacy ID is accepted only in unambiguous legacy single-source mode; multi-source bare IDs reject. Typed v2 services always use ref.
4. Fact receipt fork projection preserves original canonical source and origin session identity in stored data; facade returns effective current-session ownership after validating inherited active sources. It must not reject valid inherited receipts merely because they were created in the parent, nor permit arbitrary unrelated-session IDs. Add originSessionId when projected sessionId differs; do not rewrite causal original anchors or turn keys.

## Amendment A2 — errors [FROZEN]

TURN_ALREADY_COMMITTED carries DatabaseError.receiptId for the existing active same-story receipt. Owner/model error projections whitelist receiptId with code/message; callers must not parse message text. Inactive/rewound source or receipt: INACTIVE_SOURCE. Missing receipt: RECEIPT_NOT_FOUND. currentReceipt with no active commit returns null. Never expose a receipt from an unrelated session through an error.

## Amendment A3 — disabled projections, reset, content revision [FROZEN]

- effectiveV2 without agent is authorized owner view and may show disabled entries. effectiveV2 with agent, factAccess.snapshot and materialAccess.snapshot return enabled entry bodies only. Underlying commits validate complete authoritative store/policies, so guessing a disabled ref never grants access. Snapshot binding refs may show policy references without leaking disabled content. Required+disabled contradictory policy never silently wins.
- resetOverlay:true does not clear initialized GM seeds/fact refs/receipts. A destructive source reset on a GM-initialized story returns STORY_RESTART_REQUIRED and changes nothing; compatible retained/additional sources remain allowed. Non-GM explicit reset retains existing semantics. A future explicit restart is a GM operation, not incidental Database rebind.
- Database and LastStep expose contentRevision({signal?})->{revision} for the content transfer provider seam. The pack coordinator reads each provider's revision and advances from successful import results; conflicts retain completed requestId/mapping entries and never overwrite/reimport blindly.

## Amendment A4 — preparation facade and empty sources [FROZEN]

materialAccess is explicitly version:2. Its apply AND commit.operations consume the same planner operation format (update/remove/note id=entryKey, add entry); translate once internally to ScopedOperation refs. Typed patchV2 remains ref-based. Do not send planner ids directly to typed service or infer version from snapshot JSON.

sources:[] is a valid bound v2 story using @session only, distinct from no binding. It supports P1 public sample without creating a permanent sample source database. Binding/effective/catalog/UI must not assume sources[0] exists.

## Amendment A5 — view key [FROZEN]

EntryView additionally includes key:string exactly entryKey(ref). Catalog/model metadata carries key/ref; raw id remains the author source entryId. Context v2 uses key for lookup/staging/selection and never treats raw id as globally unique. This is an additive view field, not a new source identity.
