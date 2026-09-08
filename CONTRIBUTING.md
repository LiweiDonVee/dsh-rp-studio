# Contributing

Use Node 24.x and pnpm 11.9.0. Install with `pnpm install --frozen-lockfile`, install Chromium with `pnpm exec playwright install --with-deps chromium`, then run `pnpm verify`.

Keep this framework empty: no bundled cards, characters, worlds, prompts, personal paths, credentials or artwork. Use short synthetic records in tests and keep fixtures out of production imports. Preserve versioned API envelopes and runtime compatibility tests. Describe behavior changes and verification in your contribution.

Changes to vendored renderer files must retain its MIT license and update UPSTREAM.md with the exact source and any local changes. Do not infer third-party provenance or redistribute material without permission. Contributions are under this repository's MIT license.
