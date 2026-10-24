# RP Last-Step Runtime Plan

> Use superpowers:subagent-driven-development. The user confirmed migration, assembly and presentation only. This consumes an explicit public packet; it never performs simulation itself.

Goal: after main-agent tools finish, run permission-aware module assembly and isolated prose generation, with immutable source and canonical receipt metadata.
Spec: ../specs/2026-10-24-rp-last-step-design.md. Kernel/editor tasks in 2026-10-24-rp-preset-kernel.md.

- [x] Pipeline worker owns src/presenter.mjs, models.mjs, receipts.mjs and matching node tests. Red/green locks, revision conflicts, isolated writer, stage routes, thought filtering, cancellation, migration policy preservation and receipts.
- [x] Implement src/host.mjs, agent.mjs, routes.mjs, client.jsx, SDK-shaped tests, native registration and optional Loop Studio stages. rp_present is a sole terminal tool call and concludes only on success. No world-state writes.
- [x] Link RP Studio through optional contributed UI action and public canonical tool/result meta (no circular dependency/custom session event). Only bound last-step intervals suppress main-agent prose. Replays respect active tool calls/rollback.
- [x] Independent source/profile/model/UI tests cover cancellation. Self-contained tarball includes the migration skill. Official isolated keyless DSH acceptance covers import, locks, actual stage routes, immutable source, canonical tool narration, independent/combined UI and session-model inheritance. No paid requests.
- [x] Review/fix actual issues; build/typecheck/lint/relevant tests. Acceptance evidence is in docs/rp-last-step-acceptance.md.

Integration choice: the user authorized merging their own repository. Publish the verified branch through a PR, then merge into main.
