# RP Studio Prompt Stack And DreamWhale Agent Design

## Scope

This change delivers two coupled capabilities:

1. RP Studio exposes a session-level prompt-method drawer with SillyTavern-style profile and entry selection.
2. The installed prompt preset library gains a separate `dreamwhale-v3-agent` profile derived from the DreamWhale V3 import, while the original `dreamwhale-v3-acceptance` profile remains byte-for-byte untouched.

The feature is local-only. The browser talks to the RP Gateway, the Gateway talks to DSH and the loopback prompt-presets service, and neither service exposes DSH session storage or prompt source content to the browser.

## Decisions

- The selected Studio UI is the persistent right-side companion panel (visual option B).
- Every new or unbound session starts with zero optional narrative methods enabled.
- The runtime core is always active and is shown as locked. It is not a checkbox and cannot be disabled.
- An empty optional selection is valid. Applying it resets the session to the card default, shows a warning, and keeps the runtime core active.
- Selection changes are session-scoped, version-checked, and marked “next turn”.
- The original DreamWhale import is immutable. The Agent edition is a sibling profile with its own version and content hash.
- ST JavaScript, regex scripts, Tavern Helper calls, network/file/tool macros, XML schemas, public chain-of-thought instructions, and ordinary chat framing are not executed or copied into the Agent edition.

## Architecture

### Prompt composition

The effective stack is:

```text
locked DSH Agent runtime
  + locked card base and card profile
  + optional session prompt profiles and entries
  + dynamic settlement/context state
  -> settlement pass
  -> direction packet
  -> render pass with render-safe entries only
```

Card `prompt-manifest.json` files declare `baseProfiles`, `cardProfiles`, and `optionalProfiles`. The Gateway reads this manifest only for local routing and returns sanitized profile metadata. Optional profile entry content never crosses the Gateway boundary.

The prompt-presets compiler gains two narrow composition flags:

- `renderOnly: true` entries are excluded from settlement sections but included in render sections when they are render-safe.
- `narrativeContractMode: inherit` lets an optional profile add entries without overwriting the card’s protagonist, POV, agency, or hybrid contract. Existing profiles without this field retain their current contract behavior.

The DreamWhale Agent profile uses both flags. Its entries are disabled by default, tagged as optional, and grouped into mutually exclusive methods where appropriate. Its text is normalized into direct DSH guidance with no ST macros.

### Gateway API

The Gateway adds a sanitized prompt contract to session details and exposes session mutation routes:

- `GET /api/v1/sessions/:id/prompt-presets`
- `PUT /api/v1/sessions/:id/prompt-presets`
- `DELETE /api/v1/sessions/:id/prompt-presets`

The PUT body contains `enabledEntryIds` and `expectedRevision`. The Gateway validates that every entry belongs to the card’s declared optional profiles, enforces single-selection groups, derives the full profile stack by adding locked core profile IDs, and writes the prompt-presets session overlay. An empty selection deletes the overlay and returns the card to its default stack.

The session detail contains only:

- prompt service availability and a path-free message;
- the global prompt-store revision;
- locked core profile labels/IDs;
- optional profile metadata and entry metadata (ID, name, group, selection, slot, tags, enabled-by-default, render-only); and
- the current enabled optional entry IDs and next-turn marker.

No prompt content, full profile documents, session binding internals, prompt source paths, or compiled system sections are returned.

The Gateway calls the prompt service at a loopback URL configured by `PROMPT_PRESETS_BASE_URL`, defaulting to `http://127.0.0.1:3091/prompt-presets/api`. Prompt service failure does not take down the narrative shell or DSH runtime; the drawer reports that optional methods are temporarily unavailable.

### RP Studio UI

The right-side inspector gains a `叙事方法` view opened from the existing panel control. It contains:

- a locked `Agent runtime core` row;
- optional profile sections with profile-level enable/disable controls;
- entry-level checkboxes for flexible injection management;
- group-aware selection behavior for single-choice methods;
- an explicit “下一轮生效” state after a change; and
- an inline warning when no optional method is enabled: the session is using only the Agent runtime core and card base.

The panel is available on desktop beside the public-state inspector and on mobile as a right-hand sheet tab. Existing narrative, status, rollback, fork, and autoplay workflows remain unchanged.

### DreamWhale Agent edition

The sibling profile preserves the useful DreamWhale patterns in Agent-safe form:

- experimental prose with concrete action, sensory consequence, vitality, hooks, and anti-cliche pressure;
- dialogue that carries its own meaning instead of explanatory tone labels;
- narrated input echo with limited protagonist improvisation and no player decision theft;
- slow scene pacing as an explicit optional method;
- dynamic paragraph rhythm without XML paragraph counting;
- a POV/person-reference anchor that defers to the card’s locked narrative contract; and
- a final prose quality pass that removes formulaic negation, repeated phrasing, abstract emotion labels, and knowledge-boundary violations without exposing its analysis.

The edition deliberately excludes DreamWhale’s assistant identity, “unrestricted” policy block, XML `DREAM_PLOT`/`DREAM_DISCUSS` protocols, ST history wrappers, global-variable initialization, format append scripts, public thinking requirements, `Main Prompt`, `Enhance Definitions`, and all external script execution.

## State and error behavior

- Default: no prompt binding and no optional entry enabled.
- Apply non-empty: save a CAS-checked overlay with the locked core profile refs plus the selected optional profile refs; return the new revision and `appliesFromNextTurn: true`.
- Apply empty: remove the session binding, show the empty-method warning, and continue with card defaults.
- Revision conflict: return a stable Gateway error; keep the editor’s unsaved selection and request a fresh session detail.
- Invalid entry/profile: reject with `bad-request`; do not write a partial overlay.
- Prompt service unavailable: keep DSH actions usable, mark the drawer unavailable, and never silently pretend an optional method was applied.
- Running session: changes may be saved because they affect the next turn; the current turn is not rewritten.

## Verification

The implementation is accepted only when all of the following are true:

- Prompt compiler tests prove `renderOnly` and `narrativeContractMode: inherit` behavior, including preservation of the HP and Zombie contracts.
- Prompt preset tests prove the DreamWhale Agent profile has no ST executable macros, no XML output contract, no ordinary chat `Main Prompt`, and all entries disabled by default; the original profile hash remains unchanged.
- Gateway tests prove profile metadata sanitization, default-empty state, CAS update, reset-to-card-default, invalid-entry rejection, and no prompt content leakage.
- RP Studio tests prove the drawer, locked core, entry toggles, single-choice groups, empty warning, next-turn label, error handling, and mobile access.
- Existing RP Studio unit, build, lint, and Playwright suites pass.
- Prompt-presets integration and the installed DSH preset mountcheck pass.
- A fresh snapshot records all modified source, installed preset, and installed prompt-profile artifacts before deployment.

## Explicit non-goals

This change does not edit DSH session files, migrate existing session history, alter card mechanics, change tool definitions, expose hidden state, or make DreamWhale content a mandatory global preset. The runtime remains the authority for agent behavior and canonical state.
