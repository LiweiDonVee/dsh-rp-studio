> Public copy of the frozen development design. See [status and versions](README.md); complete native acceptance is a separate gate.

# Story Kit / content-pack contracts v1 [FROZEN]

This complements contracts.md and spec.md. Service name rpStoryKit, apiVersion 1. Owner-only routes never execute source instructions. Interfaces may be implemented incrementally; changing DTO fields requires an explicit contract revision.

## Public service and owner actions

```ts
state({signal?}) -> {revision,characters:AssetSummary[],personas:AssetSummary[],capabilities}
asset({kind:'character'|'persona',assetId,version?,signal?}) -> {revision,asset}
source({sourceId,signal?}) -> {source:{id,format,rawText?,dataBase64?,sha256,provenance}}
importAsset({format:'json'|'png',rawText?:string,dataBase64?:string,name?:string,expectedRevision,signal?})
 -> {revision,assetId,version,sourceId,diagnostics,embeddedWorldbooks:EmbeddedWorldbook[]}
createCharacter({character:CharacterInput,expectedRevision,signal?}) -> {revision,assetId,version}
saveCharacter({character:Character,expectedRevision,signal?}) -> {revision,assetId,version}
createPersona({persona:PersonaInput,expectedRevision,signal?}) -> {revision,assetId,version}
savePersona({persona:Persona,expectedRevision,signal?}) -> {revision,assetId,version}
importWorldbook({assetId,version,descriptorId,expectedRevision,expectedDatabaseRevision,signal?})
 -> {revision,assetId,version,databaseRef:{key,databaseId,version},diagnostics}
launch({launchId,character:{assetId,version},persona:{assetId,version},openingId,
 sources:SourceBinding[],profile?:{profileId,version},initialScene,initialFacts,signal?})
 -> {sessionId,binding,status}
exportPack({characters:AssetRef[],personas:AssetRef[],templates:StoryTemplate[],signal?}) -> {pack}
previewPack({pack,signal?}) -> {diagnostics,counts,requirements}
importPack({pack,expectedRevision,signal?}) -> {revision,mappings,diagnostics,reviewRequired}
exportReading({sessionId,format:'markdown'|'text',signal?}) -> {fileName,mimeType,text}
```

CharacterInput/PersonaInput omit id/version/sourceId; new IDs assigned by store. Saves require explicit existing base version. JSON input uses rawText only; PNG uses dataBase64 only. Export pack is content only, not save-game data. Native routes POST /api/rp-story-kit/request accept exactly {action,...methodFields}; SSE /api/rp-story-kit/events emits metadata invalidation only. Launch and reading require real session owner authorization in GM/LastStep services.

```ts
EmbeddedWorldbook = {id:string,sourceId:string,sourcePath:string,name:string,rawText:string}
```

rawText is the full original JSON card string (for PNG, exact decoded JSON metadata); Database's existing importer extracts the worldbook. sourcePath identifies data.character_book, character_book, etc. Original PNG bytes remain in StoryKit source. Do not reserialize just the book and falsely call it the original card. importWorldbook checks selected immutable asset version, finds descriptor, calls rpDatabase.import({rawText,name,expectedRevision:expectedDatabaseRevision}), then creates a new asset version with linked databaseRef under key card. If Database unavailable, preserve descriptor and explain deferred action. No automatic database import during raw card parsing.

## Content pack v1

```ts
AssetRef = {assetId:string,version:number}
PackAsset = {kind:'character'|'persona',asset:Character|Persona,source?:SourcePayload}
PackDatabase = {id:string,version:number,database:DatabaseVersion,source?:SourcePayload}
PackProfile = {id:string,version:number,profile:ProfileVersion,source?:SourcePayload}
StoryTemplate = {id:string,title:string,character:AssetRef,persona:AssetRef,openingId:string,
 sources:SourceBinding[],profile?:{profileId,version},initialScene,initialFacts}
Pack = {format:'dsh-rp-story-pack',schemaVersion:1,assets:PackAsset[],
 databases:PackDatabase[],profiles:PackProfile[],storyTemplates:StoryTemplate[],
 resources:[{id,mimeType,sha256,dataBase64}],requirements:string[]}
SourcePayload = {format:string,rawText?:string,dataBase64?:string,sha256:string,provenance?:object}
```

Pack-local identity includes original ID and version; references resolve within this pack. Import generates fresh destination IDs and returns mappings keyed by JSON.stringify([oldId,oldVersion]); do not overwrite by name. Remap all character databaseRefs, profile refs, template refs and resource refs. Preserve policy flags and source original content. Imported profiles remain owner-review drafts until explicitly made ready; imported scripts/unknown extensions stay inert. No credentials, absolute paths, executable modules, local provider config or running logs.

Provider seams implemented in their owning plugins:

```ts
rpDatabase.exportContent({databaseId,version,signal?}) -> {database,source?}
rpDatabase.importContent({database,source?,requestId,expectedRevision,signal?})
 -> {revision,databaseId,version,sourceId?}
rpLastStep.exportContent({profileId,version,signal?}) -> {profile,source?}
rpLastStep.importContent({profile,source?,requestId,expectedRevision,signal?})
 -> {revision,profileId,version,sourceId?,reviewRequired:true}
```

ImportContent creates a new native ID/version1, preserves provided effective version content and inert provenance separately. requestId is owner operation idempotency, not model input; same payload retries return same mapping, conflicting payload rejects. Different imported versions may become separate destination records; mappings make this explicit. Import never silently marks a foreign profile ready.

P6 full save-game recovery is a separate Snapshot DTO/host capability, not this content Pack. Exact-ID public persistence restore has early positive rc.3 evidence, pending complete plugin/fork tests. No implementer may improvise event-ID remapping or private log writes.

## Amendment SK1 — summaries/capability shape [FROZEN]

AssetSummary={assetId,version,name,sourceId?,avatarResourceId?}.
capabilities={databaseImport:boolean,packExport:boolean,packImport:boolean,launch:boolean,readingExport:boolean}.
Flags describe actual currently available required service capabilities, not optimistic future support. Export/import pure assets may work without external providers; a pack needing missing Database/profile services reports that requirement during preview.

Read provider contentRevision() before imports, use returned revision for subsequent operations. Persist coordinator import progress by requestId plus mappings; restart does not discard successful IDs. Recoverable revision conflict is surfaced with retained progress. No cross-repo import of a provider store file.

## Amendment SK2 — reviewed seed and character handoff [FROZEN]

launch.initialScene/initialFacts are runtime R8 exact schemaVersion1 objects. Resolve selected Character version to character:{assetId,version,name,description?,personality?,scenario?}, excluding unreviewed prompt overrides/extensions. Persona includes selected description. Evolving state remains Database. Asset fields must actually affect GM play, not merely appear in editor.

## Amendment SK3 — seed validation belongs to the kernel [FROZEN]

StoryTemplate pack validation must use the same exact runtime R8 scene/facts object validator, not merely object/defined checks. Reject bare fact arrays, wrong schemaVersion, invalid field types or duplicate fact item IDs before any import write. Launch reuses this validator rather than relying on UI-only checks or silently normalizing an invalid pack. Existing test fixtures with bare initialFacts arrays are obsolete and must be corrected.

## Amendment SK4 / provider documents — explicit content field [FROZEN]

Do not hide an active document/extraction bundle inside source.provenance. SourcePayload/provenance remains original inert audit data and is preserved unchanged.

Extend the Database content provider additively:

```ts
DatabaseContent = {
 database:DatabaseVersion,source?:SourcePayload,documents?:DocumentContent[]
}
rpDatabase.exportContent({databaseId,version,signal?}) -> DatabaseContent
rpDatabase.importContent({database,source?,documents?,requestId,expectedRevision,signal?})
 -> {revision,databaseId,version,sourceId?,documentMappings?:object}
PackDatabase = {id:string,version:number} & DatabaseContent
```

DocumentContent is defined in transfer T4. exportContent includes exactly the immutable document versions referenced by that exported library version. Missing referenced document/chunk is an export/import validation error, not a dangling successful import.

Content-pack import creates fresh database/document IDs and maps incoming document/version pairs using JSON.stringify([oldDocumentId,oldVersion]) to {documentId,version}. Remap database Entry.provenance and every Extraction chunk ref; Document.databaseId points to the new database. Preserve the raw bytes, extraction text, hashes, parser/chunking versions, and original SourcePayload/provenance unchanged as audit data. Validate each remapped reference resolves to its corresponding document/chunk and hash; do not mutate original source provenance to make new IDs look original. Same requestId replay returns the same mapping.

SavedStory exact-ID restore is different: it preserves document IDs/versions and canonical references with collision checks, as in transfer T2. Both transfer modes omit vector cache and rebuild it. Empty/absent documents keeps earlier ordinary DatabaseContent fully compatible.

## Amendment SK5 — saved-story capabilities and profile precedence [FROZEN]

StoryKit capabilities adds required booleans savedStoryExport, savedStoryPreview and savedStoryRestore. They describe actually implemented/available mechanisms and dependencies; per-payload conflicts and deferredChecks still require preview. False for absent/unimplemented capabilities, never optimism based on a stub.

launch.profile and StoryTemplate.profile allow ProfileRef | null | omission. Precedence: explicit ProfileRef wins; explicit null selects GM builtin; omitted field inherits selected Character.profileRef if present; only when both are absent does it choose GM builtin. Linked missing/unready/draft profiles must surface the owner profile resolution/ready error; do not silently ignore the link, auto-ready it or fall back. StoryKit resolves this selection before GM launch. GM.startStory itself retains optional ready ProfileRef and builtin when absent; StoryKit translates explicit builtin/null to that omission after resolving precedence. Pack parsing preserves null versus absence.

## Amendment SK6 — resumable reviewed launch and scoped document maps [FROZEN]

Before first GM startStory call, StoryKit persists an immutable normalized reviewed launch request and fingerprint in its own launch journal. This is startup configuration, not a second copy of evolving facts. Preserve selected asset versions, opening, sources, resolved profile choice, initialScene/initialFacts and launchId; no credentials/signals. Resume uses this stored request and the same launchId, never current React state, latest asset versions or newly guessed seed.

state() adds pendingLaunches:[{launchId:string,title:string,status:'prepared'|'starting'|'failed',sessionId?:string,errorCode?:string,createdAt:string}]. Completed launches are excluded. Add owner resumeLaunch({launchId,signal?})->{sessionId,binding,status}. It validates dependencies and calls GM with the original reviewed normalized request; no field-edit override in resume. A changed setup is a distinct new launch, not a mutation of the old fingerprint. GM idempotency prevents duplicate session/opening. Missing source versions remain a visible requirement, not a substitute.

Database provider documentMappings is Record<JSON.stringify([oldDocumentId,oldVersion]),{documentId:string,version:number}>. StoryKit preserves it UNDER the particular source database-version mapping:

```ts
mappings.databases[JSON.stringify([oldDatabaseId,oldVersion])] = {
 databaseId:string,version:number,sourceId?:string,
 documentMappings?:Record<string,{documentId:string,version:number}>
}
```

Never flatten document maps globally: two exported versions of one database may reference the same old document/version yet import into distinct new databases/documents. The provider already remaps its own entries/extraction refs. SourceBinding remap explicitly selects {key:oldBinding.key,databaseId:mapping.databaseId,version:mapping.version}; never spread documentMappings/sourceId into SourceBinding. Original SourcePayload/provenance remains unchanged audit data.

## Amendment SK7 — SavedStory assets retain usable defaults [FROZEN]

Follow transfer T12. SavedStory coordinator collects typed default database/profile refs of included pinned assets/templates and passes additionalDatabaseRefs/additionalProfileRefs to the corresponding owner exportState services. Keep these separate from actual launch sources/profile; explicit overrides remain unchanged. Do not turn dangling Character defaults into unspecified audit-only requirements or manufacture provider payloads.

## Amendment SK8 — dependency display only

Use transfer T14's optional SavedStory dependencySummary or fixed labels over the same public typed refs. Do not read Database/LastStep private payloads. Current binding and pinned default are different roles; an unused default stays a passive restored library dependency. Missing historical summary is shown as not recorded, never reconstructed by guessing.

## Amendment SK9 — restored initial/current profile distinction

SavedStory gathers GM initial profile refs via public binding and requests them as additional LastStep library dependencies. Actual runtime style remains LastStep-owned. current-binding summary must not be populated from the GM launch reference when a later rebind is active. Follow T15 for the unrecorded host-creation crash window; matching source data is not ownership evidence.

## Amendment SK10 — launch configuration is not an asset default [FROZEN]

A launch journal's reviewed request is startup configuration under SK6, not an included StoryTemplate asset merely because the user reviewed it. Its request.sources/profile must not, on that basis alone, produce dependencySummary uses:'asset-default'. This clarifies T14/T15 and R22; it does not change dependency closure or introduce a new summary enum.

- current-binding is derived only from the actual captured public Database/LastStep binding.
- asset-default is derived only from explicit typed default references in the included pinned assets or actual included StoryTemplate records. A stored launch request is not such a record.
- Required launch configuration and initial GM profile references remain in owner-requested export/restore closure as passive library dependencies. If they have neither existing summary role, omit them from this nonexhaustive summary and show them only as initial/reviewed launch configuration when that view is present. Omission from summary does not authorize omitting the dependency itself.
- Deduplicate by exact ID/version and assign roles by actual occurrences. An initial profile may also receive asset-default if the same exact ref really occurs in an included asset default, or current-binding if it really is current; never infer either role from its launch-journal presence.

Example: Character default Style, explicit launch Initial, later LastStep rebind Current. Preserve all required exact refs. Display Style as asset-default, Current as current-binding, and Initial only as initial configuration (unless it independently has another real role). No new manifest, enum or restore authority is added. A label-only mismatch with complete correct closure is a presentation defect, not a reason to reopen the core restore contract.

## Amendment SK11 — initial source closure

Follow R23/T16: collect included GM binding.sources through the public binding DTO in addition to own asset/template/launch refs, export exact versions through existing additionalDatabaseRefs, and verify them after restore. Keep actual Database bindings and summary roles unchanged. No new store, field or owner API.
