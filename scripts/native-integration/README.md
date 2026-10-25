# Native integration harness

This harness installs reviewed product tgz files into new isolated official DSH homes. It does not import sibling product sources, provide fake product services, register fake `rp_present`/fact tools, or restore logs itself. Test substitutes are limited to bounded local LLM and embedding/rerank providers and public synthetic input material.

`prepare` copies immutable inputs without starting a host. `inspect` reads actual owner interfaces and StoryKit capability flags, checks Studio health, and can exercise the legacy native layout without a model call. Neither reports full acceptance. `diagnose` and `full` execute the nine real-product scenarios; diagnostics always retain `finalAcceptance: false`. Missing capabilities are `deferred`, failed scenarios remain failed and later unexecuted scenarios remain `not-run`.

## Inputs

Supply a coordinator-reviewed manifest. Package paths are relative to the manifest file or absolute. Hashes are required lowercase SHA256 values; the version is checked against the archive manifest. Checkpoint inputs may be a subset; `stage: final` requires all seven frozen products, including unchanged Loop Studio.

```json
{
  "hostVersion": "0.2.1-rc.3",
  "stage": "checkpoint",
  "packages": [
    {"name":"dsh-rp-studio","version":"1.3.0","path":"./accepted/studio.tgz","sha256":"<reviewed 64-character lowercase SHA256>"}
  ]
}
```

```powershell
node scripts/native-integration/run.mjs --manifest ./reviewed-inputs.json --mode prepare
node scripts/native-integration/run.mjs --manifest ./reviewed-inputs.json --mode inspect --ui --browser <existing-headless-chromium>
node scripts/native-integration/run.mjs --manifest ./reviewed-final-inputs.json --mode diagnose --browser <existing-headless-chromium>
node scripts/native-integration/run.mjs --manifest ./reviewed-final-inputs.json --mode full --browser <existing-headless-chromium>
node --test scripts/native-integration/*.test.mjs
```

Both scenario modes require a complete `stage: final` manifest. Run `full` only with the coordinator's currently approved final archive list; a revoked or superseded list may be used only for an explicitly authorized diagnostic. A manifest's stage alone does not establish approval.

Use `--cli` or `DSH_BIN` for a nondefault official launcher. The actual `--version` must equal `0.2.1-rc.3`. Before writing, the harness resolves the canonical checkout, physical `.runtime`, existing ancestors and target ownership; outward junction/reparse paths are rejected. Inspection creates its home exclusively: any existing `home-a` path is rejected, even without a root package manifest. `prepare` can still reuse verified immutable inputs. No production profile or default user sessions are read or changed.

Windows launcher argv containing literal `%` is currently rejected with `CLI_PERCENT_ARGUMENT_UNSUPPORTED`, rather than letting CMD expand `%VAR%` and silently change a file path. Use a checkout/run/launcher path without `%`; this is an explicit compatibility limit, not a claim to support general CMD escaping. Cleanup attempts both the owned browser and host even if one close fails, and reports cleanup errors.

## Evidence and cache correctness

Each source archive is read and hashed once, then written exclusively as `name-version-SHA.tgz`. Existing immutable bytes must still match. Installation uses this SHA-bearing file URL, not the mutable original path: DSH/pnpm can otherwise treat a same-version repack at the same URL as already installed.

After installation, the resolved actual package directory, package manifest, host entry, client entry and patch bytes are checked against the immutable archive. A new host process then reads the real service API/methods. Inspection records these in `inspection.json`. Scenario runs record each process segment, installed hashes, individual scenario status, provider counters, raw evidence and cleanup in `full-result.json`; `full-progress.json` preserves the last scenario checkpoint. Launch tokens are redacted from host logs.

The model fixture recognizes actual user/user-rpc sources, never runtime-context as player input. Each host caps model requests at 192 and retained metadata records at 96; local HTTP requests are separately bounded. It does not clone expanding histories. Its output is normal model text/tool-call blocks; installed product owners must perform every real action and canonical acceptance. No fixture unit test is proof that a native product workflow passed.

## Scenario evidence

The driver executes PNG/worldbook/persona/opening, factual commits and actual SDK error recovery, active Context search/history/note, pre-freeze and frozen failure retry, versioned drafts/adoption, next turn/branch/cold restart, persistent document caching, content-pack launch and exact-ID second-home restoration. It uses actual UI clicks for player actions, retry, manual adoption, branch, launch and archive entry actions. Read-only checks and fixture setup use authenticated owner endpoints.

For the pending restore case, a public AbortSignal interrupts a real restore while the local provider's model-metadata request waits before actual Loop validation and activation. Evidence includes the public four-field journal audit, exact Session set/fingerprint, unchanged input hash, actual target prefixes and gated GM bindings. After stopping that process, the same snapshot/job must complete through actual Loop inspection, policy restoration and GM activation in a new process. Under the reviewed attribution gates, this demonstrates persisted ownership sufficient for that continuation; it does not claim direct access to createdIds/internal progress, recovery from the unattributed creation window, or repair of an incompatible graph. The wait has a watchdog and cleanup releases it; no Loop method or result is replaced.

Every successful player action requires a new accepted fact receipt and canonical narrative, matching effective body, active GM, expected facts and actual dispatch/render increments. Intentional assembly/writer failures have separate assertions. Document-cache proof associates actual public document/chunk refs with their first warm HTTP body embeddings and search hits, then checks cold query-only embedding and stable content revision. Each process segment retains its final counters, browser errors and cleanup status; all segments contribute to the final verdict. Setup/read-only/negative owner requests use the browser context's authenticated API client; user actions still use real native clicks.

Restore completion must come from real StoryKit and all real state owners; pending/deferred Loop validation is never a pass. Final reports must distinguish the actual run's coverage from any separately accepted evidence for the exact same product hashes.
