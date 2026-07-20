# Dashboard `.svelte` component testing (A3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a jsdom component-test environment for the dashboard, extract the duplicated pure view-logic into `$lib` (node-tested), and jsdom render-test all 8 route components + `ErrorState` — every assertion mutation-proven.

**Architecture:** A two-project Vitest config splits tests by environment: a `client` project (jsdom, `*.svelte.test.ts`) renders components via `@testing-library/svelte`; a `server` project (node, `*.test.ts` excluding the svelte ones) keeps every existing test running unchanged. Pure functions currently inlined in `.svelte` `<script>` blocks move to `$lib` modules and get hard node-env unit tests; template branching (empty states, conditional gates, load three-ways) gets jsdom render tests.

**Tech Stack:** Vitest 4.1.10, `@testing-library/svelte@^5.4.2` (Svelte 5 support, `render` uses `mount`), `jsdom@^29.1.1`, Svelte 5.56, SvelteKit 2, TS 6 (dashboard pin).

**Spec:** `docs/superpowers/specs/2026-07-21-dashboard-component-testing-design.md`

## Global Constraints

- **Extractions are behavior-preserving.** Each callsite swaps an inline fn for
  the import with NO rendered-output change. After every rewire, `pnpm --filter
  dashboard check` (svelte-check, TS 6) must stay clean and the E2E suite must
  still pass 8/8.
- **`formatDate` vs `formatDateTime` callsite mapping is exact:** date+year form
  (`formatDate`) → `analysis/+page.svelte`, `flaky/+page.svelte`. date+time form
  (`formatDateTime`) → `+page.svelte`, `runs/+page.svelte`,
  `runs/[runId]/+page.svelte`, `tests/[testName]/+page.svelte`. A wrong mapping
  changes a date string — a bug, not a refactor.
- **`$lib/status.ts` keeps its "deliberately-separate mappings" comment.** The
  new `flakyStatusBadgeClass` is co-located there but is a DISTINCT mapping from
  `statusBadgeClass` (flaky-lifecycle vs test-result domains); do not unify them.
- **Every assertion ships a recorded mutation proof.** Break covered code →
  watch the specific test red → `git checkout -- <file>` to revert. Never commit
  mutated source. A mutation that leaves the suite green is a failed proof.
- **`minimumReleaseAge: 1440`** — if a chosen dep version is <24h old at install,
  pin one release back. Do NOT add `@testing-library/jest-dom` (use TL/svelte
  queries + plain `expect`).
- **No CI workflow change** — `pnpm --filter dashboard test` already runs
  `vitest run`, which runs both projects.
- Commits: single-line conventional-commit subject. NO `Co-Authored-By`. Never
  `--no-verify`. `main` is branch-protected.

## File Structure

| File | Responsibility | Task |
|------|---------------|------|
| `apps/dashboard/package.json` | add `jsdom`, `@testing-library/svelte` devDeps | 1 |
| `apps/dashboard/vite.config.ts` | two-project `test` config | 1 |
| `apps/dashboard/vitest-setup-client.ts` *(new)* | jsdom project setup (`afterEach(cleanup)`) | 1 |
| `apps/dashboard/src/lib/format.ts` *(new)* + `.test.ts` | date/time/duration/pass-rate/trend-label formatting | 2 |
| `apps/dashboard/src/lib/status.ts` *(extend)* + `.test.ts` *(new)* | badge/label mappings | 3 |
| `apps/dashboard/src/lib/error-page.ts` *(new)* + `.test.ts` | error title/icon | 4 |
| `apps/dashboard/src/lib/href.ts` *(new)* + `.test.ts` | project-param href helper | 4 |
| `apps/dashboard/src/lib/components/ErrorState.svelte.test.ts` *(new)* | render test | 1 |
| `apps/dashboard/src/routes/**/*.svelte.test.ts` *(new)* | render tests | 5–8 |
| `apps/dashboard/src/lib/components/Chart.stub.svelte` *(new)* | chart stub for jsdom | 7 |
| the 8 route `.svelte` components | rewire to `$lib` imports | 2,3,4 |
| `AGENTS.md`, `plans/README.md` | document infra + index | 9 |

**Execution note:** this plan is calibrated for author-inline execution
(`executing-plans`). Infra and extraction modules carry exact code; render
tasks carry the exact assertions + the mutation for each, with representative
code — write the remaining assertions in the same shape during execution.

---

### Task 1: jsdom infra + first render test (`ErrorState`)

**Files:**
- Modify: `apps/dashboard/package.json`, `apps/dashboard/vite.config.ts`
- Create: `apps/dashboard/vitest-setup-client.ts`,
  `apps/dashboard/src/lib/components/ErrorState.svelte.test.ts`

**Interfaces:**
- Produces: the `client`/`server` Vitest projects; the `*.svelte.test.ts`
  naming convention; `render`/`screen` usage pattern for later tasks.

- [ ] **Step 1: Add deps**

```bash
cd apps/dashboard
CI=true corepack pnpm add -D jsdom@^29.1.1 @testing-library/svelte@^5.4.2 --no-frozen-lockfile
```
If either resolves to a <24h-old version, pin one release back. Confirm no
`allowBuilds` prompt blocks install; neither package has a postinstall build.

- [ ] **Step 2: Rewrite `vite.config.ts` to a two-project test config**

```ts
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    host: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/**/*.svelte.test.ts'],
          setupFiles: ['./vitest-setup-client.ts'],
        },
        resolve: {
          // Svelte 5 `mount` needs the browser condition or it SSRs and the
          // render queries find nothing.
          conditions: ['browser'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'src/**/*.svelte.test.ts'],
        },
      },
    ],
  },
});
```

- [ ] **Step 3: Create the client setup file**

`apps/dashboard/vitest-setup-client.ts`:
```ts
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

// Unmount rendered components between tests so queries never see stale DOM.
afterEach(() => cleanup());
```

- [ ] **Step 4: Write the `ErrorState` render test**

`apps/dashboard/src/lib/components/ErrorState.svelte.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ErrorState from './ErrorState.svelte';

describe('ErrorState', () => {
  it('renders the default message when none is given', () => {
    render(ErrorState, { props: {} });
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('renders a custom message', () => {
    render(ErrorState, { props: { message: 'API is down' } });
    expect(screen.getByText('API is down')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('shows the retry button only when onRetry is provided', () => {
    const { unmount } = render(ErrorState, { props: { message: 'x' } });
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
    unmount();
    render(ErrorState, { props: { message: 'x', onRetry: () => {} } });
    expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run BOTH projects; confirm client passes and server suite still runs**

Run: `pnpm --filter dashboard test`
Expected: the `client` project reports `ErrorState` 3/3; the `server` project
still runs all existing tests (9 files) with the same pass count as before this
branch. Note both project names appear in the output.

- [ ] **Step 6: Mutation proofs**

- In `ErrorState.svelte`, change the default `message = 'Something went wrong'`
  to `'X'` → the default-message test reds. Revert.
- In `ErrorState.svelte`, delete the `{#if onRetry}` wrapper (leave the button
  unconditional) → the "only when onRetry" test reds (button present without a
  handler). Revert with `git checkout --`.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/package.json apps/dashboard/pnpm-lock.yaml \
  ../../pnpm-lock.yaml apps/dashboard/vite.config.ts \
  apps/dashboard/vitest-setup-client.ts \
  apps/dashboard/src/lib/components/ErrorState.svelte.test.ts
git commit -m "test(dashboard): jsdom component-test infra + ErrorState render test"
```
(Adjust the lockfile path to whichever `pnpm-lock.yaml` actually changed.)

---

### Task 2: extract `$lib/format.ts` + node tests + rewire callsites

**Files:**
- Create: `apps/dashboard/src/lib/format.ts`, `apps/dashboard/src/lib/format.test.ts`
- Modify: `+page.svelte`, `analysis/+page.svelte`, `runs/+page.svelte`,
  `runs/[runId]/+page.svelte`, `tests/[testName]/+page.svelte`, `flaky/+page.svelte`

**Interfaces:**
- Produces: `formatDate(s: string|null)`, `formatDateTime(s: string|null)`,
  `formatDuration(ms: number|null)`, `runDurationMs(run: {startedAt: string|null;
  finishedAt: string|null})`, `getPassRate(run: {passed: number; totalTests:
  number})`, `getPassRateClass(rate: number)`, `trendTooltipLabel(value: number|null)`.

- [ ] **Step 1: Create `format.ts`** (verbatim from the current inline copies)

```ts
export function formatDate(dateString: string | null): string {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(dateString: string | null): string {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// startedAt/finishedAt are both nullable; only compute a duration when both are
// present rather than showing a number derived from one missing side.
export function runDurationMs(run: {
  startedAt: string | null;
  finishedAt: string | null;
}): number | null {
  if (!run.startedAt || !run.finishedAt) return null;
  return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

export function getPassRate(run: { passed: number; totalTests: number }): number {
  if (run.totalTests === 0) return 0;
  return (run.passed / run.totalTests) * 100;
}

export function getPassRateClass(passRate: number): string {
  if (passRate >= 90) return 'badge-green';
  if (passRate >= 70) return 'badge-orange';
  return 'badge-red';
}

// A gap day (`value: null` — no runs, NOT "0% flaky") must not render as
// "null%"; say so honestly. See plans/028-honest-visible-trends.md.
export function trendTooltipLabel(value: number | null): string {
  return value === null ? 'no runs' : `${value}%`;
}
```

- [ ] **Step 2: Write `format.test.ts`** (node env — plain `*.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  runDurationMs,
  getPassRate,
  getPassRateClass,
  trendTooltipLabel,
} from './format';

describe('formatDate', () => {
  it('returns the em dash for null', () => {
    expect(formatDate(null)).toBe('—');
  });
  it('includes the year and omits the time', () => {
    const out = formatDate('2026-03-15T13:45:00.000Z');
    expect(out).toContain('2026');
    expect(out).not.toMatch(/\d{1,2}:\d{2}/); // no HH:MM
  });
});

describe('formatDateTime', () => {
  it('returns the em dash for null', () => {
    expect(formatDateTime(null)).toBe('—');
  });
  it('includes a HH:MM time and omits the year', () => {
    const out = formatDateTime('2026-03-15T13:45:00.000Z');
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    expect(out).not.toContain('2026');
  });
});

describe('formatDuration', () => {
  it('is the em dash for null', () => expect(formatDuration(null)).toBe('—'));
  it('is milliseconds under 1000', () => expect(formatDuration(999)).toBe('999ms'));
  it('is seconds with one decimal at/above 1000', () =>
    expect(formatDuration(1500)).toBe('1.5s'));
});

describe('runDurationMs', () => {
  it('is null when either side is missing', () => {
    expect(runDurationMs({ startedAt: null, finishedAt: '2026-01-01T00:00:01Z' })).toBeNull();
    expect(runDurationMs({ startedAt: '2026-01-01T00:00:00Z', finishedAt: null })).toBeNull();
  });
  it('is the elapsed milliseconds when both are present', () => {
    expect(
      runDurationMs({ startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z' })
    ).toBe(2000);
  });
});

describe('getPassRate', () => {
  it('is 0 (not NaN) when there are no tests', () =>
    expect(getPassRate({ passed: 0, totalTests: 0 })).toBe(0));
  it('is the percentage passed', () =>
    expect(getPassRate({ passed: 3, totalTests: 4 })).toBe(75));
});

describe('getPassRateClass', () => {
  it('is green at/above 90', () => expect(getPassRateClass(90)).toBe('badge-green'));
  it('is orange in [70,90)', () => {
    expect(getPassRateClass(89.9)).toBe('badge-orange');
    expect(getPassRateClass(70)).toBe('badge-orange');
  });
  it('is red below 70', () => expect(getPassRateClass(69.9)).toBe('badge-red'));
});

describe('trendTooltipLabel', () => {
  it('says "no runs" for a null gap day, never "null%"', () => {
    expect(trendTooltipLabel(null)).toBe('no runs');
  });
  it('is a percent string for a value', () => {
    expect(trendTooltipLabel(12.5)).toBe('12.5%');
  });
});
```

- [ ] **Step 3: Run node tests, confirm pass**

Run: `pnpm --filter dashboard exec vitest run --project server src/lib/format.test.ts`
Expected: all pass.

- [ ] **Step 4: Mutation proofs (one per function; representative)**

Apply each to `format.ts`, run the file, confirm the named test reds, revert:
- `formatDuration`: `ms < 1000` → `ms < 10` → the "999ms" test reds.
- `getPassRateClass`: `>= 90` → `>= 95` → the "green at 90" test reds.
- `getPassRate`: `if (run.totalTests === 0) return 0;` → delete it → the
  no-tests test reds (NaN).
- `trendTooltipLabel`: `value === null ? 'no runs'` → `` `${value}%` `` always →
  the "no runs" test reds.
- `runDurationMs`: `if (!run.startedAt || !run.finishedAt)` → `if (false)` → the
  either-missing test reds.
Revert each with `git checkout -- apps/dashboard/src/lib/format.ts`.

- [ ] **Step 5: Rewire the six components** (output-preserving)

In each component: delete the inline `formatDate`/`formatDuration`/`runDurationMs`/
`getPassRate`/`getPassRateClass` definitions and add
`import { … } from '$lib/format';`. Map per the Global Constraint:
- `analysis/+page.svelte`, `flaky/+page.svelte`: inline `formatDate` → import `formatDate`.
- `+page.svelte`, `runs/+page.svelte`, `runs/[runId]/+page.svelte`,
  `tests/[testName]/+page.svelte`: inline `formatDate` → import as `formatDateTime`
  (rename the call sites, since these used the time form).
- `runs/+page.svelte`: also `getPassRate`, `getPassRateClass` → import.
- `runs/[runId]/+page.svelte`: also `formatDuration`, `runDurationMs` → import.
- `tests/[testName]/+page.svelte`: also `formatDuration` → import (its inline
  version was non-nullable; the nullable import is a superset — behavior
  unchanged for its number input).
- `+page.svelte` and `tests/[testName]/+page.svelte`: replace the inline chart
  `formatter` body `value === null ? 'no runs' : `${value}%`` with
  `trendTooltipLabel(value)` (import it). Keep the surrounding `p[0].name<br/>…`
  wrapper.

- [ ] **Step 6: Verify no behavior change**

Run: `pnpm --filter dashboard check` → clean.
Run: `pnpm --filter dashboard test` → both projects green, same counts + the new
format tests.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/lib/format.ts apps/dashboard/src/lib/format.test.ts \
  apps/dashboard/src/routes
git commit -m "refactor(dashboard): extract formatting helpers to \$lib/format with tests"
```

---

### Task 3: extend `$lib/status.ts` + node tests + rewire

**Files:**
- Modify: `apps/dashboard/src/lib/status.ts`, `flaky/+page.svelte`,
  `tests/[testName]/+page.svelte`
- Create: `apps/dashboard/src/lib/status.test.ts`

**Interfaces:**
- Consumes: existing `statusBadgeClass(status: string)`.
- Produces: `flakyStatusBadgeClass(status: string)`,
  `trendDirectionLabel(d: TrendDirection)`, `trendDirectionBadgeClass(d: TrendDirection)`.

- [ ] **Step 1: Append to `status.ts`** (keep the existing fn + its comment)

```ts
import type { TrendDirection } from '../app.d';

// Badge class for a `flaky_tests.status` value (active/resolved/ignored — the
// flaky-test lifecycle domain). DELIBERATELY separate from statusBadgeClass
// above: 'active' must be orange here, not fall through to that function's
// 'badge-gray' default. Do not unify the two.
export function flakyStatusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'badge-orange';
    case 'resolved': return 'badge-green';
    case 'ignored': return 'badge-gray';
    default: return 'badge-gray';
  }
}

// Rendered honestly, including 'insufficient-data' — not the same claim as
// 'stable' (plans/028-honest-visible-trends.md decision 4); never disguise one
// as the other.
export function trendDirectionLabel(direction: TrendDirection): string {
  switch (direction) {
    case 'improving': return '↓ Improving';
    case 'worsening': return '↑ Worsening';
    case 'stable': return '→ Stable';
    case 'insufficient-data': return 'Insufficient data';
  }
}

export function trendDirectionBadgeClass(direction: TrendDirection): string {
  switch (direction) {
    case 'improving': return 'badge-green';
    case 'worsening': return 'badge-red';
    case 'stable': return 'badge-gray';
    case 'insufficient-data': return 'badge-gray';
  }
}
```
Confirm the `TrendDirection` import path resolves (it is imported in
`tests/[testName]/+page.svelte` as `from '../../../app.d'`; from `src/lib/` the
path is `'../app.d'`). Verify with `pnpm --filter dashboard check`.

- [ ] **Step 2: Write `status.test.ts`** (node env)

```ts
import { describe, it, expect } from 'vitest';
import {
  statusBadgeClass,
  flakyStatusBadgeClass,
  trendDirectionLabel,
  trendDirectionBadgeClass,
} from './status';

describe('statusBadgeClass (test-result domain)', () => {
  it('maps each known status', () => {
    expect(statusBadgeClass('passed')).toBe('badge-green');
    expect(statusBadgeClass('failed')).toBe('badge-red');
    expect(statusBadgeClass('flaky')).toBe('badge-orange');
    expect(statusBadgeClass('skipped')).toBe('badge-gray');
  });
  it('falls back to gray for the unknown', () =>
    expect(statusBadgeClass('nonsense')).toBe('badge-gray'));
});

describe('flakyStatusBadgeClass (lifecycle domain — distinct from the above)', () => {
  it('makes active ORANGE, not the gray default', () => {
    // The invariant status.ts documents: unifying with statusBadgeClass would
    // silently turn 'active' gray.
    expect(flakyStatusBadgeClass('active')).toBe('badge-orange');
    expect(statusBadgeClass('active')).toBe('badge-gray'); // proves they differ
  });
  it('maps resolved/ignored', () => {
    expect(flakyStatusBadgeClass('resolved')).toBe('badge-green');
    expect(flakyStatusBadgeClass('ignored')).toBe('badge-gray');
  });
});

describe('trend direction', () => {
  it('labels insufficient-data distinctly from stable', () => {
    expect(trendDirectionLabel('insufficient-data')).toBe('Insufficient data');
    expect(trendDirectionLabel('stable')).toBe('→ Stable');
    expect(trendDirectionLabel('insufficient-data')).not.toBe(
      trendDirectionLabel('stable')
    );
  });
  it('badges worsening red and improving green', () => {
    expect(trendDirectionBadgeClass('worsening')).toBe('badge-red');
    expect(trendDirectionBadgeClass('improving')).toBe('badge-green');
  });
});
```

- [ ] **Step 3: Run + mutation proofs**

Run: `pnpm --filter dashboard exec vitest run --project server src/lib/status.test.ts` → pass.
Mutations (revert each):
- `flakyStatusBadgeClass` `case 'active': return 'badge-orange'` → `'badge-gray'`
  → the "active ORANGE" test reds.
- `trendDirectionLabel` `case 'insufficient-data': return 'Insufficient data'` →
  `return '→ Stable'` → the distinctness test reds.
- `statusBadgeClass` `case 'failed': return 'badge-red'` → `'badge-green'` → the
  known-status test reds.

- [ ] **Step 4: Rewire**

- `flaky/+page.svelte`: delete inline `getStatusBadgeClass`; import
  `flakyStatusBadgeClass` and replace the call. (The template uses
  `getStatusBadgeClass(test.status)`.)
- `tests/[testName]/+page.svelte`: delete `DIRECTION_LABEL`/`DIRECTION_BADGE_CLASS`
  consts; import `trendDirectionLabel`/`trendDirectionBadgeClass`; replace the
  `DIRECTION_LABEL[…]`/`DIRECTION_BADGE_CLASS[…]` lookups with the function calls.

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter dashboard check` (clean) and `pnpm --filter dashboard test`.
```bash
git add apps/dashboard/src/lib/status.ts apps/dashboard/src/lib/status.test.ts \
  apps/dashboard/src/routes/flaky apps/dashboard/src/routes/tests
git commit -m "refactor(dashboard): co-locate flaky + trend badge mappings in \$lib/status with tests"
```

---

### Task 4: extract `$lib/error-page.ts` + `$lib/href.ts` + node tests + rewire

**Files:**
- Create: `apps/dashboard/src/lib/error-page.ts` + `.test.ts`,
  `apps/dashboard/src/lib/href.ts` + `.test.ts`
- Modify: `+error.svelte`, `flaky/+page.svelte`, `+layout.svelte`

**Interfaces:**
- Produces: `errorTitle(status: number)`, `errorIcon(status: number)`,
  `appendProjectParam(href: string, projectId: string | undefined)`.

- [ ] **Step 1: Create `error-page.ts`**

```ts
export function errorTitle(status: number): string {
  switch (status) {
    case 404: return 'Page Not Found';
    case 403: return 'Access Denied';
    case 500: return 'Server Error';
    default: return 'Something Went Wrong';
  }
}

export function errorIcon(status: number): string {
  switch (status) {
    case 404: return '🔍';
    case 403: return '🔒';
    case 500: return '⚠️';
    default: return '❌';
  }
}
```

- [ ] **Step 2: Create `href.ts`** (unifies flaky `getFilterHref` + layout `getNavHref`)

```ts
// Append `project=<id>` to a href, choosing `?` or `&` by whether the href
// already has a query string. `undefined` projectId leaves the href untouched.
export function appendProjectParam(href: string, projectId: string | undefined): string {
  if (!projectId) return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}project=${projectId}`;
}
```

- [ ] **Step 3: Write both node tests**

`error-page.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { errorTitle, errorIcon } from './error-page';

describe('errorTitle', () => {
  it('maps the known statuses', () => {
    expect(errorTitle(404)).toBe('Page Not Found');
    expect(errorTitle(403)).toBe('Access Denied');
    expect(errorTitle(500)).toBe('Server Error');
  });
  it('falls back for anything else', () =>
    expect(errorTitle(418)).toBe('Something Went Wrong'));
});

describe('errorIcon', () => {
  it('maps the known statuses', () => {
    expect(errorIcon(404)).toBe('🔍');
    expect(errorIcon(403)).toBe('🔒');
    expect(errorIcon(500)).toBe('⚠️');
  });
  it('falls back for anything else', () => expect(errorIcon(418)).toBe('❌'));
});
```

`href.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { appendProjectParam } from './href';

describe('appendProjectParam', () => {
  it('leaves the href untouched when projectId is undefined', () => {
    expect(appendProjectParam('/flaky?status=active', undefined)).toBe('/flaky?status=active');
  });
  it('uses & when a query string already exists', () => {
    expect(appendProjectParam('/flaky?status=active', 'p1')).toBe('/flaky?status=active&project=p1');
  });
  it('uses ? when there is no query string', () => {
    expect(appendProjectParam('/analysis', 'p1')).toBe('/analysis?project=p1');
  });
});
```

- [ ] **Step 4: Run + mutation proofs**

Run both files under `--project server`. Mutations (revert each):
- `errorIcon` `case 404: return '🔍'` → `'❌'` → the known-status test reds.
- `errorTitle` `case 500: return 'Server Error'` → `'Page Not Found'` → reds.
- `appendProjectParam` `href.includes('?') ? '&' : '?'` → always `'?'` → the
  "uses & when a query string exists" test reds (produces a second `?`).

- [ ] **Step 5: Rewire**

- `+error.svelte`: delete `getErrorTitle`/`getErrorIcon`; import
  `errorTitle`/`errorIcon`; replace calls (`getErrorTitle(status)` →
  `errorTitle(status)`, etc.).
- `flaky/+page.svelte`: replace inline `getFilterHref(status)` body. Keep the
  route-specific base construction but delegate the project append:
  ```ts
  import { appendProjectParam } from '$lib/href';
  function getFilterHref(status: string): string {
    return appendProjectParam(`/flaky?status=${status}`, data.currentProject?.id);
  }
  ```
- `+layout.svelte`: replace `getNavHref`:
  ```ts
  import { appendProjectParam } from '$lib/href';
  function getNavHref(baseHref: string): string {
    return appendProjectParam(baseHref, data.selectedProject?.id);
  }
  ```

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter dashboard check` (clean) + `pnpm --filter dashboard test`.
```bash
git add apps/dashboard/src/lib/error-page.ts apps/dashboard/src/lib/error-page.test.ts \
  apps/dashboard/src/lib/href.ts apps/dashboard/src/lib/href.test.ts \
  apps/dashboard/src/routes
git commit -m "refactor(dashboard): extract error-page + href helpers to \$lib with tests"
```

---

### Task 5: render tests — `analysis` + `runs`

**Files:**
- Create: `apps/dashboard/src/routes/analysis/+page.svelte.test.ts`,
  `apps/dashboard/src/routes/runs/+page.svelte.test.ts`

`analysis/+page.svelte` imports NO `$app/*` (only `$types`), so it renders with
no mocks. `runs/+page.svelte` imports `goto` from `$app/navigation` (used only in
a handler) — add a per-file `vi.mock('$app/navigation', …)`.

Build a minimal `data` object matching each component's `PageData` usage. Assert
on the branch-distinguishing output.

- [ ] **Step 1: `analysis` render test** — cover the three-way + a flaky row

```ts
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import Page from './+page.svelte';

const base = { currentProject: { id: 'p1', name: 'Proj' }, projects: [], windowDays: 14, threshold: 0.05 };

describe('analysis/+page', () => {
  it('shows the no-analysis message when analysis is null', () => {
    render(Page, { props: { data: { ...base, analysis: null } } });
    // assert the "no analysis" copy the template renders under {#if !data.analysis}
    // (read the exact string from the component and assert getByText on it)
  });
  it('shows the empty state when allTests is empty', () => {
    render(Page, { props: { data: { ...base, analysis: { allTests: [], flakyTests: [] } } } });
    // assert the empty-allTests copy
  });
  it('renders a row per test and marks the flaky one', () => {
    render(Page, { props: { data: { ...base, analysis: {
      allTests: [
        { testName: 'a', isFlaky: true, /* +fields the row reads */ },
        { testName: 'b', isFlaky: false },
      ], flakyTests: [{ testName: 'a', isFlaky: true }] } } } });
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
    // assert the isFlaky marker appears on row 'a' (the {#if test.isFlaky} branch)
  });
});
```
Read `analysis/+page.svelte` for the exact empty/null copy and the row fields it
reads; fill the assertions with `getByText`/`queryByText` on those literals.

- [ ] **Step 2: `runs` render test** — empty vs list + pass-rate badge

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
import { render, screen } from '@testing-library/svelte';
import Page from './+page.svelte';

const base = { currentProject: null, projects: [] };

describe('runs/+page', () => {
  it('shows the empty state with no runs', () => {
    render(Page, { props: { data: { ...base, runs: [] } } });
    // assert the empty copy under {#if data.runs.length === 0}
  });
  it('renders a run row with a pass-rate badge', () => {
    render(Page, { props: { data: { ...base, runs: [
      { id: 'r1', passed: 9, totalTests: 10, /* +fields the row reads */ },
    ] } } });
    // 90% -> badge-green (getPassRateClass). Assert the badge element carries
    // the class, e.g. container.querySelector('.badge-green') is present.
  });
});
```

- [ ] **Step 3: Run, confirm pass**

Run: `pnpm --filter dashboard exec vitest run --project client src/routes/analysis src/routes/runs`

- [ ] **Step 4: Mutation proofs**

- `analysis/+page.svelte`: flip `{#if !data.analysis}` → `{#if data.analysis}`
  → the null-analysis test reds.
- `analysis/+page.svelte`: change the empty-state condition
  `{#if data.analysis.allTests.length === 0}` → `=== 1` → the empty test reds.
- `runs/+page.svelte`: the pass-rate badge uses `getPassRateClass` — change the
  9/10 fixture path by mutating `getPassRateClass` threshold in `format.ts`
  (`>= 90` → `>= 91`) → the badge-green assertion reds (row becomes orange).
Revert each.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/routes/analysis/+page.svelte.test.ts \
  apps/dashboard/src/routes/runs/+page.svelte.test.ts
git commit -m "test(dashboard): render tests for analysis and runs pages"
```

---

### Task 6: render tests — `flaky` + `runs/[runId]`

**Files:**
- Create: `apps/dashboard/src/routes/flaky/+page.svelte.test.ts`,
  `apps/dashboard/src/routes/runs/[runId]/+page.svelte.test.ts`

`flaky` needs `vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }))`.
`runs/[runId]` needs `vi.mock('$app/navigation', …)` and imports `ErrorState`
(renders fine) + `statusBadgeClass`.

- [ ] **Step 1: `flaky` render test** — empty-state variants, canMute gating, Mute/Unmute

Cover:
- `data.flakyTests: []` with `status: 'active'` → "No active flaky tests!";
  with `status: 'resolved'` → "No flaky tests found." (two renders).
- Populated + `canMute: false` → no "Actions" header, no Mute button.
- Populated + `canMute: true` with an `active` row → a "Mute" button; with an
  `ignored` row → an "Unmute" button.
- The status badge on a row carries `flakyStatusBadgeClass(status)`.

Representative fixture row: `{ id:'1', testName:'t', testFile:'f', flakeRate:'0.2',
totalRuns:10, firstDetected:null, lastSeen:null, status:'active' }`.

- [ ] **Step 2: `runs/[runId]` render test** — the load three-way + failureDetail

Cover:
- `data.projectId` falsy → the `!projectId` branch copy.
- `projectId` set, `loadFailed: true` → the `loadFailed` branch (renders
  `ErrorState`).
- `runDetail` present, `results: []` → the empty-results copy.
- `runDetail` with a failed result carrying `failureDetail.errors[0].message` →
  the message renders; a result with `failureDetail.stack` → stack section
  present; `showingAll` copy toggles.

- [ ] **Step 3: Run + mutation proofs**

Run: `pnpm --filter dashboard exec vitest run --project client src/routes/flaky "src/routes/runs/[runId]"`
Mutations (revert each):
- `flaky/+page.svelte`: flip `{#if data.status === 'active'}` in the empty state
  → the "No active flaky tests!" test reds.
- `flaky/+page.svelte`: change the Mute gate `{#if test.status === 'active'}` →
  `=== 'resolved'` → the Mute-for-active test reds.
- `runs/[runId]/+page.svelte`: flip the `{#if !data.projectId}` branch → the
  missing-projectId test reds.

- [ ] **Step 4: Commit**

```bash
git add "apps/dashboard/src/routes/flaky/+page.svelte.test.ts" \
  "apps/dashboard/src/routes/runs/[runId]/+page.svelte.test.ts"
git commit -m "test(dashboard): render tests for flaky and run-detail pages"
```

---

### Task 7: `Chart` stub + render tests — `+page` (overview) + `tests/[testName]`

**Files:**
- Create: `apps/dashboard/src/lib/components/Chart.stub.svelte`,
  `apps/dashboard/src/routes/+page.svelte.test.ts`,
  `apps/dashboard/src/routes/tests/[testName]/+page.svelte.test.ts`

- [ ] **Step 1: Create the Chart stub**

`Chart.stub.svelte` (no ECharts, no canvas — just a marker):
```svelte
<script lang="ts">
  // Stub of $lib/components/Chart.svelte for jsdom render tests: renders a
  // marker instead of initialising ECharts (which needs a canvas jsdom lacks).
  let { }: { options?: unknown; height?: string; class?: string } = $props();
</script>
<div data-testid="chart-stub"></div>
```

- [ ] **Step 2: Both render tests mock `Chart` to the stub + `$app/navigation`**

At the top of each test file:
```ts
import { vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/components/Chart.svelte', async () => ({
  default: (await import('$lib/components/Chart.stub.svelte')).default,
}));
```
If the `$lib/...stub` specifier does not resolve inside `vi.mock`, use the
relative path `'../../lib/components/Chart.stub.svelte'` (overview) /
`'../../../lib/components/Chart.stub.svelte'` (tests/[testName]).

- [ ] **Step 3: `+page` (overview) coverage**

- `data.stats` null → the no-stats branch; present → the 4 stat cards
  (`statCards` labels: "Active Flaky Tests", "Resolved This Week", "Total Test
  Runs", "Total Tests Tracked").
- `data.trendData` present → the chart stub renders (`getByTestId('chart-stub')`);
  `partialFailure` (no trendData) → the partial-failure branch copy.
- `data.flakyTests` of length 7 → only 5 rows render (the `slice(0, 5)` cap):
  assert the 6th/7th testName is absent.
- `data.recentRuns: []` → empty copy; populated → rows.

- [ ] **Step 4: `tests/[testName]` coverage**

- `data.testTrend` present → chart stub; `trendFailed` → the failure branch.
- `data.testHistory.flakyInfo` present → the flaky-info block renders.
- direction: `data.testHistory.flakyInfo` with a `direction` of
  `'insufficient-data'` → the "Insufficient data" label (via
  `trendDirectionLabel`) renders, NOT "→ Stable". Read the component for exactly
  where the label is placed.

- [ ] **Step 5: Run + mutation proofs**

Run: `pnpm --filter dashboard exec vitest run --project client src/routes/+page.svelte.test.ts "src/routes/tests/[testName]"`
Mutations (revert each):
- `+page.svelte`: `data.flakyTests.slice(0, 5)` → `slice(0, 7)` → the "only 5
  rows" test reds.
- `+page.svelte`: flip `{#if !data.stats}` → the no-stats test reds.
- `tests/[testName]/+page.svelte`: the direction label lookup → mutate
  `trendDirectionLabel`'s `insufficient-data` case in `status.ts` → the
  "Insufficient data" render test reds.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/lib/components/Chart.stub.svelte \
  apps/dashboard/src/routes/+page.svelte.test.ts \
  "apps/dashboard/src/routes/tests/[testName]/+page.svelte.test.ts"
git commit -m "test(dashboard): render tests for overview and test-detail pages (Chart stubbed)"
```

---

### Task 8: `$app/stores` mock + render tests — `+layout` + `+error`

**Files:**
- Create: `apps/dashboard/src/routes/+layout.svelte.test.ts`,
  `apps/dashboard/src/routes/+error.svelte.test.ts`

Both read the `page` store. Mock `$app/stores` per-file with a Svelte `readable`
whose value the test controls.

- [ ] **Step 1: `+error` render test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { readable } from 'svelte/store';

const pageState = { status: 404, error: { message: 'nope' }, url: new URL('http://localhost/x') };
vi.mock('$app/stores', () => ({ page: readable(pageState) }));

import { render, screen } from '@testing-library/svelte';
import ErrorPage from './+error.svelte';

describe('+error', () => {
  it('renders the title and icon for the status (via errorTitle/errorIcon)', () => {
    render(ErrorPage, { props: {} });
    expect(screen.getByText('Page Not Found')).toBeTruthy(); // 404 -> errorTitle
    expect(screen.getByText('🔍')).toBeTruthy();             // 404 -> errorIcon
    expect(screen.getByText('nope')).toBeTruthy();           // page.error.message
  });
});
```
(A single representative status is enough here — the full status→title/icon
table is exhaustively node-tested in Task 4.)

- [ ] **Step 2: `+layout` render test**

Mock `$app/stores` (`page` with a `url`) and `$app/navigation`. `+layout`
receives a `children` snippet prop — pass a minimal snippet or omit if the
template tolerates it; if a snippet is required, render with a tiny inline
snippet. Cover:
- `data.projects.length > 0` → the project `<select>` renders with an option per
  project; `length === 0` → no switcher.
- `data.apiError` truthy → the error banner renders.
- The active nav item: with `page.url.pathname === '/flaky'`, the Flaky nav item
  carries the active marker (`isActive`).

Read `+layout.svelte` for the exact switcher/banner/active markup and assert on
it. If passing a `children` snippet in a test proves awkward, document it and
assert what renders without children (switcher/banner/nav live outside
`{@render children()}`).

- [ ] **Step 3: Run + mutation proofs**

Run: `pnpm --filter dashboard exec vitest run --project client src/routes/+layout.svelte.test.ts src/routes/+error.svelte.test.ts`
Mutations (revert each):
- `+error.svelte`: the `errorTitle`/`errorIcon` call — mutate `errorTitle`'s 404
  case in `error-page.ts` → the "Page Not Found" test reds.
- `+layout.svelte`: flip `{#if data.projects.length > 0}` → the switcher test reds.
- `+layout.svelte`: the `isActive`/active-class binding — mutate it → the active
  nav test reds.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/+layout.svelte.test.ts \
  apps/dashboard/src/routes/+error.svelte.test.ts
git commit -m "test(dashboard): render tests for layout and error pages"
```

---

### Task 9: Final gate + docs + index

- [ ] **Step 1: Full verification**

```bash
pnpm --filter dashboard test          # both projects green
pnpm --filter dashboard check         # svelte-check clean (TS 6)
pnpm run lint                         # oxlint clean
pnpm --filter dashboard test:e2e      # E2E still 8/8 (real Postgres + built dashboard)
```
Record counts. Confirm the `server` project's count equals the pre-branch count
(no existing test lost) and the `client` project runs the 9 new render suites +
`ErrorState`.

- [ ] **Step 2: Branch diff sanity**

Run: `git diff --name-only main...HEAD`
Expected: the infra files, the 4 `$lib` modules + their tests, the 9
`*.svelte.test.ts`, the Chart stub, the rewired route components, `AGENTS.md`,
`plans/README.md`, spec, plan. The rewired components are the ONLY product
changes and each is an output-preserving extraction.

- [ ] **Step 3: Document the infra in `AGENTS.md`**

Under the dashboard Conventions, add a bullet:
> Dashboard component tests are `*.svelte.test.ts`, run in the Vitest **client**
> project (jsdom, `@testing-library/svelte`); all other `*.test.ts` run in the
> **server** (node) project. Chart-rendering pages stub
> `$lib/components/Chart.svelte` (jsdom has no canvas) — so a rendered assertion
> still cannot catch the chart-registration bug; that stays guarded by
> `chart-registration.test.ts`.

- [ ] **Step 4: Index the plan + flip 044's stale status**

In `plans/README.md`: add the 045 row after 044, and change 044's status from
`OPEN (PR #99, awaiting review/merge)` to `DONE (merged via PR #99, commit b10b4a0)`.
```
| 045 | Stand up jsdom component-test infra for the dashboard, extract pure view-logic to $lib (node-tested), and render-test all 8 route components + ErrorState; A3 of the mutation-testing effort | P3 | L | A1/A2 (plans 042–044) | TODO |
```

- [ ] **Step 5: Commit docs**

```bash
git add AGENTS.md plans/README.md
git commit -m "docs: document dashboard component-test infra and index plan 045"
```

## Self-Review Notes

**Spec coverage:** infra (D2/D4/D5) → Task 1; extractions (D1 extract half) →
Tasks 2–4; render tests for all 9 components (D3) → Tasks 1,5–8; mutation
discipline (D7) → every task's proof step; behavior-preservation (D6) → the
`check`+`test` step after each rewire.

**Deferred exactness:** render tasks (5–8) give the exact branches, fixtures,
and mutations but leave some `getByText` literals to be read from the component
during execution (the spec forbids guessing copy). This is intentional for
author-inline execution; a subagent executor should open each component first.

**Sharp edges:** the two-project + `browser`-condition config (Task 1 smoke
de-risks it); `vi.mock` of a `.svelte` module to the stub (Task 7 gives a
relative-path fallback); the `formatDate`/`formatDateTime` callsite mapping
(Global Constraint + `check` gate).
