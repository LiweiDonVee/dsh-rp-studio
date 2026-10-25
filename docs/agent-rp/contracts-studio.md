> Public copy of the frozen development design. See [status and versions](README.md); complete native acceptance is a separate gate.

# Studio integration contract v1 [FROZEN]

Frozen integration contract; complements the runtime contract and Studio integration guide. Studio is a native integration view, not a second source of state or an unrestricted RPC bridge.

## 1. Narrow owner action route

Studio may expose POST /api/rp-studio/actions through its authenticated DSH Connection. Every action is a statically enumerated case mapping to exactly one contracted owner service method. Allowed initial actions:

| action | fixed service method |
|---|---|
| gmState | rpGM.storyState |
| narratives | rpLastStep.narratives |
| presentationSummaries | rpLastStep.presentationSummaries |
| drafts / createDraft / editDraft / adoptDraft | corresponding rpLastStep method |
| retryPresentation / material | corresponding rpLastStep method |
| authorNote / setAuthorNote | corresponding rpContext method |
| exportReading / exportSavedStory / previewSavedStory / restoreSavedStory | corresponding rpStoryKit method |

Validate exact allowed DTO fields from the owner contract, reject unknown action/fields before dispatch, pass request AbortSignal, and preserve the owner's session authorization, revision, expectedNarrative and active-source checks. The server supplies trusted execution context if needed; browser JSON cannot choose agent object, stage, anchors, ownership, arbitrary service/method/path/URL or RPC namespace. No generic call(service,method,args) dispatcher. Missing service/method yields explicit capability unavailable; libraries/legacy reading remain usable. API responses are only the owner's defined DTOs, not raw store records.

Studio may host small transient selection/comparison/inspection UI or open the owning native panel. It must not duplicate asset, draft, note, material or restore persistence. Full content stays in authorized owner reads; generic notifications remain metadata-only. Entry/policy editing and content-pack composition stay in owner panels unless separately specified.

## 2. Verified native tabs

Read from current owner src/client.jsx exports; these are actual existing names, not invented routing:

| owner | TAB_KIND | TAB_ID |
|---|---|---|
| GM | rp-gm | dsh-rp-gm/workspace |
| StoryKit | rp-story-kit | dsh-rp-story-kit/workspace |
| Database | rp-database | dsh-rp-database/workspace |
| Context | rp-context | dsh-rp-context/workspace |
| LastStep | rp-last-step | dsh-rp-last-step/workspace |
| Loop | loop-studio | dsh-loop-studio/workspace |

Open via existing ctx.sidebarRight.openTab(TAB_KIND). Prefer owner-contributed rp.studio.workspace.actions buttons/callbacks; direct Studio buttons check actual client registration/capability. Missing tab is not auto-created as an empty imitation. Do not fabricate subview/presentationId deep links absent an owner contract. Opening a tab uses current host session; switching to another story must first use supported host session navigation. No imports of owner client source files.

## 3. Rollback transport compatibility

Existing POST /api/v1/sessions/:id/rollback result becomes additive:

```ts
RollbackResult = {accepted:true,sessionId?:string}
```

For legacy stories keep exactly {accepted:true}; existing runtime rollback behavior remains. For generic GM stories call authorized rpGM.rollbackStory and return {accepted:true,sessionId:childId}. Current client opens returned child when present; otherwise refreshes the existing story. No duplicate rollback action in the new route is necessary. Update this repo's strict response schema/types/tests to permit the optional field. This is not a claim that host supports in-place rewind.

Generic fork continues through the corresponding supported GM path and existing child navigation. Never make new generic stories call old rp-autoplay; honor capabilities.autoplay=false, while old story autoplay remains.

## 4. SessionDetail and failed-receipt UI

Keep current SessionDetail shape. Generic GM facts/capabilities may be represented as a derived, nonpersistent state.extensions.gm={schemaVersion:1,bindingId,scene,facts,capabilities}; source remains rpGM.storyState/Database. Basic visible scene/persona fields may be projected into existing state/card fields. Do not create a second state store or infer knowledge ACL.

Use runtime R13 presentationSummaries DTO. Failure rows are status failed/cancelled; button eligibility requires both canRetry and retryDispatch. Rendered is not necessarily canonical accepted. Completed audit receipts do not replace narratives() as current branch truth. A list refresh and operation error must handle eligibility changing while user clicks; no automatic fact rerun.

## Amendment ST1 — browser capability projection [FROZEN]

Add action capabilities to the SAME POST /api/rp-studio/actions route, input {action:'capabilities',sessionId?:string}. No new generic proxy or separate GET route required. If sessionId is supplied, authorize that story before session-specific checks.

```ts
StudioCapabilities = {
 schemaVersion:1,
 services:{
  gm:{available:boolean,apiVersion:number|null},
  storyKit:{available:boolean,apiVersion:number|null},
  database:{available:boolean,apiVersion:number|null},
  context:{available:boolean,apiVersion:number|null},
  lastStep:{available:boolean,apiVersion:number|null},
  loop:{available:boolean,apiVersion:number|null}
 },
 actions:{gmState:boolean,narratives:boolean,presentationSummaries:boolean,
  drafts:boolean,createDraft:boolean,editDraft:boolean,adoptDraft:boolean,
  retryPresentation:boolean,material:boolean,authorNote:boolean,setAuthorNote:boolean,
  exportReading:boolean,exportSavedStory:boolean,previewSavedStory:boolean,restoreSavedStory:boolean},
 story?:{generic:boolean,gm?:{rollback:boolean,fork:boolean,autoplay:boolean}}
}
```

The Studio server determines these from its fixed service map and actual methods/required dependencies, never arbitrary browser method names. apiVersion is the owner's explicit numeric field or null; do not infer a package version from method presence. Boolean actions mean the implementation/capability is available, not that any particular draft/ref/request is eligible. All owner checks still run at execution.

Owners must not advertise throwing placeholders as implemented capabilities; an explicitly disabled owner capability keeps the Studio action false. retryPresentation for a supplied session additionally requires R13 capabilities.retryDispatch. Without a selected session, story-scoped retry is false. Individual failure buttons still require that row's canRetry. Adoption target validity remains owner validation; the capability endpoint must not generate a model request.

Server service availability is not proof that a client tab is registered. The native Studio client uses owner-contributed slot callbacks or its actual sidebar tab registry for open-tab buttons. Do not expose fake tabs based only on this server response. Missing optional owners do not break legacy Studio browsing.

## Amendment ST2 — draft version forwarding

adoptDraft action requires expectedDraftVersion from the displayed persisted draft, alongside expectedNarrative. Strict route validation and client DTOs must include it; forwarding only draftId is no longer valid. A DRAFT_VERSION_CONFLICT leaves the current story unchanged and prompts reload/repreview.
