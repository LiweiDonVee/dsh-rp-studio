# Native RP Studio 1.1 acceptance

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
