# Native RP Studio acceptance

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
