# Dashboard `.svelte` component testing (A3) — design

**Status:** approved
**Date:** 2026-07-21
**Sub-project:** A3 of the mutation-testing effort (A1 done → A2a done → A2b done → **A3** → B)

## Context

A1/A2 hardened the API suite; A3 turns to the SvelteKit dashboard. Every
existing dashboard test targets a `.server.ts` load function, the api layer,
or hooks — all in Vitest's default **node** environment. The **8 route
`.svelte` view components** (plus `Chart`/`ErrorState` in `$lib`) have **zero**
rendered-component coverage, and the infrastructure to render a Svelte 5
component under test does not exist in the repo yet.

A3 stands up that infrastructure and covers the components to the same
standard A1/A2 set: every assertion must be falsifiable by a recorded source
mutation ([[flackyness-test-assertion-standard]]).

## Decisions

**D1 — Hybrid approach: extract pure view-logic to `$lib` (node-tested) AND
render components in jsdom (branching/template behavior).** The mutation-worthy
logic divides in two. Pure functions (`formatDate`, `formatDuration`,
pass-rate, error title/icon, nav href, trend-direction maps, the trend tooltip
formatter) get the *hardest* coverage by extraction + node unit tests with zero
DOM mocking — and extraction removes real duplication (`formatDate` is copied
across **six** components). Everything that genuinely lives in a template
(empty states, `canMute` gating, three-way load branches, per-row rendering)
gets a jsdom render test. Chosen over pure-render (misses nothing but needs
mocking everywhere) and pure-extract (never tests template wiring).

**D2 — jsdom, not happy-dom.** jsdom is the SvelteKit test default, more
spec-complete, and the compatibility risk of happy-dom isn't worth its marginal
speed edge for a first setup.

**D3 — Full coverage: all 8 route components + `ErrorState`.** Both chart pages
(`Chart` stubbed) and both `$page`-store shells (`+layout`, `+error`) are
included, not deferred.

**D4 — Two-project Vitest config; the existing node tests are untouched.** A
`client` project (jsdom, `*.svelte.test.ts`) and a `server` project (node,
`*.test.ts` **excluding** `*.svelte.test.ts`). Every current test keeps running
in node exactly as today.

**D5 — No `@testing-library/jest-dom`.** `@testing-library/svelte`'s queries
(`getByText`/`queryByRole`/…) + plain `expect` are equally biting. Dropping
jest-dom removes a dependency (and its 7.0.0 is a <24h-old fresh major that the
`minimumReleaseAge: 1440` rule would reject anyway). Two mature deps only:
`jsdom@^29.1.1`, `@testing-library/svelte@^5.4.2`.

**D6 — Extractions are behavior-preserving refactors.** A3 is the first A-phase
to change product source. Each callsite swaps an inline function for the import
with no rendered-output change, fenced by mutation proofs, the existing E2E
suite (8 tests), and `svelte-check`.

**D7 — Every assertion ships a recorded mutation proof** (A1's standard).

## Infrastructure

- **Deps** (dashboard `devDependencies`, pinned one release back if a chosen
  version is <24h old at install): `jsdom`, `@testing-library/svelte`.
- **`vite.config.ts` → `test.projects`:**
  - `client`: `environment: 'jsdom'`, `include: ['src/**/*.svelte.test.ts']`,
    `resolve.conditions: ['browser']` (so Svelte 5 resolves to client `mount`,
    not SSR render-to-string), `setupFiles` wiring `afterEach(cleanup)`.
  - `server`: `environment: 'node'`, `include: ['src/**/*.test.ts']`,
    `exclude: ['src/**/*.svelte.test.ts']`.
- **CI:** no workflow change — `pnpm --filter dashboard test`
  (`svelte-kit sync && vitest run`) runs both projects; jsdom only needs to be
  installed.
- **Shared mocks (built once, reused):** a `Chart.svelte` stub component, and
  minimal `$app/stores` (`page`), `$app/navigation` (`goto`, `invalidateAll`),
  and `$app/forms` (`enhance`) mocks.

## Extraction pass (pure logic → node tests)

| Module | Exports | Replaces |
|--------|---------|----------|
| `$lib/format.ts` *(new)* | `formatDate` (`{month:'short',day:'numeric',year:'numeric'}`), `formatDateTime` (`{month,day,hour:'2-digit',minute:'2-digit'}`), `formatDuration(ms: number \| null)` (`null`/`<1000`/seconds), `runDurationMs(run)`, `getPassRate(run)`, `getPassRateClass(rate)` (≥90 green, ≥70 orange, else red), `trendTooltipLabel(value: number \| null)` (`null → 'no runs'`, else `` `${value}%` ``) | 6× `formatDate`, 2× `formatDuration`, runs helpers, the `null`-vs-`0%` tooltip formatter inlined in both chart pages |
| `$lib/status.ts` *(extend)* | + `flakyStatusBadgeClass` (active→orange, resolved→green, ignored/default→gray), `trendDirectionLabel`, `trendDirectionBadgeClass` (over `improving`/`worsening`/`stable`/`insufficient-data`) | flaky's local `getStatusBadgeClass`, tests/[testName] `DIRECTION_*` maps |
| `$lib/error-page.ts` *(new)* | `errorTitle(status)`, `errorIcon(status)` (404/403/500/default) | +error's local fns |
| `$lib/href.ts` *(new)* | `appendProjectParam(href, projectId \| undefined)` — appends `project=…` with the correct `?`/`&` separator | flaky `getFilterHref` + layout `getNavHref` |

`status.ts` keeps its existing "these two mappings are deliberately separate"
comment (the `flaky_tests.status` vs `test_results.status` distinction); the new
`flakyStatusBadgeClass` is co-located so that decision is documented in one place.
The `formatDate`/`formatDateTime` split is exact: `analysis` and `flaky` use the
date+year form; `+page`, `runs`, `runs/[runId]`, `tests/[testName]` use the
date+time form — mapping each callsite preserves current output.

**Mapping the `formatDate` callsites (must be exact, else output changes):**
`formatDate` → `analysis/+page.svelte`, `flaky/+page.svelte`.
`formatDateTime` → `+page.svelte`, `runs/+page.svelte`, `runs/[runId]/+page.svelte`,
`tests/[testName]/+page.svelte`.
`formatDuration` (nullable) → `runs/[runId]` (already nullable) and
`tests/[testName]` (passes a non-null `avgDuration`; the nullable signature is a
superset, output unchanged).

## Render pass (jsdom — template branching)

Each file `src/**/<name>.svelte.test.ts` renders the component with
representative `data` and asserts on real DOM.

- **`ErrorState`** — default message renders; custom message renders; the retry
  button appears **only** when `onRetry` is passed.
- **`flaky`** — active empty state ("No active flaky tests!") vs generic ("No
  flaky tests found."); `canMute` gates the Actions column; Mute button for
  `active`, Unmute for `ignored`; the status badge carries
  `flakyStatusBadgeClass(status)`.
- **`analysis`** — null `analysis` message vs empty `allTests` vs populated
  table; the `isFlaky` marker on a flaky row.
- **`runs`** — empty state vs run list; pass-rate badge class wired from
  `getPassRateClass`.
- **`runs/[runId]`** — `!projectId` / `loadFailed` / `runDetail` three-way;
  empty results; `failureDetail` sections (errors, snippet, stack, stdout,
  stderr, attachments) each gated on presence; `showingAll` copy.
- **`+page` (overview)** — stats vs no-stats; `trendData` vs `partialFailure`;
  flaky `slice(0, 5)` cap; recentRuns empty vs list. **`Chart` stubbed.**
- **`tests/[testName]`** — `testTrend` vs `trendFailed`; `flakyInfo` block; the
  direction label/badge from the extracted maps. **`Chart` stubbed.**
- **`+layout`** — project switcher renders when `projects.length > 0`; the
  active nav item is marked; `apiError` banner. `$app/stores`/`navigation`
  mocked.
- **`+error`** — title and icon by status. `$app/stores` mocked.

## Mutation discipline

Extracted helper → mutate the function (e.g. flip a `getPassRateClass`
threshold, swap an `errorIcon` case) and watch the node test red. Render test →
mutate the template branch or the helper it calls (e.g. delete the `canMute`
`{#if}`, flip the empty-state condition) and watch that render assertion red.
Revert every mutation with `git checkout --`; never commit mutated source. A
mutation that leaves the suite green is a failed proof, not a pass.

## Scope

**In:** the two-project jsdom infra; the four extraction modules + their node
tests; render tests for all 8 route components + `ErrorState`; the shared
`Chart`/`$app` mocks.

**Out:** any behavior change to a component (extractions are output-preserving);
`Chart.svelte`'s own internals and ECharts runtime (render tests stub `Chart` —
the chart-registration bug stays guarded by the existing static
`chart-registration.test.ts`, which this design does **not** supersede;
AGENTS.md documents why a rendered assertion can't catch it); phase B (Stryker).
If a mutation reveals a real product bug, it is reported, not fixed here.

## Testing strategy

`*.svelte.test.ts` files run in the jsdom `client` project; all existing
`*.test.ts` stay in the node `server` project. `pnpm --filter dashboard test`
runs both; `pnpm --filter dashboard check` (svelte-check, TS 6) must stay clean
after the extractions. The first implementation task stands up the config and
proves a trivial component renders **and** that the existing node suite still
runs — de-risking the finicky two-project/`browser`-condition setup before any
real test is written.

## Risks

- **Two-project config + `browser` condition is fiddly.** Svelte 5 `mount`
  needs the `browser` resolve condition in the client project or it SSRs and
  the render queries find nothing. Mitigated by the smoke-test-first task.
- **Extraction changing rendered output.** The `formatDate`/`formatDateTime`
  split must map each callsite exactly. Mitigated by mutation proofs + the E2E
  suite + `svelte-check`; a wrong mapping shows as a changed date string.
- **`$app/*` and `Chart` mocking.** Store-shell and chart-page render tests
  depend on mocks; a stale mock is a silent no-op. Mitigated by keeping mocks
  minimal and asserting on branch-distinguishing output, not mock internals.
- **`connectNulls`/chart internals are unreachable by render** (Chart stubbed).
  Accepted: the load-bearing "null isn't 0%" rule is covered instead by the
  extracted `trendTooltipLabel` node test.

## Success criteria

- Dashboard has a working jsdom component-test project; the node suite is
  unchanged and still green.
- The four extraction modules exist, replace their duplicated inline copies,
  and are node-tested; `status.ts` (previously untested) is covered.
- All 8 route components + `ErrorState` have mutation-proven render tests.
- No component behavior changed. `pnpm --filter dashboard test` + `check` green;
  root lint clean; E2E still 8/8.
