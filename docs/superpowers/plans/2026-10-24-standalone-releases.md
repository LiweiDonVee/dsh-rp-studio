# Standalone plugin repositories and GitHub releases

**Goal:** Publish the two new independent plugins as complete GitHub projects and provide installable releases for all three projects, with user and developer documentation.

**Architecture:** Preserve the approved plugin interfaces and runtime code. Export each package into a standalone repository with its own lockfile, UI tests, native smoke fixture and build. RP migration skill ships in its owning repository. The existing Studio repository links the canonical projects and retains its verified integration snapshot.

**Authority:** The user explicitly requested GitHub push, new repositories for new projects, well-written documentation, and previously authorized merging their own repository. The established independent-plugin design remains unchanged.

**Spec:** `docs/superpowers/specs/2026-10-24-agent-loop-studio-design.md` and `docs/superpowers/specs/2026-10-24-rp-last-step-design.md`.

## Steps

- [x] Inspect exact GitHub repository/release names and account; reuse existing matching repositories without overwriting unrelated work.
- [x] Export `packages/loop-plugin` to `E:/WorkSpace/repos/dsh-loop-studio`, copy `apps/web/src/loop-workspace.test.jsx`, and adapt only repository-relative build/test/smoke paths. Add package metadata, pinned lockfile, CI, installation/usage, model routing, architecture/API, development, troubleshooting and changelog documentation.
- [x] Export `packages/rp-last-step` to `E:/WorkSpace/repos/dsh-rp-last-step`, copy its UI tests and migration skill, and adapt standalone build/test/smoke paths. Document ST migration, user policy, versions/overlays, public direction packet, native tool mode, optional Loop/Studio integration, recovery and data paths.
- [x] Verify each project from its own root with `pnpm install`, `pnpm check`, `pnpm package` and keyless official DSH smoke. Preserve existing unit cases; no new mirrored tests for documentation. Check local Markdown links and packaged files.
- [x] Commit/push the verified new projects, create public repositories matching the existing public Studio project, and check the remote heads. Update Studio documentation with canonical repository/download links; push and merge the documentation PR using exact head/base guards.
- [x] Create versioned GitHub releases with plugin tgz and SHA256SUMS assets, verify the remote assets against local hashes, and report all three repository and release URLs. Publish release notes with tested versions and relevant limitations; native-only installation does not require legacy Electron.

The copied integration snapshot is provenance from Studio commit `f0c7cbba469b28b730b8b895ed2250c1d235fc77`. Future standalone development uses the new repositories. No private presets, sessions, credentials or node_modules enter any repository or release asset.

## Published results

- [Loop Studio 0.1.0](https://github.com/LiweiDonVee/dsh-loop-studio/releases/tag/v0.1.0), source `9496e874fdb92b96d97a0ba077d950efdf0f85b6`.
- [RP Last Step 0.1.0](https://github.com/LiweiDonVee/dsh-rp-last-step/releases/tag/v0.1.0), source `9eb92e1b987c2aed5e2b1d7aead80133fc97b5c4`.
- [RP Studio 1.2.0](https://github.com/LiweiDonVee/dsh-rp-studio/releases/tag/v1.2.0), source `1a089c481bdc1cc40918dc997dc96562653fc752`; documentation PR #6 merged.

Both standalone projects passed Ubuntu and Windows CI. Local standalone and combined official DSH acceptance passed with deterministic models. All three public tgz downloads and checksum files were downloaded again and matched the verified local artifacts. Independent publication review found no actionable issues.
