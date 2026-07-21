# Dashboard `.svelte` render tests on Vitest browser mode (A3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render-test the dashboard's 8 route components + `ErrorState` in a real browser via Vitest browser mode, every assertion mutation-proven — closing the render half A3 (plan 045) deferred.

**Architecture:** A **separate** `apps/dashboard/vitest.browser.config.ts` runs `*.svelte.test.ts` files in headless Chromium (Vitest browser mode, Playwright provider), using Vite's dev-server transform — the path that already compiles `.svelte` correctly — so the vite-plugin-svelte × Vitest SSR-transform bug never applies. The existing `vitest.config.ts` and the default `pnpm --filter dashboard test` stay untouched (89 node tests, zero Chromium). A new advisory `component-tests` CI job installs Chromium and runs the browser suite.

**Tech Stack:** Vitest 4.1.10, `@vitest/browser@4.1.10`, `vitest-browser-svelte@3.0.0`, Playwright (Chromium), Svelte 5.56, SvelteKit 2, TS 6 (dashboard pin).

**Spec:** `docs/superpowers/specs/2026-07-21-dashboard-render-tests-a3b-design.md`

## Global Constraints

- **Behavior-preserving:** A3b only ADDS tests/config/CI/docs. After every task, `pnpm --filter dashboard check` (svelte-check, TS 6) stays clean, the default `pnpm --filter dashboard test` still passes its 89 node tests unchanged, and the E2E suite stays 8/8. **No product `.svelte` source change** is expected; the only sanctioned product touch is a minimal `data-testid` if a component is genuinely unrenderable in isolation — added deliberately and called out, never a behavior change.
- **Every assertion ships a recorded mutation proof:** break the covered branch in the component → watch that specific test go red → `git checkout -- <file>` to revert. Never commit mutated source. A mutation that leaves the suite green is a failed proof.
- **`minimumReleaseAge: 1440`** — the new devDeps (`@vitest/browser@4.1.10`, `vitest-browser-svelte@3.0.0`, and `playwright` if needed) must each be ≥24h old at install; if one resolves to a <24h version, pin one release back. Confirmed available and old enough on 2026-07-21: `@vitest/browser@4.1.10`, `vitest-browser-svelte@3.0.0`.
- **Do NOT add `@testing-library/jest-dom`** — browser mode's `expect.element(locator)` provides `.toBeInTheDocument()` / `.toHaveText()` etc. natively via `@vitest/browser`.
- **The default `pnpm --filter dashboard test` MUST stay browser-free** — it runs `vitest.config.ts` (node) only. Browser tests run exclusively via the new `test:browser` script / `vitest.browser.config.ts`.
- **Chart stays stubbed** — chart pages mock `$lib/components/Chart.svelte` to `Chart.stub.svelte`; `chart-registration.test.ts` remains the guard for the unregistered-series no-op (a rendered assertion still cannot catch it).
- Commits: single-line conventional-commit subject. **No `Co-Authored-By` trailers.** Never `--no-verify`. `main` is branch-protected — work on branch `test/dashboard-render-browser-mode`, PR needs green required CI.

## File Structure

| File | Responsibility | Task |
|------|---------------|------|
| `apps/dashboard/package.json` | add `@vitest/browser`, `vitest-browser-svelte` (+ `playwright` if needed) devDeps; add `test:browser` script | 1 |
| `apps/dashboard/vitest.browser.config.ts` *(new)* | isolated browser-mode Vitest config (Chromium, Playwright provider, `*.svelte.test.ts`) | 1 |
| `apps/dashboard/src/lib/components/ErrorState.svelte.test.ts` *(new)* | render test — default/custom message, retry gate | 1 |
| `apps/dashboard/src/routes/runs/+page.svelte.test.ts` *(new)* | render test — empty state, pass-rate row (proves `$app/navigation` mock) | 2 |
| `apps/dashboard/src/routes/analysis/+page.svelte.test.ts` *(new)* | render test — no-project / empty / rows+flaky marker | 3 |
| `apps/dashboard/src/routes/flaky/+page.svelte.test.ts` *(new)* | render test — empty variants, canMute gating, Mute/Unmute, status badge | 3 |
| `apps/dashboard/src/routes/runs/[runId]/+page.svelte.test.ts` *(new)* | render test — load three-way, results empty, failureDetail, truncated | 4 |
| `apps/dashboard/src/lib/components/Chart.stub.svelte` *(new)* | chart stub (marker div) for render tests | 5 |
| `apps/dashboard/src/routes/+page.svelte.test.ts` *(new)* | render test — overview: no-stats, stat cards, chart stub, slice(0,5) cap, recent runs | 5 |
| `apps/dashboard/src/routes/tests/[testName]/+page.svelte.test.ts` *(new)* | render test — trend/failed, flaky-info, direction label | 5 |
| `apps/dashboard/src/routes/+layout.svelte.test.ts` *(new)* | render test — switcher gating, apiError banner, active nav | 6 |
| `apps/dashboard/src/routes/+error.svelte.test.ts` *(new)* | render test — status title/icon + message | 6 |
| `.github/workflows/ci.yml` | new advisory `component-tests` job | 7 |
| `AGENTS.md`, `plans/README.md` | flip A3b note; add plan 046, flip 045→DONE | 7 |

**Execution note:** this plan is calibrated for author-inline execution. Component tasks give exact branches, fixtures, mutations, and the browser-mode assertion pattern; a few `getByText` literals in the deeper components (`runs/[runId]`, `tests/[testName]`) must be read from the component during execution rather than guessed (the spec forbids guessing copy). Every literal reproduced below was read from the component on 2026-07-21.

---

### Task 1: Browser-mode infra + `ErrorState` smoke (de-risk 1 — no `$app`)

This task stands up the whole toolchain and proves it on the one component that imports **no** `$app/*` module. If browser mode cannot compile a `.svelte` file or resolve aliases, it fails HERE, before any other suite exists.

**Files:**
- Modify: `apps/dashboard/package.json`
- Create: `apps/dashboard/vitest.browser.config.ts`, `apps/dashboard/src/lib/components/ErrorState.svelte.test.ts`

**Interfaces:**
- Produces: the `vitest.browser.config.ts` config; the `test:browser` script; the canonical browser-mode render/assert pattern (`render` from `vitest-browser-svelte`, `page` from `vitest/browser`, `expect.element(...).toBeInTheDocument()`, `document.querySelector('.cls')` for class assertions) that Tasks 2–6 reuse.

> **Task 1 executed inline 2026-07-21 — reality corrections baked into this plan for the subagent phase (Tasks 2–7):**
> 1. **Provider API:** Vitest 4.1 replaced the `provider: 'playwright'` string with a **factory**. The config now imports `import { playwright } from '@vitest/browser-playwright'` and sets `provider: playwright()`. A new devDep **`@vitest/browser-playwright@4.1.10`** was required, plus **`playwright@1.61.1`** (the `@vitest/browser` Playwright provider needs the base `playwright` package; `@playwright/test` alone did not resolve it).
> 2. **Locator import:** use `import { page } from 'vitest/browser'` — `@vitest/browser/context` works but is deprecated in v4.1 and warns.
> 3. **Node config exclude:** `vitest.config.ts`'s `include: ['src/**/*.test.ts']` also matches `*.svelte.test.ts`, so `exclude: [...configDefaults.exclude, 'src/**/*.svelte.test.ts']` was added there to keep the default `pnpm test` browser-free. (Already committed — Tasks 2–6 do not touch it.)
> 4. **`sveltekit()` works** as the browser-config plugin — the fallback config was NOT needed. `.svelte` compiles, `$lib`/`$app` resolve, `vi.mock('$app/*')` will be proven in Task 2.
> 5. **Mutation-proof timing:** a browser-mode assertion that should red reds by **retry timeout (~15s)**, not instantly — `expect.element` retries until the condition holds or times out. A red mutation proof taking ~15s is normal, not a hang.
> The config, deps, script, node-exclude, and `ErrorState.svelte.test.ts` are already committed. Tasks 2–7 reuse the committed config as-is.

- [ ] **Step 1: Add deps**

```bash
CI=true corepack pnpm --filter dashboard add -D \
  @vitest/browser@4.1.10 @vitest/browser-playwright@4.1.10 vitest-browser-svelte@3.0.0 playwright@1.61.1
```
(`--no-frozen-lockfile` is NOT a valid flag for `pnpm add` on pnpm 11 — omit it.) All four clear the 24h floor on 2026-07-21. `@vitest/browser-playwright` supplies the provider factory (Vitest 4.1's provider is a factory, not the `'playwright'` string); `playwright` is the provider's runtime browser driver (`@playwright/test` alone does not resolve `playwright` from the dashboard package).

- [ ] **Step 2: Add the `test:browser` script**

In `apps/dashboard/package.json` `scripts`, add (leave `"test"` unchanged):
```json
"test:browser": "svelte-kit sync && vitest run --config vitest.browser.config.ts",
```

- [ ] **Step 3: Create `vitest.browser.config.ts` (primary config)**

`apps/dashboard/vitest.browser.config.ts`:
```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// Isolated from vitest.config.ts (node) so the default `pnpm test` stays
// browser-free. Browser mode uses Vite's dev-server transform, which — unlike
// Vitest's node SSR transform — compiles .svelte correctly under Vite 8 +
// vite-plugin-svelte 7.2 (the A3 blocker).
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ['src/**/*.svelte.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
```
Also add the exclude to the node `vitest.config.ts` so `pnpm test` stays browser-free (its `include: ['src/**/*.test.ts']` otherwise matches `*.svelte.test.ts`): `import { defineConfig, configDefaults } from 'vitest/config'` and `exclude: [...configDefaults.exclude, 'src/**/*.svelte.test.ts']`.

**Contingency (only if Step 5 shows `sveltekit()` breaks browser mode — e.g. it tries to SSR/route, or `$app/*`/`$lib` fail to resolve):** replace the `sveltekit()` plugin with the raw Svelte plugin plus explicit aliases, and stub the `$app/*` virtual modules that `sveltekit()` would otherwise provide:
```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.svelte.test.ts'],
    browser: { enabled: true, provider: 'playwright', headless: true, instances: [{ browser: 'chromium' }] },
  },
});
```
With this fallback, EVERY `$app/*` import is supplied by the per-file `vi.mock('$app/…', () => ({…}))` in the tests that need it (Tasks 2–6 already mock them), so no real `$app` resolution is required. `ErrorState` imports no `$app`, so this task is unaffected either way — its result tells you which config the rest of the plan uses. Record the winning config in the commit message.

- [ ] **Step 4: Write the `ErrorState` render test**

Read `apps/dashboard/src/lib/components/ErrorState.svelte` first (verified 2026-07-21): default `message = 'Something went wrong'`; always renders an `<h3>Error</h3>`; the message in a `<p>`; a `Try Again` `<button>` gated by `{#if onRetry}`.

`apps/dashboard/src/lib/components/ErrorState.svelte.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ErrorState from './ErrorState.svelte';

describe('ErrorState', () => {
  it('renders the default message when none is given', async () => {
    render(ErrorState, { props: {} });
    await expect.element(page.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders a custom message and not the default', async () => {
    render(ErrorState, { props: { message: 'API is down' } });
    await expect.element(page.getByText('API is down')).toBeInTheDocument();
    await expect.element(page.getByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('shows the retry button only when onRetry is provided', async () => {
    render(ErrorState, { props: { message: 'x', onRetry: () => {} } });
    await expect.element(page.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('hides the retry button when onRetry is absent', async () => {
    render(ErrorState, { props: { message: 'x' } });
    await expect.element(page.getByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run the browser suite; confirm it PASSES and isolation works**

Run: `pnpm --filter dashboard test:browser`
Expected: Chromium launches; `ErrorState` reports 4/4 passing. Both the "custom message"/"hides retry" negative assertions pass (proving cleanup between tests — no stale DOM from the prior render). If it fails to resolve/compile, switch to the Step 3 contingency config and re-run.

- [ ] **Step 6: Confirm the default node suite is untouched**

Run: `pnpm --filter dashboard test`
Expected: still the 89 node tests, no Chromium, `vitest.config.ts` only. (The `.svelte.test.ts` glob is excluded from the node config by virtue of the node config's existing `include`; if the node run now tries to pick up `*.svelte.test.ts`, add `exclude: ['src/**/*.svelte.test.ts']` to `vitest.config.ts` and re-run.)

- [ ] **Step 7: Mutation proofs**

Apply each to `ErrorState.svelte`, run `test:browser`, confirm the named test reds, `git checkout --` to revert:
- Change default `message = 'Something went wrong'` → `'X'` → the default-message test reds.
- Delete the `{#if onRetry}` wrapper (leave the button unconditional) → the "hides retry when onRetry absent" test reds (button present without a handler).

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/package.json apps/dashboard/pnpm-lock.yaml ../../pnpm-lock.yaml \
  apps/dashboard/vitest.browser.config.ts \
  apps/dashboard/src/lib/components/ErrorState.svelte.test.ts
git commit -m "test(dashboard): stand up Vitest browser mode + ErrorState render test (A3b)"
```
(Adjust the lockfile path to whichever `pnpm-lock.yaml` changed. State the winning config — `sveltekit()` or the fallback — in the body if the fallback was used.)

---

### Task 2: `runs/+page` render test (de-risk 2 — proves `$app/navigation` mock)

`runs/+page.svelte` imports `goto` from `$app/navigation` (used in a row `onclick`). Mocking it proves per-file `$app/*` mocking works in browser mode. After this task the toolchain is fully de-risked.

**Files:**
- Create: `apps/dashboard/src/routes/runs/+page.svelte.test.ts`

**Interfaces:**
- Consumes: the render/assert pattern from Task 1.

**Note (dead import, do NOT fix here):** `runs/+page.svelte:4` imports `getPassRateClass` but the template inlines the color logic (`passRate >= 90 ? 'bg-green-500' : passRate >= 70 ? 'bg-yellow-500' : 'bg-red-500'` and the matching `text-*-600`). So the pass-rate render test asserts the inline classes + `%` text, and the mutation flips the inline threshold — NOT `getPassRateClass`. Record the unused import as a follow-up in `plans/README.md`'s "Open follow-ups"; it is out of scope for this test-only plan.

- [ ] **Step 1: Write the render test**

Verified copy (2026-07-21): empty state `<h3>No Test Runs Yet</h3>`; a run row renders `{passRate.toFixed(0)}%` with class `text-green-600` when `passRate >= 90`. `getPassRate({passed, totalTests})` = `passed/totalTests*100`.

`apps/dashboard/src/routes/runs/+page.svelte.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const base = { currentProject: null, projects: [] };

describe('runs/+page', () => {
  it('shows the empty state when there are no runs', async () => {
    render(Page, { props: { data: { ...base, runs: [] } } });
    await expect.element(page.getByText('No Test Runs Yet')).toBeInTheDocument();
  });

  it('renders a run row with a green pass-rate at 90%', async () => {
    render(Page, { props: { data: { ...base, runs: [
      { id: 'r1', branch: 'main', commitSha: 'abcdef1234567', pipelineId: '1',
        passed: 9, failed: 1, flaky: 0, totalTests: 10, createdAt: '2026-03-15T10:00:00Z' },
    ] } } });
    await expect.element(page.getByText('90%')).toBeInTheDocument();
    expect(document.querySelector('.text-green-600')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm pass**

Run: `pnpm --filter dashboard test:browser`
Expected: `runs/+page` 2/2 pass alongside `ErrorState` 4/4.

- [ ] **Step 3: Mutation proofs** (revert each with `git checkout -- "apps/dashboard/src/routes/runs/+page.svelte"`)

- Empty-state gate: `{#if data.runs.length === 0}` → `=== 1` → the empty-state test reds (empty branch no longer shows for `[]`).
- Pass-rate colour threshold: in the class expression, `passRate >= 90 ? 'text-green-600'` → `passRate >= 91 ? 'text-green-600'` → the "green at 90%" test reds (row becomes yellow; `.text-green-600` absent).

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/runs/+page.svelte.test.ts
git commit -m "test(dashboard): render test for runs page (A3b)"
```

---

### Task 3: `analysis` + `flaky` render tests

**Files:**
- Create: `apps/dashboard/src/routes/analysis/+page.svelte.test.ts`,
  `apps/dashboard/src/routes/flaky/+page.svelte.test.ts`

`analysis/+page.svelte` imports no `$app`. `flaky/+page.svelte` imports `enhance` from `$app/forms` — mock it: `vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }))`.

- [ ] **Step 1: `analysis` render test**

Verified copy: no-analysis branch `{#if !data.analysis}` → `<h3>No Project Selected</h3>`; empty branch `{#if data.analysis.allTests.length === 0}` → `<h3>No tests found.</h3>`; a row renders the test name and, if `test.isFlaky`, a `<span class="badge badge-orange …">Flaky</span>`.

```ts
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const base = { currentProject: { id: 'p1', name: 'Proj' }, projects: [], days: 14, threshold: 0.05 };

describe('analysis/+page', () => {
  it('shows "No Project Selected" when analysis is null', async () => {
    render(Page, { props: { data: { ...base, analysis: null } } });
    await expect.element(page.getByText('No Project Selected')).toBeInTheDocument();
  });

  it('shows "No tests found." when allTests is empty', async () => {
    render(Page, { props: { data: { ...base, analysis: {
      allTests: [], flakyTests: [], threshold: 0.05, windowDays: 14 } } } });
    await expect.element(page.getByText('No tests found.')).toBeInTheDocument();
  });

  it('renders a row per test and marks the flaky one', async () => {
    const row = (name: string, isFlaky: boolean) => ({
      testName: name, testFile: `${name}.spec.ts`, totalRuns: 5, passCount: 4,
      failCount: 1, flakyCount: isFlaky ? 1 : 0, flakeRate: isFlaky ? 0.2 : 0,
      isFlaky, lastSeen: '2026-03-15T10:00:00Z',
    });
    render(Page, { props: { data: { ...base, analysis: {
      allTests: [row('a', true), row('b', false)], flakyTests: [row('a', true)],
      threshold: 0.05, windowDays: 14 } } } });
    await expect.element(page.getByText('a')).toBeInTheDocument();
    await expect.element(page.getByText('b')).toBeInTheDocument();
    await expect.element(page.getByText('Flaky')).toBeInTheDocument(); // the isFlaky marker on row 'a'
  });
});
```

- [ ] **Step 2: `flaky` render test**

Verified copy: empty + `status === 'active'` → `<h3>No active flaky tests!</h3>`; empty + other status → `<h3>No flaky tests found.</h3>`; the `Actions` column + Mute/Unmute buttons render only when `data.canMute`; the row status badge uses `flakyStatusBadgeClass(test.status)` (`active` → `badge-orange`).

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const row = (over = {}) => ({ id: '1', testName: 't', testFile: 'f.spec.ts', flakeRate: '0.2',
  totalRuns: 10, firstDetected: null, lastSeen: null, status: 'active', ...over });
const base = { currentProject: { id: 'p1', name: 'Proj' } };

describe('flaky/+page', () => {
  it('shows "No active flaky tests!" for an empty active list', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [], status: 'active', canMute: false } } });
    await expect.element(page.getByText('No active flaky tests!')).toBeInTheDocument();
  });

  it('shows "No flaky tests found." for an empty resolved list', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [], status: 'resolved', canMute: false } } });
    await expect.element(page.getByText('No flaky tests found.')).toBeInTheDocument();
  });

  it('hides Mute actions when canMute is false', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [row()], status: 'active', canMute: false } } });
    await expect.element(page.getByRole('button', { name: 'Mute' })).not.toBeInTheDocument();
  });

  it('shows a Mute button for an active row when canMute is true', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [row({ status: 'active' })], status: 'active', canMute: true } } });
    await expect.element(page.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
  });

  it('shows an Unmute button for an ignored row when canMute is true', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [row({ status: 'ignored' })], status: 'ignored', canMute: true } } });
    await expect.element(page.getByRole('button', { name: 'Unmute' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run + mutation proofs** (revert each)

Run: `pnpm --filter dashboard test:browser`
- `analysis/+page.svelte`: `{#if !data.analysis}` → `{#if data.analysis}` → the "No Project Selected" test reds.
- `analysis/+page.svelte`: `{#if data.analysis.allTests.length === 0}` → `=== 1` → the "No tests found." test reds.
- `analysis/+page.svelte`: `{#if test.isFlaky}` → `{#if false}` → the "marks the flaky one" test reds (no `Flaky` badge).
- `flaky/+page.svelte`: the empty-state `{#if data.status === 'active'}` → `=== 'resolved'` → the "No active flaky tests!" test reds.
- `flaky/+page.svelte`: the Mute gate `{#if test.status === 'active'}` → `=== 'resolved'` → the "Mute button for active row" test reds.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/analysis/+page.svelte.test.ts \
  apps/dashboard/src/routes/flaky/+page.svelte.test.ts
git commit -m "test(dashboard): render tests for analysis and flaky pages (A3b)"
```

---

### Task 4: `runs/[runId]` render test

**Files:**
- Create: `apps/dashboard/src/routes/runs/[runId]/+page.svelte.test.ts`

Imports `invalidateAll` from `$app/navigation` (mock it), `ErrorState` (renders fine), `statusBadgeClass` from `$lib/status`. Branch structure (verified 2026-07-21): `{#if !data.projectId}` → missing-project branch; `{:else if data.loadFailed}` → `ErrorState message="Couldn't load this run."`; `{:else if data.runDetail}` → detail, with `{@const showingAll = data.statusFilter === 'all'}`, a `Show all results` / `Show failures only` toggle link, `{#if data.runDetail.results.length === 0}` empty branch, per-result `failureDetail`/`errorMessage`, and `{#if data.runDetail.truncated}` notice.

- [ ] **Step 1: Read the component for the exact copy of the missing-project branch (line ~28), the empty-results branch (line ~78), and the truncated notice (line ~187), then write the render test.**

Cover, one assertion each (fill the three literals marked `‹read›` from the component):
```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const detail = (over = {}) => ({ id: 'r1', branch: 'main', commitSha: 'abcdef1234567',
  results: [], truncated: false, ...over });

describe('runs/[runId]/+page', () => {
  it('shows the missing-project branch when projectId is falsy', async () => {
    render(Page, { props: { data: { projectId: null, loadFailed: false, runDetail: null, statusFilter: 'failures' } } });
    await expect.element(page.getByText('‹read: missing-project copy›')).toBeInTheDocument();
  });

  it('renders ErrorState when loadFailed', async () => {
    render(Page, { props: { data: { projectId: 'p1', loadFailed: true, runDetail: null, statusFilter: 'failures' } } });
    await expect.element(page.getByText("Couldn't load this run.")).toBeInTheDocument();
  });

  it('shows the empty-results branch', async () => {
    render(Page, { props: { data: { projectId: 'p1', loadFailed: false, runDetail: detail({ results: [] }), statusFilter: 'failures' } } });
    await expect.element(page.getByText('‹read: empty-results copy›')).toBeInTheDocument();
  });

  it('renders a failed result error message', async () => {
    render(Page, { props: { data: { projectId: 'p1', loadFailed: false, statusFilter: 'all',
      runDetail: detail({ results: [
        { testName: 'boom', status: 'failed', durationMs: 12, retryCount: 0,
          failureDetail: { errors: [{ message: 'AssertionError: nope', snippet: null, stack: null }], stdout: null, stderr: null, attachments: [] },
          errorMessage: null, tags: [], annotations: [] },
      ] }) } } });
    await expect.element(page.getByText('AssertionError: nope')).toBeInTheDocument();
  });

  it('shows the truncated notice when runDetail.truncated', async () => {
    render(Page, { props: { data: { projectId: 'p1', loadFailed: false, statusFilter: 'all',
      runDetail: detail({ results: [], truncated: true }) } } });
    await expect.element(page.getByText('‹read: truncated-notice copy›')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run + mutation proofs** (revert each)

Run: `pnpm --filter dashboard test:browser`
- Flip `{#if !data.projectId}` → `{#if data.projectId}` → the missing-project test reds.
- Change the `loadFailed` `ErrorState` `message="Couldn't load this run."` → `"x"` → the loadFailed test reds.
- Flip `{#if result.failureDetail}` (the errors block) → `{#if false}` → the "failed result error message" test reds.
- Flip `{#if data.runDetail.truncated}` → `{#if false}` → the truncated-notice test reds.

- [ ] **Step 3: Commit**

```bash
git add "apps/dashboard/src/routes/runs/[runId]/+page.svelte.test.ts"
git commit -m "test(dashboard): render test for run-detail page (A3b)"
```

---

### Task 5: `Chart` stub + `overview` + `tests/[testName]` render tests

**Files:**
- Create: `apps/dashboard/src/lib/components/Chart.stub.svelte`,
  `apps/dashboard/src/routes/+page.svelte.test.ts`,
  `apps/dashboard/src/routes/tests/[testName]/+page.svelte.test.ts`

- [ ] **Step 1: Create the Chart stub**

`apps/dashboard/src/lib/components/Chart.stub.svelte`:
```svelte
<script lang="ts">
  // Stub of $lib/components/Chart.svelte for render tests: a marker instead of
  // initialising ECharts. Kept even though browser mode has canvas, so chart
  // pages render fast + deterministically; chart registration stays guarded by
  // chart-registration.test.ts.
  let {}: { options?: unknown; height?: string; class?: string } = $props();
</script>
<div data-testid="chart-stub"></div>
```

- [ ] **Step 2: `overview` (`+page`) render test** — mock `$app/navigation` + Chart

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/components/Chart.svelte', async () => ({
  default: (await import('$lib/components/Chart.stub.svelte')).default,
}));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const stats = { project: { id: 'p1', name: 'Proj' }, activeFlakyTests: 2, resolvedThisWeek: 1, totalRuns: 10, totalTests: 5 };
const flaky = (n: number) => Array.from({ length: n }, (_, i) => ({
  testName: `t${i}`, testFile: 'f.spec.ts', flakeRate: '0.2', lastSeen: '2026-03-15T10:00:00Z' }));

describe('+page (overview)', () => {
  it('shows the no-projects state when stats is null', async () => {
    render(Page, { props: { data: { stats: null, trendData: null, flakyTests: [], recentRuns: [], partialFailure: false } } });
    await expect.element(page.getByText('No Projects Found')).toBeInTheDocument();
  });

  it('renders the four stat cards and the chart stub when stats + trendData present', async () => {
    render(Page, { props: { data: { stats, trendData: { days: ['d'], rates: [1] }, flakyTests: [], recentRuns: [], partialFailure: false } } });
    await expect.element(page.getByText('Active Flaky Tests')).toBeInTheDocument();
    await expect.element(page.getByTestId('chart-stub')).toBeInTheDocument();
  });

  it('caps the flaky preview at 5 rows (slice(0,5))', async () => {
    render(Page, { props: { data: { stats, trendData: null, partialFailure: true, recentRuns: [], flakyTests: flaky(7) } } });
    await expect.element(page.getByText('t4')).toBeInTheDocument();  // 5th row (index 4) present
    await expect.element(page.getByText('t5')).not.toBeInTheDocument(); // 6th row dropped
  });
});
```

- [ ] **Step 3: `tests/[testName]` render test** — mock `$app/navigation` + Chart

Cover: `data.testTrend` present → chart stub; `data.trendFailed` → the trend-failure `ErrorState`; `data.testHistory.flakyInfo` present → the flaky-info block; a `direction` of `'insufficient-data'` → the label `Insufficient data` renders (via `trendDirectionLabel`), NOT `→ Stable`. Read the component for the exact flaky-info heading; the direction label strings are verified: `insufficient-data` → `Insufficient data`, `stable` → `→ Stable`.

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/components/Chart.svelte', async () => ({
  default: (await import('$lib/components/Chart.stub.svelte')).default,
}));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const history = (over = {}) => ({ testName: 'my-test', flakyInfo: null,
  stats: { totalRuns: 5, passed: 3, failed: 1, flaky: 1, skipped: 0, avgDuration: 1200 },
  history: [], ...over });

describe('tests/[testName]/+page', () => {
  it('labels an insufficient-data trend distinctly from stable', async () => {
    render(Page, { props: { data: { projectId: 'p1', testHistory: history(),
      testTrend: { days: 30, direction: 'insufficient-data', trend: [] }, trendFailed: false } } });
    await expect.element(page.getByText('Insufficient data')).toBeInTheDocument();
    await expect.element(page.getByText('→ Stable')).not.toBeInTheDocument();
  });

  it('renders the trend-failure ErrorState', async () => {
    render(Page, { props: { data: { projectId: 'p1', testHistory: history(),
      testTrend: null, trendFailed: true } } });
    await expect.element(page.getByText("Couldn't load the flake-rate trend.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run + mutation proofs** (revert each)

Run: `pnpm --filter dashboard test:browser`
- `+page.svelte`: `data.flakyTests.slice(0, 5)` → `slice(0, 7)` → the "caps at 5 rows" test reds (`t5` appears).
- `+page.svelte`: `{#if !data.stats}` → `{#if data.stats}` → the "no-projects state" test reds.
- `tests/[testName]/+page.svelte`: the `trendDirectionLabel(...)` call site — mutate `status.ts` `case 'insufficient-data': return 'Insufficient data'` → `return '→ Stable'` → the distinctness test reds. Revert `status.ts`.
- `tests/[testName]/+page.svelte`: flip `{:else if data.trendFailed}` → `{:else if false}` → the trend-failure test reds.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/components/Chart.stub.svelte \
  apps/dashboard/src/routes/+page.svelte.test.ts \
  "apps/dashboard/src/routes/tests/[testName]/+page.svelte.test.ts"
git commit -m "test(dashboard): render tests for overview and test-detail pages, Chart stubbed (A3b)"
```

---

### Task 6: `+layout` + `+error` render tests (`$app/stores` mock)

**Files:**
- Create: `apps/dashboard/src/routes/+layout.svelte.test.ts`,
  `apps/dashboard/src/routes/+error.svelte.test.ts`

Both read the `page` store from `$app/stores`. Mock it per file with a Svelte `readable` whose value the test controls.

- [ ] **Step 1: `+error` render test**

Verified: `status` from `$page.status`; renders `errorIcon(status)` + `errorTitle(status)` + the message. 404 → `🔍` + `Page Not Found`.
```ts
import { describe, it, expect, vi } from 'vitest';
import { readable } from 'svelte/store';
vi.mock('$app/stores', () => ({
  page: readable({ status: 404, error: { message: 'nope' }, url: new URL('http://localhost/x') }),
}));
import { render } from 'vitest-browser-svelte';
import { page as vitestPage } from 'vitest/browser';
import ErrorPage from './+error.svelte';

describe('+error', () => {
  it('renders the title, icon, and message for the status', async () => {
    render(ErrorPage, { props: {} });
    await expect.element(vitestPage.getByText('Page Not Found')).toBeInTheDocument(); // 404 → errorTitle
    await expect.element(vitestPage.getByText('🔍')).toBeInTheDocument();              // 404 → errorIcon
    await expect.element(vitestPage.getByText('nope')).toBeInTheDocument();            // page.error.message
  });
});
```

- [ ] **Step 2: `+layout` render test**

`+layout.svelte` reads `$page.url` (from `$app/stores`) and imports `goto` from `$app/navigation`. It also takes a `children` snippet prop; the switcher, apiError banner, and nav all render OUTSIDE `{@render children()}`, so pass no children and assert on those. Verified: the project `<select>` renders only when `data.projects.length > 0`; the apiError banner renders when `data.apiError`; the active nav item (matching `$page.url.pathname`) carries the `bg-purple-50 text-purple-700` active classes.
```ts
import { describe, it, expect, vi } from 'vitest';
import { readable } from 'svelte/store';
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/flaky') }) }));
import { render } from 'vitest-browser-svelte';
import { page as vitestPage } from 'vitest/browser';
import Layout from './+layout.svelte';

const data = (over = {}) => ({ projects: [], selectedProject: null, apiError: null, ...over });

describe('+layout', () => {
  it('renders the project switcher when there are projects', async () => {
    render(Layout, { props: { data: data({ projects: [{ id: 'p1', name: 'Proj One' }], selectedProject: { id: 'p1' } }) } });
    await expect.element(vitestPage.getByText('Proj One')).toBeInTheDocument();
  });

  it('hides the switcher when there are no projects', async () => {
    render(Layout, { props: { data: data({ projects: [] }) } });
    await expect.element(vitestPage.getByRole('combobox')).not.toBeInTheDocument();
  });

  it('renders the apiError banner when apiError is set', async () => {
    render(Layout, { props: { data: data({ apiError: 'API unreachable' }) } });
    await expect.element(vitestPage.getByText('API unreachable')).toBeInTheDocument();
  });
});
```
If rendering without a `children` snippet throws in browser mode, pass a minimal snippet per `vitest-browser-svelte`'s render options (read its README for the Svelte-5 snippet-prop form) and document it in the test. If `getByRole('combobox')` proves brittle, assert on the `Project` label text instead (present only inside the `{#if data.projects.length > 0}` block).

- [ ] **Step 3: Run + mutation proofs** (revert each)

Run: `pnpm --filter dashboard test:browser`
- `+error.svelte`: mutate `error-page.ts` `errorTitle` `case 404: return 'Page Not Found'` → `'X'` → the `+error` title test reds. Revert `error-page.ts`.
- `+layout.svelte`: flip `{#if data.projects.length > 0}` → `{#if false}` → the switcher test reds.
- `+layout.svelte`: flip `{#if data.apiError}` → `{#if false}` → the apiError-banner test reds.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/+layout.svelte.test.ts \
  apps/dashboard/src/routes/+error.svelte.test.ts
git commit -m "test(dashboard): render tests for layout and error pages (A3b)"
```

---

### Task 7: Advisory `component-tests` CI job + docs + final gate

**Files:**
- Modify: `.github/workflows/ci.yml`, `AGENTS.md`, `plans/README.md`

- [ ] **Step 1: Add the `component-tests` CI job**

In `.github/workflows/ci.yml`, add a job mirroring the E2E job's setup but with NO Postgres/API/build (component tests use mocked data). Use the SAME pinned action SHAs already in the file:
```yaml
  # ============================================================
  # Dashboard component render tests (Vitest browser mode, Chromium)
  # Advisory: runs on every PR, not a required check (retries:0 policy).
  # ============================================================
  component-tests:
    name: Component Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271  # v6
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020  # v7
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Install Chromium
        run: pnpm --filter dashboard exec playwright install --with-deps chromium
      - name: Run dashboard component render tests
        run: pnpm --filter dashboard test:browser
```
(Advisory = simply do not add `component-tests` to the branch-protection required-checks list; nothing in the workflow file marks it required. Leave that server-side setting as the maintainer's call.)

- [ ] **Step 2: Full local gate**

```bash
pnpm --filter dashboard test          # 89 node tests, unchanged, browser-free
pnpm --filter dashboard test:browser  # all render suites green in Chromium
pnpm --filter dashboard check         # svelte-check 0 errors (TS 6)
pnpm run lint                         # oxlint clean
pnpm --filter dashboard test:e2e      # E2E still 8/8 (needs Postgres + built dashboard + API)
```
Record counts. Confirm the node suite count is unchanged from before this branch.

- [ ] **Step 3: Update `AGENTS.md`**

Replace the "Dashboard component tests are node-only (no rendered-DOM tests yet)" sharp-edge bullet's tail. Keep the `$lib`-extraction sentence; change the deferral sentence to state that rendered-DOM tests now run in **Vitest browser mode** (`vitest.browser.config.ts`, `vitest-browser-svelte`, headless Chromium) via `pnpm --filter dashboard test:browser`, in the advisory `component-tests` CI job — the default `pnpm --filter dashboard test` stays node-only/browser-free. Keep the note that chart pages stub `Chart.svelte`, so a rendered assertion still cannot catch the chart-registration no-op (still guarded by `chart-registration.test.ts`).

- [ ] **Step 4: Update `plans/README.md`**

Add the 046 row after 045 in the batch-9 table and flip 045's status to DONE:
```
| 045 | … A3 extraction half … | P3 | M | A1/A2 (plans 042–044) | DONE (merged via PR #100, commit `1b605c9`) |
| 046 | A3b: render-test the 8 route components + ErrorState in Vitest browser mode (isolated config, vitest-browser-svelte, advisory component-tests CI job); every assertion mutation-proven — closes A3's deferred render half | P3 | M | A3 (plan 045) | OPEN (PR pending) |
```
Also add to "Open follow-ups": `runs/+page.svelte` imports `getPassRateClass` from `$lib/format` but never uses it (the template inlines the colour thresholds); a one-line unused-import removal, out of scope for the test-only A3b.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml AGENTS.md plans/README.md
git commit -m "ci+docs: advisory component-tests job; document browser-mode render tests (A3b)"
```

## Self-Review Notes

**Spec coverage:** D1 browser mode → Task 1 config; D2 isolated/browser-free → separate `vitest.browser.config.ts` + unchanged `test` (Task 1 Steps 3,6); D3 `vitest-browser-svelte` → Task 1 deps + pattern; D4 full-parity 9 components → Tasks 1–6 (ErrorState, runs, analysis, flaky, runs/[runId], overview, tests/[testName], +layout, +error); D5 Chart stub → Task 5; D6 advisory CI job → Task 7; D7 mutation proofs → every task's proof step; D8 de-risk-before-scaling → Task 1 (no-`$app`) then Task 2 (`$app` mock) before Tasks 3–6.

**Deferred exactness (intentional):** Task 4 (`runs/[runId]`) and Task 5 (`tests/[testName]` flaky-info heading) leave three `‹read›` copy literals to be read from the component at execution (the spec forbids guessing copy); every other literal was read on 2026-07-21 and is inline. Task 1 carries a primary (`sveltekit()`) and a concrete fallback (`svelte()` + `$lib` alias + `$app` mocks) config because the exact working browser-mode plugin set is the one real unknown — that is what the de-risk task exists to settle, not a placeholder.

**Type consistency:** `render`/`page`/`expect.element` usage is identical across all tasks (established in Task 1). Fixture prop shapes match each component's `PageData` usage as read from source. The Chart mock specifier (`$lib/components/Chart.svelte` → `$lib/components/Chart.stub.svelte`) is identical in Tasks 5's two files.

**Sharp edges:** the `sveltekit()`-vs-fallback config (Task 1 de-risks); the `children`-snippet prop for `+layout` (Task 6 Step 2 documents the fallback); the dead `getPassRateClass` import (Task 2 note + follow-up, NOT fixed here).
