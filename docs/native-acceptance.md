# Native RP Studio acceptance

## RP Studio 1.4 / DSH 0.2.1-rc.3 — V6, 2026-10-27

The V6 nine-scenario native regression passed on the official DSH **0.2.1-rc.3** host: **9/9 scenarios, `fullChain.status: passed`, `finalAcceptance: true`**. The unchanged strict gate recorded **zero console/page errors and zero HTTP errors** in all five process segments. The subsequent public defaults readback passed against the **same run and two homes**, with **zero model requests in both readback processes**.

The run used harness commit `df50136c08a30e052d1ad33ca5845f207ac34730` and frozen local manifest `native-inputs-v6.json`, SHA256 `79aa41cb6b3602b3fa2a02cf27cdd6b0bd3b72f34c7ba6a2b078a620b765aeeb`. All seven actual archive hashes and six recorded files per installed package matched the frozen identities: **84 installed file hashes across the two homes**. Product owners, Session operations, factual tools and restore jobs came from these installed packages; only the bounded local model/retrieval providers were substitutes.

| Product | Version | Archive SHA256 |
| --- | --- | --- |
| RP Studio | 1.4.0 | `147d1441973cd4fa7e7a70e8fb4f012602dbe674143a75890d20f3d3d7d992fc` |
| RP Database | 0.3.0 | `3852262c3b7fa12af30fdba893ca5ce9ba3fe8c1502da19bef6f6098338cfc1a` |
| RP Context | 0.3.0 | `02639877cacb551f52c48f9d69acca20dcbb1eb56ab520fd3a16ff960645a446` |
| RP last step | 0.4.0 | `45d7bb2028d34266fc5b21382d97cebec0bf7665759861c60ba8fa38f6203716` |
| RP GM | 0.2.0 | `b4738a787e6f30ce2e00c81e11307a0e5c65071bbb2799acb1b51ff66de4b38a` |
| Story Kit | 0.2.0 | `d4ab826a1bd00337bb4f47a534ae6d186a0dbefa45fb5d4ee2b3e5a225335f5d` |
| Loop Studio | 0.1.0 | `aee2ccb93b23795139ae8a6dbd2a8e7f3300542e589ea8f7530326030f37f566` |

These hashes identify the archives used for native testing. Check downloaded release archives against that release's `SHA256SUMS.txt`.

The run covered the selected PNG opening, factual conflict recovery, Context/material policies, frozen writer retry, draft adoption, document caching, content-pack defaults and exact-ID second-home restoration. Both [supplementary combination gates](agent-rp/acceptance-boundaries.md) passed in this run:

| Gate | Actual V6 evidence |
| --- | --- |
| A1: pending same-job cold continuation and occupied identities | The real pending restore retained exact Session prefixes and gated GM bindings, then completed through actual Loop validation/activation after a process restart. A different job rejected occupied IDs without changing the public target witness. |
| A2: rollback followed by a new cold action | The actual cold action produced one new factual commit and one accepted presentation; the withdrawn queued action was excluded. Continued play, rollback and fork also passed after second-home restoration. |

Same-run readback confirmed exact pinned character defaults, Database/source/document bytes and draft profile V1 in the destination while source latest versions were V2. Both current minimal-story bindings retained explicit `sources:[]` and the ready builtin profile. The generic-false legacy UI issued no `reviewState` request and retained its LastStep reads.

All model starts, including failed attempts, totalled **80**: source before/after cold restart **61 / 10**, destination staging/cold restore/explicit continued action **0 / 0 / 9**. Totals by stage were GM 33, prepare 25, summarize 5, assembly 8, writer 6 and alternate writer 3. Historical read/restore work stayed at zero until explicit new actions. All five full-run browsers closed before their owned hosts; all five main and two readback processes cleaned up successfully. The observer sidecars retain 79 request-failure records and six explicit body-read failures, with no pending or truncated recorded bodies.

Retained local evidence for `old9-v6-final-20261027T082109284Z`:

- `full-result.json`: SHA256 `f4e7a0ed48cd5301f215cfe43c5c0c3e5fc4d55af52e4eea0722ac0f229ff3c6`.
- Same-run `public-defaults-readback.json`: SHA256 `d9a08d9ba189431311ba8fdd72af1fa03657fc18ed944935556a73061fa7c8b3`.
- Archive/installed-file identity record: SHA256 `e460b9c6adecf338df3fea793fd58b8f52bf1e6c564fe7180742688ba1c46978`.

See the [public owner/interface contracts](agent-rp/README.md) and [native harness commands](../scripts/native-integration/README.md), including the separate approval mode and passed-run-only defaults helper.

This acceptance covers the nine-scenario regression and its defaults readback. The later five-group approval/regeneration run is recorded separately below. Earlier V4 and V5 runs each passed 9/9 individual scenarios but failed the overall gate (`finalAcceptance: false`); their raw SHA256 values remain `bde0a0a9f04619f51982c99f47718f0c7fef246a849c34c7f67b9794a490ff32` and `315946d847792464c2010b25d543d9f65911f0512e6752a3b023d70cf16b5266`. V6 does not retroactively explain those failures or the historical V4 503 responses. The RP Studio 1.3 record below remains its own historical result.

## V6 approval and regeneration

On 2026-10-27, all **5/5 groups of actual functional assertions passed** in the official DSH **0.2.1-rc.3** run `full-approval-v6-plain-final-20261027T094036341Z-6f2747e2`. Its clean harness source was `22cfb231ed3f865ff92a1232fd93168439e2511e`. It used the same frozen V6 manifest, SHA256 `79aa41cb6b3602b3fa2a02cf27cdd6b0bd3b72f34c7ba6a2b078a620b765aeeb`, and the seven tested archive identities listed above. Archive and installed-file hashes also matched after shutdown.

| Group | Actual functional evidence |
| --- | --- |
| G1 — default OFF, pending and cold UI | One ordinary factual commit/presentation; enabling approval left a terminal pending candidate without changing current facts. Cold history/UI reads made no model requests; sidebar, full and narrow layouts passed. |
| G2 — custom, retry and approval ON | Exact human payload, retry and fact regeneration used the real owners and revise route. The public decision interruption window was hit; original-operation resume and replay made zero requests at every model stage. Writing continued explicitly. |
| G3 — approval OFF generation recovery | The public generation interruption window was hit. The original generation and separately mapped decision resumed without model requests or automatic writing; explicit writing then used the accepted facts. |
| G4 — frozen writer and current facts | Alternate writer routing reused frozen materials without factual, Context or assembly replay. Actual owner guards, scope disposal, next-turn Database facts and author-note timing passed. |
| G5 — forks, transfer and reading | Four causal cuts retained exact prefixes/control closures; child writing used a fresh child-owned operation. Opaque pending/completed transfers to different homes cold-read with all model stages zero, then actual route activation, UI approval and a new-state action passed. Ordinary legacy prose matched both the API and immersive reader; legacy and restored read-only passes kept events and counters unchanged. |

All model starts, including restricted main dispatches and failed attempts, totalled **72**: GM **23**, revise **3**, prepare **24**, summarize **4**, assembly **8**, writer **5** and alternate writer **5**. The six process segments recorded **13 / 42 / 0 / 7 / 0 / 10** starts. Console/page and HTTP error arrays were empty; all owned processes stopped. Both public interruption windows were observed, and the run's `limitations` and `limits` arrays were empty.

The zero-model claim belongs to the two settlement-resume endpoints and their replays. Custom facts bypass fact-model rewriting; normal approval/custom presentation can still call the main dispatcher, Context, assembly and writer. Frozen prose regeneration reruns only the writer generation stage, while any native main dispatch is counted separately. Settlement recovery does not start writing automatically; [the usage guide](agent-rp-integration.md#事实审批与两层重新生成) describes the explicit continuation.

Retained local evidence includes `native-approval-all-v6-plain-final-report.md` and its JSON companion. The raw result SHA256 is `b183000725ab6673b75def3ae3b3271db47b4223f6d92ce40dde5ec027754a83`; `source-identity.json` is `03fd5fc8db21b4eb376d7585c742bd55af285524101a211ced542c9104caf8d5`, and `raw-hashes.json` is `f15c35ff183df4718587eeafa55d18f9739169b0d8b42d2ac4dcd9090b7b3675`. All 38 saved-evidence checks passed. The raw runner deliberately retains `fullChain.status: checkpoint-passed` and `finalAcceptance: false`; the five passed functional groups do not claim final release/archive or CI acceptance.

The separate Story Kit V6 default-OFF transfer regression passed **13/13 existing phases**, including current-style B, source pins and zero historical model work during cold restore/read. Its raw SHA256 is `60f848230a1bcaf07182836fc0fc60d0fe321cbc321711004d651b63d6f8ab70`; browser and cleanup errors were empty. See [Story Kit's acceptance record](https://github.com/LiweiDonVee/dsh-rp-story-kit/blob/main/docs/acceptance.md). Those 13 phases, the nine-scenario regression above and these five groups remain separately attributed runs.

These are local deterministic model/retrieval fixtures exercising real installed product owners, native commands and Session logs, rather than a model prose-quality benchmark. Fact regeneration remains limited to the latest eligible ordinary round with captured baseline; old uncaptured receipts cannot be regenerated. Original prose may remain in the host's main history; the owners select current Database facts and effective Context/writer materials without rewriting native history. Final release archives and final CI are verified separately.

## RP Studio 1.3 / DSH 0.2.1-rc.3

Verified 2026-10-25 on official DSH **0.2.1-rc.3**: the rev5 seven-package native run exited 0, with **9/9 scenarios passed** and `finalAcceptance:true`. Source and destination used exclusive homes and SHA-named immutable archives. Each process verified the installed manifest, host/client entries and patch: **28 file hashes per home**. Only bounded local model and embedding/rerank providers were substitutes; all product owners and canonical Session operations were real installed packages.

| Product | Version | Archive SHA256 |
| --- | --- | --- |
| RP Studio | 1.3.0 | `66a278a984ff41e9b39e27b1694b307ab96d8d4950a43a7d490de67bb2c64ec4` |
| RP Database | 0.2.0 | `7e9a172b7e59a2dbe2014718974575dd9b5243f115f9a3d90fd750ca37738c78` |
| RP Context | 0.2.0 | `3b6fa7b2cae4864a718b4d48216257b2c1f27b52bacb406230e164fe06ce85cd` |
| RP last step | 0.3.0 | `f7a5b53a8f9996af3227953c2be985d5c070d4f22c50ed5c74117fd949635773` |
| RP GM | 0.1.0 | `9d2f8755d5f2b11c61917dabe5239ba24879be9be3a3885705ce0db4ee756880` |
| Story Kit | 0.1.0 | `0cb507b9208369f186d2a34e106caaf133d9b4ceb709d088837bfd02a97d6174` |
| Loop Studio | 0.1.0 | `aee2ccb93b23795139ae8a6dbd2a8e7f3300542e589ea8f7530326030f37f566` |

The approved manifest SHA256 was `53655f38a83bfac0ae520de729ae6d166041e7997a9d153627fb8416bbaecfdb`. The runtime package remained unchanged during acceptance and documentation completion.

| Native scenario | Result |
| --- | --- |
| PNG/full original, embedded worldbook, persona and selected opening | Passed; actual begin/present, no opening writer request |
| Factual commit and conflicting second submission | Passed; actual SDK isError/code/receiptId, unchanged post-rejection factual revision |
| Context search/read/history/material policies | Passed; qualified refs, outside search, atomic fact denial, actual readOnly rejection then legal working write |
| Pre-freeze failure and frozen writer retry | Passed; old snapshot/claim retained, new note pending, illegal dispatch rejected, correct native UI retry |
| Manual/generated candidates and adoption | Passed; stale version rejected, effective content replaced without facts/models, current render route used |
| Next action, branch, rollback and cold continuation | Passed; click-before baseline zero, old queued input excluded, exactly one new fact receipt and accepted prose |
| TXT/MD/PDF document cache | Passed; six exact chunk refs, first warm body vectors, cold query-only embedding, unchanged content revision |
| Content-pack launch | Passed; new IDs, draft defaults, explicit empty sources/builtin override |
| Exact-ID second-home saved story | Passed; passive exact libraries, pending cold same-job continuation, actual Loop/activation, read-only preview, occupied-ID rejection, continued play/rollback/fork |

The minimal saved story retained exact default world/document V1 and draft style V1 while source V2 versions existed. A separate bounded public readback reopened the same two homes, saved the original Database/source/document/profile responses, and confirmed that the restored current binding still had `sources:[]` and the builtin style. Both readback processes made **zero model requests** and stopped successfully. No private restore journal was read or edited.

Five main process segments retained complete model counts, including failed attempts and restricted dispatches:

| Segment | GM | Prepare | Summary | Assembly | Writer | Alternate writer | Total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Source before cold restart | 25 | 19 | 4 | 6 | 4 | 3 | 61 |
| Source after cold restart | 5 | 3 | 0 | 1 | 1 | 0 | 10 |
| Destination staging | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Destination cold same-job restore | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Destination explicit continued action | 3 | 3 | 1 | 1 | 1 | 0 | 9 |
| Total | 33 | 25 | 5 | 8 | 6 | 3 | **80** |

Proper frozen retry added one GM dispatch and one writer request, with no factual, prepare, summary or assembly rerun. Both first cold actions had zero counters immediately before the click and produced one new factual commit plus one accepted presentation. Restoring and resuming history itself generated no model/fact work.

All five main processes and both readback processes recorded empty browser-error lists and successful owned cleanup. Native sidebar/fullscreen/narrow screenshots were inspected in both homes: panel widths **647 / 1439 / 519 px**, height **962 px**, no horizontal overflow. The legacy preset navigation was exercised separately from generic GM play.

The reproducible command is:

```powershell
node scripts/native-integration/run.mjs --manifest <approved-rev5-manifest.json> --mode full --browser <installed-chromium>
```

Evidence was retained in the isolated `studio-full-rev5-20261025-a` run: `full-result.json`, individual scene JSON files, `pending-restore.json`, `saved-story.json`, six screenshots, redacted host logs and the independent `public-defaults-readback.json`. See the [native harness guide](../scripts/native-integration/README.md) for input requirements, reproduction and readback commands. The 40 harness tests and prior 292 related-package/23 plugin tests remain distinct from this native execution.

Earlier failed attempts remain failed evidence: rev3 exposed a Context cold preflight conflict; rev4 exposed rollback retaining a queued old action. Those results were preserved and were not relabeled as passes. Rev5 used the corrected packages with the original strict assertions, including [pending/identity and rollback boundaries](agent-rp/acceptance-boundaries.md).

## RP Studio 1.1 historical acceptance

This records the 1.1 release. For RP Studio 1.2 and the independent RP last-step plugin, see [current acceptance](rp-last-step-acceptance.md).

Verified 2026-10-23 with the official DSH 0.2.1-rc.2 runtime and a disposable home. The installable package contains bundled host/client entries, manifest, Cordis patch, README and license; no workspace packages or extra server are required at installation.

| Check | Result |
| --- | --- |
| Zero-warning lint | Passed |
| Workspace production build and TypeScript checks | Passed |
| All workspace unit tests | 256 passed, including 8 plugin carrier/route/registration tests and 5 native UI tests |
| Build-output cleanup contract | Passed |
| Existing browser E2E with Chromium | 11 passed |
| Real official DSH host | Tarball installation, activation and authenticated health passed |
| Real native UI | RP entry on blank session, preset discovery, story creation, archive creation/navigation, sidebar, fullscreen, 520px viewport, close/reopen passed; no browser errors or horizontal overflow |
| Synchronization/lifecycle | Regression tests cover stale session responses, first SSE connection handoff, completion during snapshot reconciliation, IME, retained failed drafts, abort and body-cancel cleanup |
| Legacy integration suite | 11/12 passed; the legacy desktop toolchain doctor requires the Electron executable, which was deliberately not downloaded for this native-only installation |

`pnpm plugin:package` creates `packages/plugin/artifacts/dsh-rp-studio-1.1.0.tgz`. `pnpm plugin:smoke` repeats real-host acceptance using the official launcher, a new `.runtime/native-smoke-*` home, synthetic RP preset and unused placeholder model credential; it sends no model prompt. Browser installation or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is required. Screenshots go under `.runtime/evidence/`; one is committed at `docs/images/native-rp-workspace.png`.

The existing Supervisor test now measures child-exit response latency from spawn. Measuring before startup also counted Windows CIM lock identity discovery and intermittently exceeded its 500ms budget before the child existed; the exit-handling budget remains unchanged.

The renderer dependency is pinned to a public immutable source archive, replacing a missing sibling directory. Its distributed package omits source CSS, so the standalone SPA includes the matching MIT-licensed stylesheet locally. Existing browser rendering and accessibility tests passed.

No paid generation or private RP card was used, and existing user profiles/sessions were not modified. Live model responses, card-specific RP runtime tools, and legacy Electron executable launch are outside this acceptance.
