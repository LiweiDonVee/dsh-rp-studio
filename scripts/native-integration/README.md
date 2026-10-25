# Native integration preparation

This harness installs reviewed product tgz files into a new isolated official DSH home. It does not import sibling product sources, provide fake product services, register fake `rp_present`/fact tools, or restore logs itself. The only replacement is a bounded local LLM adapter. Embedding/rerank and full scenario orchestration remain for the separately dispatched final run.

The current commands are `prepare` and `inspect`. Neither executes or reports the full ST-B acceptance chain. `inspect` reads the real installed owner interfaces and StoryKit capability flags, checks Studio health, and can exercise the unchanged legacy native layout without any model call. Missing capabilities are recorded as `deferred`; every full scenario remains `not-run`.

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
node --test scripts/native-integration/*.test.mjs
```

Use `--cli` or `DSH_BIN` for a nondefault official launcher. The actual `--version` must equal `0.2.1-rc.3`. Before writing, the harness resolves the canonical checkout, physical `.runtime`, existing ancestors and target ownership; outward junction/reparse paths are rejected. Inspection creates its home exclusively: any existing `home-a` path is rejected, even without a root package manifest. `prepare` can still reuse verified immutable inputs. No production profile or default user sessions are read or changed.

Windows launcher argv containing literal `%` is currently rejected with `CLI_PERCENT_ARGUMENT_UNSUPPORTED`, rather than letting CMD expand `%VAR%` and silently change a file path. Use a checkout/run/launcher path without `%`; this is an explicit compatibility limit, not a claim to support general CMD escaping. Cleanup attempts both the owned browser and host even if one close fails, and reports cleanup errors.

## Evidence and cache correctness

Each source archive is read and hashed once, then written exclusively as `name-version-SHA.tgz`. Existing immutable bytes must still match. Installation uses this SHA-bearing file URL, not the mutable original path: DSH/pnpm can otherwise treat a same-version repack at the same URL as already installed.

After installation, the resolved actual package directory, package manifest, host entry, client entry and patch bytes are checked against the immutable archive. A new host process then reads the real service API/methods. `inspection.json` retains each archive hash and installed file hash, actual rc.3, fresh host PID, observed capabilities, zero-model-call counter, browser errors and optional sidebar/full/narrow metrics. Launch tokens are redacted from `host.log`.

The model fixture recognizes actual user/user-rpc sources, never runtime-context as player input. It records only bounded metadata/snippets, caps total requests and does not clone expanding histories. Its output is normal model text/tool-call blocks; the installed GM/Database/Context/LastStep must perform every real action and canonical acceptance. No model fixture result is proof that a native product workflow passed.

## Remaining final acceptance

After accepted final inputs arrive, the separately dispatched full driver must execute PNG/worldbook/persona/opening, factual commits, active Context search/history/note, frozen failure retry, versioned drafts/adoption, next turn/branch/cold restart, document caching, content-pack launch and exact-ID second-home restoration. Restore completion must come from real StoryKit and all real state owners; pending/deferred Loop validation is never a pass. No script may substitute fake owner success to fill a missing capability.
