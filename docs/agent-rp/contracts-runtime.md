> Public copy of the frozen development design. See [status and versions](README.md); complete native acceptance is a separate gate.

# Runtime / presentation contracts v1 [FROZEN]

Complements contracts.md and contracts-story-kit.md. P1–P6 only, current actual host rc.3. Names below are implementation contracts. Host probes establish the specified rc.3 mechanisms; live acceptance must be distinguished from cold recovery and from complete product acceptance.

## StoryBinding and main GM

```ts
StoryBinding = {schemaVersion:1,id,sessionId,launchId,title,
 status:'prepared'|'starting'|'active'|'failed'|'restoring',
 character:{assetId,version,name},persona:{assetId,version,name,description},
 opening:{id,text},examples:string,sources:SourceBinding[],
 profile:{profileId,version},factEntryRefs:EntryRef[],createdAt}
rpGM.apiVersion=1
rpGM.startStory({launchId,title,character,persona,opening,examples,sources,profile?,initialScene,initialFacts,signal?})
 -> {binding,sessionId,status}
rpGM.binding({sessionId,signal?}) -> StoryBinding|null
rpGM.storyState({sessionId,agent?,signal?}) -> {binding,scene,facts,lastFactReceipt?}
rpGM.listStories({signal?}) -> {stories:[{sessionId,title,status,character,persona}]}
rpGM.presentation({sessionId,agent,factReceiptId,signal?})
 -> {factReceipt,packet,story:{title,character,persona,examples}}
```

Register one generic native GM preset via public ctx.agentPresets.register, create through session/create. Never per-card code/preset. Initialize source binding and owner-reviewed seeds, bind a ready LastStep profile, then queue first NORMAL native Agent prompt. launchId tracks one resumable startup; no duplicate sessions/seeds. Do not append into an empty Session: rc.3 cold recovery requires its normal initial protected system head.

Native tools:
- rp_gm_state({}) -> current state/revisions/current receipt.
- rp_begin_story({}) -> once-only opening FactReceipt. Seed/opening/kind/source taken from binding, never model JSON.
- rp_commit_turn({expectedRevision,scene?,facts?,operations?,summary,packet}) -> FactReceipt. Validate scene/facts schema, map to registered state entries, apply other permitted scoped operations, derive real canonical source/turnKey. No model-selected ownership.

Current turn's factual receipt exists before presentation. Repeating fact commit returns stable receipt or conflict, never replays mutations. If writer fails and user asks retry, main invokes existing rewriteOf route; no new rp_commit_turn. Fork binding preserves fixed assets and retrieves causal DB prefix. GM store contains bindings/launch status only, not duplicated fact state.

## Opening / terminal presentation

rp_present adds exclusive {factReceiptId:string} besides existing {packet} and {rewriteOf}. GM-bound fresh stories require an active owned factual receipt; non-GM old stories keep packet. Do not place ID into unknown packet fields.

LastStep calls rpGM.presentation for validation. kind=turn: existing Context→assembly→writer. kind=opening: exact owner-selected opening text is returned through the REAL native rp_present tool, no writer needed. It still uses receipt reservation and canonical tool/result acceptance; never fabricate tool/call or accepted metadata. Opening becomes normal formal history. Start status becomes active only after accepted opening. Observers may update metadata but not reentrantly append events.

rpLastStep.ensureBuiltinProfile({key,profile}) -> {profileId,version} is plugin-only. GM supplies one static simple ready profile with key dsh-rp-gm.default.v1 when owner did not choose a ready profile. Create once; return immutable original version; reject identity conflicts, never overwrite user content or auto-ready imported drafts.

## Narrative revisions and reader contract

```ts
NarrativeRef={sessionId,presentationId,assistantMessageId,callSeq,baseResultSeq,resultSeq}
NarrativeRecord={id,ref:NarrativeRef,turn,action,text,createdAt?}
// id = JSON.stringify([presentationId,resultSeq]); opaque program revision key.
rpLastStep.narratives({sessionId,agent?,signal?}) -> {records:NarrativeRecord[]}
```

Resolve actual assistant rp_present block, canonical call/result and effective surface. Compaction preserves originals; real replacements supersede them. For legal content replacement, read current message.content as adopted text. Original meta.rpLastStep.record.text remains the old text by host rule and identifies the root receipt only. resultSeq is current replacement, baseResultSeq original result. Accept sourceEventSeqs containing original call and shadowed result; remove old length===1/append-only assumptions, but validate complete identity/source chain and active branch.

Context summaries and representation plans use revision keys; UUID-only legacy cache can be reused only at original baseResultSeq. Never revive old summary after adoption. Context and Studio prefer optional narratives service; standalone/fallback parser must understand the same shape without sibling source imports.

## Draft API and legitimate adoption adapter

```ts
Draft={id,version,sessionId,basedOn:NarrativeRef,factReceiptId?,
 kind:'writer'|'manual',text,status:'draft'|'generating'|'ready'|'failed',createdAt}
createDraft({sessionId,basedOn,instruction?:string,signal?}) -> Draft
editDraft({sessionId,draftId,text,expectedDraftVersion,signal?}) -> Draft
drafts({sessionId,signal?}) -> {drafts:Draft[]}
adoptDraft({sessionId,draftId,expectedDraftVersion:number,expectedNarrative:NarrativeRef,signal?}) -> {narrative:NarrativeRecord}
retryPresentation({sessionId,presentationId,signal?}) -> dispatch result
```

These methods belong to rpLastStep and owner routes. Draft generation uses frozen receipt/material/modules and writer only. Distinct draft events, never normal narrative completion. Manual edits are human-owned with expression-only UI guidance; changing facts routes to rollback/branch, no compulsory semantic verifier.

Only the latest formal result with no downstream factual/narrative work can be adopted. Expected ref/version must match again at execution. Unadopted drafts never affect Context or story. Competing adopts serialize. Another candidate for the same root turn can be selected only against the newly current ref. No fact/GM/material regeneration.

**Frozen rc.3 adapter decision:** use owner commands/execute (argument agentId) -> registered command handler -> public Agent.followup creates a real maintenance turn -> scoped agent/pre-step listener performs the content-only replacement inside that open turn -> returns reject so no LLM/tool simulation runs. Native host ends that maintenance turn as blocked; retain this truth. Adoption operation has its own confirmed successful command/result. Do not falsely label host turn completed, and do not turn this administrative marker into a fictional failed action. Studio reads actual effective result and refreshes.

Replacement preserves tool/result data and metadata except message.content; sourceEventSeqs include original call and shadowed result. Public Session append is allowed only through this verified open-turn path; idle append was live-valid but cold-invalid. Must reproduce durable rc.3 acceptance, fork before/after and restart with unchanged fact/writer/model counters. Remove scoped listeners on completion/failure/cancel/unload; owner operation rejects if story starts running or source changes before replacement. No broad permanent pre-step interception.

retryPresentation dispatches the REAL native rewriteOf workflow and retains active failed-family eligibility; it cannot bypass checks by directly committing a writer.

## Material inspector / author note

```ts
AuthorNote={id,text,version,status:'pending'|'claimed'|'consumed',claimedBy?:string}
rpContext.setAuthorNote({sessionId,text,expectedRevision,signal?}) -> {revision,note}
rpContext.authorNote({sessionId,signal?}) -> AuthorNote|null
rpContext.prepare({...existing,presentationId,factReceiptId?,story?})
rpContext.presentationOutcome({sessionId,presentationId,status:'accepted'|'failed-before-freeze'|'failed-after-freeze',signal?})
rpLastStep.material({sessionId,presentationId,signal?})
 -> {presentationId,packet,factReceiptRef?,storySnapshot?,contextPreparation,compiled,models,status}
```

Claim next author note at material capture. Canonical acceptance consumes. Writer failure/retry retains same note/snapshot. Failure before freeze releases. New note version cannot mutate an existing snapshot; claimed note is not silently applied to unrelated next factual turn. Explicit owner replacement/reset is allowed; outcome notifications idempotent.

Context consumes materialAccess with planner entryKeys and frozen v2 refs. Fact writes forbidden by executor. Snapshot inspection reads stored exact input, never reconstructs from current DB. Show candidate/selected refs, history representations, modules, models and chars; only actual reported token usage. No invented reasoning trace. Body goes through authorized owner request, SSE/Loop remains metadata.

## Studio integration

Use optional rpGM.listStories/binding/storyState to discover/display new generic stories; preserve old preset/rp-state paths. Use optional rpLastStep.narratives for effective adopted prose and draft/material owner actions. No model prompt parsing to guess story identity. Each new plugin also owns a functional native panel if Studio is absent.

## Amendment R1 — author note lineage [FROZEN]

Context preparation returns optional authorNote:{id,version,claimId}, where claimId is its initial presentationId. Frozen retry preserves this metadata. presentationOutcome additionally accepts claimId; LastStep passes the actual finishing presentationId plus frozen claimId. Accepted retry consumes that original claim, not an unrelated new note. If human replaced the note meanwhile, only the matching old note version/claim is consumed. Pre-freeze release and duplicate outcome events remain idempotent. This is a plugin-only service, not an owner/model action for declaring success.

## Amendment R2 — exact small DTOs / lifecycle [FROZEN]

BuiltinProfileInput={name:string,entries:ExistingProfileEntry[]}; ensureBuiltinProfile receives only {key,profile:BuiltinProfileInput}. Helper controls id/version/status/sourceId, creating an immutable ready builtin without using imported arbitrary code. Never accept those identity fields from caller profile. GM default has simple static render/shared prose rules only.

GM launch journal may store fingerprint, reserved sessionId, progress, binding and accepted receipt/source pointers without persisting initialScene/initialFacts. Partial start resumes only when owner provides the same fingerprint-matching launch request (StoryKit can reconstruct its reviewed immutable template). Once initialized, rp_begin_story obtains reviewed state from Database, not a second seed truth store. Check reserved session existence before session/create because create may allocate a different ID if the requested one already started.

Context uses v2 facade only when rpDatabase.apiVersion===2; facade.version===2 explicit. Prepare result.database in v2 is {binding:BindingV2,revision,entryRefs:EntryVersionRef[]}. Legacy facade retains old {databaseId,version,revision,entryRefs:[{id,version}]} shape for compatibility. LastStep public material refs must accept both tagged shapes without erasing source keys.

Author note claim occurs during initial prepare capture BEFORE its first summary/GM model call. Capture claim+context revision consistently in store queue. Prepare returns top-level authorNote:{id,version,claimId}; its text is provided separately to the material GM as authorNote and appended to final guidance with an explicit owner-writing-guidance label. It never becomes a fact entry. R1 governs lineage consumption.

“failed-before-freeze” means before LastStep has a complete compiled writer snapshot, even if Context already prepared its materials. Assembly failure therefore releases note for a future attempt; failure after compiled snapshot keeps it for writer-only retry. Context failure before returning also releases its own claim. LastStep outcome notification is idempotent and can use claimId=presentationId if Context failed before returning metadata.

Context adds owner material({sessionId,presentationId,signal?}) as a narrow authorized proxy to rpLastStep.material. Missing service returns MATERIAL_UNAVAILABLE, not reconstruction from current DB. Its panel defaults to IDs from active rpLastStep.narratives; failed/older receipt inspection belongs to the LastStep receipt/draft page and is labeled audit, not active story. No generic arbitrary service forwarding.

GM presentation accepts the latest active unresolved FactReceipt even if a new native host turn was opened only to recover/present it; it need not equal the current tool turn number. It must still belong to current story, be active, and not be superseded by later accepted fact/narrative work. This prevents writer/module failure recovery from forcing fact resubmission. Canonical retry-family rules continue to apply.

## Amendment R3 — fact reference and no-Context writer input [FROZEN]

material().factReceiptRef is an optional string exactly equal to FactReceipt.id/factReceiptId, not a second state object. Session scope is enforced by the owner request and original receipt ownership.

A GM-resolved story snapshot (title,character,persona,examples) is frozen into the LastStep receipt as storySnapshot and passed as a separate story input to assembly/writer even if rpContext is absent/disabled. Context.prepare receives the same detached snapshot when present. It does not become extra unknown packet fields or live database access. Draft/retry reuses frozen storySnapshot. This ensures basic character/persona presentation is not accidentally dependent on optional Context.

## Amendment R4 — generic story fork/rollback [FROZEN]

```ts
rpGM.forkStory({sessionId,atSeq?:number,signal?}) -> {sessionId,binding}
rpGM.rollbackStory({sessionId,signal?}) -> {sessionId,binding}
```

Use proven public session/fork and preserve the original story. rollbackStory chooses the valid prefix immediately before the latest ordinary (not opening) FactReceipt's canonical turn/start. It creates/switches to a child, not a fabricated in-place truncate API. Never rewind opening to an invalid empty protected-head state. Studio opens the returned child session and explains preserved original branch; old preset/runtime rollback path remains unchanged.

GM storyState returns capabilities:{rollback:boolean,fork:boolean,autoplay:false}. P1–P6 does not introduce a new autoplay driver. Do not dispatch old rp-autoplay to generic GM; keep existing old-story autoplay working. Native ordinary player actions provide continuous play.

Child inherits fixed asset binding, projected Database facts, Context plan and correct LastStep profile/overlay before play. LastStep adds plugin-only inheritSession({parentSessionId,sessionId,signal?}): verify actual child ancestry; initialize only unbound child; use profile/overlay captured by latest formal narrative inside child prefix, falling back to parent's pinned profile with empty overlay only when no captured composition exists. Never use a later parent overlay that lies outside the fork prefix, and never overwrite an existing child binding.

For inherited formal narratives, LastStep may read original immutable parent receipt material only after verifying real child ancestry and active canonical rp_present root in that child. New drafts/adoptions belong to child. Do not reject legitimate inherited root merely due parent receipt.sessionId, and do not permit arbitrary unrelated session receipts. Failed retry families remain session-local; child can present inherited active unresolved facts through factReceiptId without reapplying facts.

## Amendment R5 — author note branches [FROZEN]

Claims and accepted outcomes carry actual source anchors and are projected through active branch. Rewinding their source returns the same latest owner note version to pending; it never overwrites a newer owner-created note/version. Author-written pending text is configuration, not an established fact.

On fork, first project parent's note against child active anchors. Only a pending projected note is copied as a new independent child note ID. Do not inherit parent claimed/consumed lineage. Frozen receipts retain their note snapshots for audit and same-story retries. Accepted outcome must match actual active finishing presentation (including rewrite lineage) and the captured claim/version; callbacks alone are not proof of acceptance.

## Amendment R6 — public fact association and candidate evidence [FROZEN]

publicReceipt and canonical meta.rpLastStep.record include factReceiptId?:string for opening, normal turn and rewrite. NarrativeRecord includes the same optional field. GM validates the actual canonical narrative chain and looks up that receipt kind to recognize opening; never infer opening from body text. Owner material's factReceiptRef string is an alias of that ID, not duplicated fact storage.

Context preparation may return top-level candidates:metadataWithRef[] as an immutable bounded final candidate-pool snapshot: key/ref/title/version/mode/readOnly plus score/reasons only when actually known. No entry body. Do not reconstruct later from current DB or invent complete retrieval/thinking history. UI labels it recorded candidate pool; old receipts without candidates show not recorded. Preserve selected entry refs independently.

## Amendment R7 — scoped adoption and restore activation [FROZEN]

The adoption pre-step hook must match the pending owner operation and its specific maintenance request/turn, not intercept whichever ordinary user turn happens to arrive next. If request identity cannot be established or target source changed, reject the owner action without changing story content. This scoped listener always disposes. No permanent catch-all pre-step suppressor.

rpGM.activateRestored({restoreId,sessionIds,signal?}) validates matching own restoring bindings and required data before restoring their prior playable status. This plugin-only service is called by StoryKit after all canonical and plugin-state validation, optional route restoration, and safe Agent resume setup. It does not submit a prompt or rerun opening.

## Amendment R8 — reviewed seeds and selected character source [FROZEN]

initialScene exactly matches gm.scene object {schemaVersion:1,title,location,time?,presentActorIds:string[]}; initialFacts matches gm.facts {schemaVersion:1,items:[{id,text}]}, not a bare array. Commit scene/facts use same shapes.

StoryBinding.character and presentation.story.character additionally carry optional description/personality/scenario strings from selected immutable asset version. This is pinned source context, not a second mutable world state. Accepted current Database facts/packet take precedence. Imported system/main overrides and arbitrary extensions are excluded; examples remain style, never events. Do not drop basic card description at launch merely because it is not a worldbook entry. Longer worldbooks stay in Database. Inspector labels fixed source vs current facts and does not claim material maxChars bounds all module/system/packet bytes.

## Amendment R9 — actual models and accepted note evidence [FROZEN]

Candidate writer generation, like existing failed rewrite, freezes original material but resolves CURRENT render route/base selection once per new request and records actual model. Do not always choose receipt.models.render and thereby ignore user Loop/model changes. In-flight selection remains frozen.

material({sessionId,presentationId}) is owner-authorized read for successful, failed and retry receipts; not-yet-frozen fields may be absent. Context accepted outcome first verifies actual active finishing narrative, then reads that receipt's stored contextPreparation.authorNote to match id/version/claimId. It does not trust callback fields alone. No read causes model generation or reprepare. Old owner notes are consumed only through their exact captured version/claim.

## Amendment R10 — restore reservation [FROZEN]

rpGM.reserveRestore({restoreId,sessionIds,signal?}) creates only execution-gate reservations for preflight-approved destination IDs; no world state or fake session events. Native GM admission rejects play while reserved/restoring. activateRestored clears matching reservation only after all required state validation. A different restore job cannot take it. Snapshot restore currently targets generic GM stories with supported plugin owners; unsupported legacy/private runtime requirements must be reported rather than assumed restored.

## Amendment R11 — manual drafts, model provenance and UI retry [FROZEN]

Draft publicly adds models?:{render:{provider:string,model:string,reasoningEffort?:string,maxTokens?:number}}, using the existing safe model config projection only. No credentials/provider payload. A manual edit may preserve original generation models as provenance, labeled original generation model rather than claiming current hand-edited text came directly from it.

createDraft adds kind?:'writer'|'manual' (default writer), text?:string (manual only). Manual creation makes no model call; absent text copies CURRENT effective narrative body. editDraft changes kind to manual. Writer candidates resolve current render selection once as R9; manual edits never resolve/run a model unnecessarily.

retryPresentation uses real native execution, not forged assistant/tool records. If a main model is needed to dispatch the native rp_present, temporary executor-level tool scope for that specific owner request permits only rp_present and enforces rewriteOf equals the chosen eligible failed ID; new packet/factReceiptId and fact tools are forbidden. A prompt request alone is not the enforcement. Request model returns without tool -> clear failure with no factual writes. Scope must release on all outcomes. An unsupported restriction API must be reported and the affected capability disabled rather than weakening this rule.

This means UI retry may make one main-model dispatch request plus the writer request; it still never reruns fact tools, Context selection or module assembly. Documentation/counters must distinguish dispatch from the writer-only presentation stage. Do not advertise zero dispatch calls unless actually implemented through a verified legitimate mechanism.

## Amendment R12 — one formal presentation per fact receipt [FROZEN]

rpGM.presentation resolves only active latest UNPRESENTED factual receipts. Its return type is unchanged; LastStep handles an identical already-complete context reservation before asking GM to resolve a fresh presentation. It checks canonical rpLastStep narratives' factReceiptId, not just a lagging binding flag. An already formally presented factReceipt cannot create a second new presentation under a new tool context: FACT_ALREADY_PRESENTED. A later accepted factual receipt supersedes an older unresolved one: FACT_RECEIPT_SUPERSEDED. Failed frozen rewrite remains its separate eligible family path, and successful expression alternatives use Draft APIs, not new rp_present.

Opening begin is idempotent across recovery turns: use its active existing opening receipt and never reset state. The initial opening cannot be presented twice merely because metadata status update was delayed. User factual changes use a new ordinary commit or rollback/fork, not reopening the seed.


## Amendment R13 — public presentation summary for unified UI [FROZEN]

```ts
PresentationSummary = {
 presentationId:string,
 status:'prepared'|'assembling'|'rendering'|'rendered'|'complete'|'failed'|'cancelled',
 createdAt:string,canRetry:boolean,
 retryBlockCode?:string,errorCode?:string,factReceiptId?:string,rewriteOf?:string
}
rpLastStep.presentationSummaries({sessionId,signal?})
 -> {presentations:PresentationSummary[],capabilities:{retryDispatch:boolean}}
```

Owner-authorized, body-free list ordered newest first. presentationId maps to receipt.id; callers never inspect private receipt shape. canRetry comes from the SAME active-source/compiled-material/family eligibility used by actual retry execution, not merely status=failed. retryBlockCode is the safe code from that predicate when false; no exception bodies/provider payload. errorCode is existing sanitized stored failure code only. This list is an audit/operation list, not current story narrative projection; use narratives() for accepted active prose.

retryDispatch is true only when the owner retry operation actually has supported scoped execution and this session can use it. Pending/unverified stub must not claim true. Studio enables retry only when canRetry && retryDispatch and not busy/running, and passes presentationId to retryPresentation. All eligibility is rechecked on invocation; list is not authorization. Verification does not waive the scoped-tool guarantee.

Keep old state(id,signal) and existing publicReceipt id fields compatible. Studio uses this new narrow method, never guesses state().presentations internal structure or reads receipt files. Owner routes may expose exact presentationSummaries action; no argument allows source/stage/agent overrides.

## Amendment R14 — restored author-note state [FROZEN]

See transfer T3. Restore cannot validate consumed notes using assistant anchors only. Actual canonical finishing presentation plus LastStep frozen note/claim evidence is required, with active-versus-audit projection preserved. A cold child export must first ensure/project its inherited state; missing pending note/settings from skipped inheritance is an implementation defect, not an allowed transfer variant.

## Amendment R15 — note evidence may be derived without new stored DTO [FROZEN]

Context need not add a persisted finishingId if it derives the finishing presentation unambiguously from validated canonical narrative lineage and LastStep frozen material matching authorNote id/version/claimId. The accepted presentation can be a retry whose presentationId differs from claimId. An assistant/outcomeAnchor alone is never sufficient.

Effective consumption requires a currently active successful call/result lineage. If only tool/result is removed while the assistant remains, the old accepted outcome cannot remain effective consumed; R5 projection restores the matching latest owner note pending. Historical consumed audit proof still follows transfer T3. Ambiguous/missing evidence must not select an arbitrary receipt: normal acceptance rejects PRESENTATION_NOT_ACCEPTED; invalid restore payload rejects RESTORE_PAYLOAD_INVALID, or RESTORE_REQUIREMENT_MISSING when the owner material dependency has not been restored. Test retry-ID difference, result-only removal, and the no-rp_present forged consumed payload.

## Amendment R16 — actual fixed story material [FROZEN]

material() adds optional storySnapshot using the already-frozen title/character/persona/examples shape from the receipt. Return detached owner-authorized data only; never reconstruct from current binding/assets or include unknown imported extensions. Inspector labels it fixed source context, distinct from accepted facts/selected materials. Old receipts lacking it show absent, not fabricated values. Existing material fields remain unchanged.

## Amendment R17 — adoption binds the previewed draft version [FROZEN]

adoptDraft now requires expectedDraftVersion:number in addition to draftId and expectedNarrative. It is the persisted draft version the owner actually previewed. Owner checks both draft version and narrative source inside the serialized adoption operation and immediately before canonical replacement; intervening edit of the same draft yields DRAFT_VERSION_CONFLICT (409), with no replacement. Never adopt newer text by ID alone.

Studio, LastStep routes/API/UI and any narrow forwarding DTO must include the required field. Unsaved local edits must be saved/repreviewed before adoption; stale error retains local preview for explicit reload, never silently upgrades its version. This is a correction to the previously under-specified DTO, not additional draft-generation scope.
