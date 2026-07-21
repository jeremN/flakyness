# A3b — dashboard `.svelte` render tests on Vitest browser mode — design

**Status:** approved 2026-07-21. Follows A3 (plan 045, merged via PR #100, `1b605c9`).

## Goal

Render-test the dashboard's 8 route components + `ErrorState` with the same
mutation-proven-assertion standard as A1/A2/A3, closing the render half that A3
deferred. This completes the mutation-testing effort's coverage of the
dashboard's `.svelte` template branching. B (Stryker nightly) follows separately.

## Context — why this was deferred

A3 (plan 045) intended a jsdom + `@testing-library/svelte` two-project Vitest
config, but hit an upstream blocker: **`@sveltejs/vite-plugin-svelte@7.2.0`
(still the latest — no newer release) does not apply its `.svelte` transform
under Vitest 4.1.10 + Vite 8.1.4.** The component never compiles, so render
queries find raw source. `pnpm build`, `vite dev`, and the Playwright E2E suite
all compile `.svelte` fine — the gap is Vitest's node-side SSR transform
specifically. A3 therefore shipped the **extraction half** only (pure view-logic
moved to `$lib`, node-tested, 8 components rewired behavior-preservingly) and
recorded the render half as this follow-up, A3b.

Verified current state (2026-07-21): `@sveltejs/vite-plugin-svelte` is still
`7.2.0`, so the "wait for upstream" path remains closed. `@vitest/browser` is at
`4.1.10` (version-aligned with the repo's `vitest`), and `@playwright/test`
`^1.61.1` is already a dev dependency (Chromium already installs in CI for the
E2E job).

## Decisions

- **D1 — Infra path: Vitest browser mode + Playwright provider.** Browser mode
  runs tests in real Chromium and uses Vite's **dev-server** transform (the path
  that already compiles `.svelte` correctly), sidestepping the node-side
  SSR-transform bug entirely. This is the only viable path today and reuses
  tooling already present.
- **D2 — Isolated config; browser-free default.** Browser tests live in a
  **separate** `apps/dashboard/vitest.browser.config.ts`. The existing
  `vitest.config.ts` and the default `pnpm --filter dashboard test` stay exactly
  as they are — contributors and the CI **Tests** job keep running the 89 node
  tests with no Chromium dependency.
- **D3 — Render library: `vitest-browser-svelte@3.0.0`.** The browser-mode-native
  choice: it renders via `@vitest/browser`'s retry-able locators, handles Svelte
  5 `mount`, and auto-cleans between tests. `@testing-library/svelte` is jsdom-
  oriented and not used here.
- **D4 — Full-parity scope: all 9 components.** One `*.svelte.test.ts` per
  component, reusing plan 045 Tasks 5–8's already-enumerated branch lists. Under
  the mutation standard, trivial assertions self-exclude (no biting mutation), so
  "full parity" means "every template branch a mutation could break," not
  busywork.
- **D5 — Chart stays stubbed.** Chart-rendering pages (`+page` overview,
  `tests/[testName]`) mock `$lib/components/Chart.svelte` to a
  `Chart.stub.svelte` marker. Browser mode has real canvas, so ECharts *could*
  render, but stubbing keeps render tests fast and deterministic; chart
  registration stays guarded by the existing static `chart-registration.test.ts`
  (a rendered assertion still cannot catch the unregistered-series-type no-op).
- **D6 — Dedicated advisory CI job.** A new `component-tests` job mirrors the
  E2E job's browser install (`playwright install --with-deps chromium`) then runs
  `pnpm --filter dashboard test:browser`. No Postgres/API/build. It starts
  **advisory** (runs on every PR, does not block merge), consistent with the
  E2E job under the repo's `retries: 0` philosophy; promote to required after a
  green streak.
- **D7 — Mutation-proven assertions.** Every assertion ships a recorded mutation
  proof: break the covered branch → watch the specific test red → revert. No
  mutated source committed. A mutation that leaves the suite green is a failed
  proof.
- **D8 — De-risk before scaling.** The plan's first task proves the toolchain on
  two smoke cases before writing all 9 (see "De-risking").

## Architecture

### Config (`apps/dashboard/vitest.browser.config.ts`, new)

- Plugins: `sveltekit()` — compiles `.svelte` through the working dev-server
  transform and resolves `$app`/`$lib`/`$types` aliases.
- `test.browser`: `{ enabled: true, provider: 'playwright', headless: true,
  instances: [{ browser: 'chromium' }] }`.
- `test.include`: `['src/**/*.svelte.test.ts']`.
- `test.setupFiles`: browser setup as `vitest-browser-svelte` requires (auto-
  cleanup is built in; a setup file is added only if the smoke test shows one is
  needed).

### Dependencies (dev)

- `@vitest/browser@4.1.10` — version-locked to the installed `vitest@4.1.10`.
- `vitest-browser-svelte@3.0.0` — render/locators for Svelte 5 under browser mode.
- `playwright` — added only if the `@vitest/browser` Playwright provider does not
  resolve it transitively via `@playwright/test` (confirmed in Task 1).

All three clear `minimumReleaseAge: 1440`; if any resolves to a <24h-old version
at install, pin one release back.

### Script (`apps/dashboard/package.json`)

- `"test:browser": "svelte-kit sync && vitest run --config vitest.browser.config.ts"`.
- The existing `"test"` script is unchanged.

### Test files (9, `*.svelte.test.ts`)

`ErrorState`, `analysis/+page`, `runs/+page`, `flaky/+page`, `runs/[runId]/+page`,
`+page` (overview), `tests/[testName]/+page`, `+layout`, `+error`. Branches to
cover per component are those enumerated in plan 045 Tasks 1 and 5–8: empty
states, `canMute` gating, load three-ways (loading/error/data), the `slice(0,5)`
preview cap, active-nav marker, and the error-title/icon + trend-direction labels.
`$app/*` is mocked per file (`$app/navigation`, `$app/forms`, and `$app/stores`
via a Svelte `readable` whose value the test controls). A new
`apps/dashboard/src/lib/components/Chart.stub.svelte` is mocked in for the two
chart pages.

## De-risking

The two genuine unknowns are (1) does browser mode compile `.svelte` and resolve
SvelteKit aliases, and (2) does `vi.mock('$app/*')` work in browser mode. The
plan's first task stands up the config and proves both before any other test is
written:

1. **`ErrorState`** (imports no `$app`) renders and its three assertions pass →
   proves the transform + alias resolution.
2. **One component with `$app` mocks** (e.g. `runs/+page`, which mocks
   `$app/navigation`) renders → proves per-file `vi.mock` of `$app/*`.

Only after both are green are the remaining seven suites written. If either
fails, the failure is a config problem surfaced immediately, not after nine
suites exist.

## CI & DX

- **Unchanged:** `pnpm --filter dashboard test` (node, browser-free), the CI
  **Tests** job, and every contributor's fast path.
- **New:** a `component-tests` job in `.github/workflows/ci.yml` — checkout →
  setup Node + pnpm → install deps → `playwright install --with-deps chromium`
  → `pnpm --filter dashboard test:browser`. Advisory (non-blocking) to start.

## Product-change surface

Test-only plus config/CI/docs. The components were already rewired to `$lib` in
A3, so **no product `.svelte` source changes are expected**. If a component
proves awkward to render in isolation, the only sanctioned product touch is a
minimal `data-testid` (or equivalent) added deliberately and noted — never a
behavior change. Additive files: the browser config, the new devDeps, the 9
`*.svelte.test.ts`, `Chart.stub.svelte`, the CI job, and docs.

## Docs

- `AGENTS.md`: flip the "Dashboard component tests are node-only… deferred to
  A3b" sharp-edge to reflect that render tests now run in browser mode via
  `test:browser` in the `component-tests` job; keep the note that chart
  registration is still guarded by the static test (the stub means a rendered
  assertion still can't catch it).
- `plans/README.md`: add plan **046** (A3b) to the batch-9 table and flip 045's
  status from `OPEN (…)` to `DONE (merged via PR #100, commit 1b605c9)`.

## Global constraints

- **Behavior-preserving:** A3b adds tests; it must not change any rendered
  output. After the work, `pnpm --filter dashboard check` (svelte-check, TS 6)
  stays clean, the 89 node tests still pass unchanged, and the E2E suite stays
  8/8.
- **Mutation discipline (D7)** applies to every assertion.
- **`minimumReleaseAge: 1440`** on all new deps.
- Commits: single-line conventional-commit subject; **no `Co-Authored-By`
  trailers**; never `--no-verify`; `main` is branch-protected (work on the
  branch, PR needs green required CI).

## Open questions

None — D1–D8 resolve the infra path, config isolation, render library, scope,
chart handling, CI placement/gating, mutation discipline, and sequencing.
