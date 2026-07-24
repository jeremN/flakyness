# Rules Console UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard `/admin/[projectId]/rules` console to list, create, edit, delete, reorder, and enable/disable a project's quarantine rules — server-mediated so `ADMIN_TOKEN` never reaches the browser.

**Architecture:** A new SvelteKit route reusing roadmap 4a's server-only `$lib/server/adminApi.ts` client + form-action pattern. Five thin client functions wrap the already-live admin rules API (plan 054, commit `3866a7a`). Two pure `$lib` helpers (`rule-summary.ts`, `rules-validation.ts`) carry the view-logic and are node-unit-tested to be mutation-provable. The `+page.svelte` renders a priority-ordered list with an inline add/edit editor, ▲/▼ reorder, quick enable-toggle, and a two-step delete confirm.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Vitest (node + browser mode via `vitest-browser-svelte`), Playwright (E2E), Tailwind v4, Stryker (mutation).

**Spec:** `docs/superpowers/specs/2026-07-24-rules-console-ui-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **No `ADMIN_TOKEN` in the browser.** All API calls go through the server-only `$lib/server/adminApi.ts` (imported only from `+page.server.ts`); every mutation is a named SvelteKit form action.
- **No new API endpoint** ⇒ no `readAuth`/route-count-guard change. The `/admin/[projectId]/rules` route is auto-covered by the existing `hooks.server.ts` `DASHBOARD_PASSWORD` Basic Auth (it lives under `/admin`).
- **Reorder is all-or-nothing.** The API's `POST .../rules/reorder` requires `order` to be *exactly* the project's current rule id set. The `reorder` action re-fetches the current order server-side (`listRules`), swaps the target with its neighbor, and posts the complete set. Never trust a client-submitted "current order".
- **Delete is a lightweight two-step client confirm** — no typed-name gate (rules are low-stakes/re-addable; `name` is nullable).
- **Blank field ⇒ `null`** ("use the system/project default"), same convention as the 4a Settings form.
- **Decimal `flakeThreshold`** is compared via `Number(...)` and written via the API (which does `.toFixed(4)`); the UI never touches the DB.
- **Consistency invariants** (mirror the API's `checkRuleConsistency`): `exempt` ⇒ no condition fields; `quarantine` ⇒ `conditionType` required; `flake_rate` ⇒ `flakeThreshold`; `consecutive` ⇒ `consecutiveFailures`. The client mirror is UX-only; the API stays the real boundary.
- **Pure `$lib` helpers are node-unit-tested and mutation-provable** — every branch reddable by a mutation. `.svelte` render tests run in **Vitest browser mode** (`*.svelte.test.ts`, run by `pnpm --filter dashboard test:browser`); the default `pnpm --filter dashboard test` stays node-only and excludes them. Route render-test files must NOT carry the `+` prefix (`page.svelte.test.ts`), though the component import keeps `+page.svelte`.
- **Structured logger only** in any server code; never `console.log`.
- **Commits:** single-line conventional-commit subject; **no `Co-Authored-By` trailers**; never `--no-verify`.

## File Structure

**Create:**
- `apps/dashboard/src/lib/rule-summary.ts` — `describeRule(rule)`: one-line human summary for list rows.
- `apps/dashboard/src/lib/rule-summary.test.ts` — node unit tests.
- `apps/dashboard/src/lib/rules-validation.ts` — `validateRuleForm(raw)` + `buildRulePayload(raw, enabled)`.
- `apps/dashboard/src/lib/rules-validation.test.ts` — node unit tests.
- `apps/dashboard/src/routes/admin/[projectId]/rules/+page.server.ts` — `load` + `create`/`update`/`toggle`/`delete`/`reorder` actions.
- `apps/dashboard/src/routes/admin/[projectId]/rules/+page.svelte` — the console UI.
- `apps/dashboard/src/routes/admin/[projectId]/rules/page.server.test.ts` — node tests (mocked `adminApi`).
- `apps/dashboard/src/routes/admin/[projectId]/rules/page.svelte.test.ts` — browser-mode render tests.
- `apps/dashboard/e2e/admin-rules.spec.ts` — E2E round-trip.

**Modify:**
- `apps/dashboard/src/app.d.ts` — add the `QuarantineRule` interface.
- `apps/dashboard/src/lib/server/adminApi.ts` — add `listRules`/`createRule`/`patchRule`/`deleteRule`/`reorderRules`.
- `apps/dashboard/src/lib/server/adminApi.test.ts` — add wiring tests for the 5 functions.
- `apps/dashboard/src/routes/admin/[projectId]/+page.svelte` — add "Manage quarantine rules →" link.
- `scripts/mutation-gate.mjs` — add per-file floors for the two new helpers.
- `plans/README.md` — add the plan-055 row; close backlog item #17.

---

### Task 1: `QuarantineRule` type + admin rules API client

**Files:**
- Modify: `apps/dashboard/src/app.d.ts` (add interface after `AdminProject`)
- Modify: `apps/dashboard/src/lib/server/adminApi.ts` (add 5 functions + import the type)
- Test: `apps/dashboard/src/lib/server/adminApi.test.ts` (extend)

**Interfaces:**
- Consumes: existing `adminFetch`, `AdminApiError`, `MissingAdminTokenError` in `adminApi.ts`.
- Produces:
  - `interface QuarantineRule` (see Step 1) exported from `app.d.ts`.
  - `listRules(id: string): Promise<{ rules: QuarantineRule[] }>`
  - `createRule(id: string, body: Record<string, number | string | boolean | null>): Promise<{ rule: QuarantineRule }>`
  - `patchRule(id: string, ruleId: string, body: Record<string, number | string | boolean | null>): Promise<{ rule: QuarantineRule }>`
  - `deleteRule(id: string, ruleId: string): Promise<{ success: boolean }>`
  - `reorderRules(id: string, order: string[]): Promise<{ success: boolean }>`

- [ ] **Step 1: Add the `QuarantineRule` type**

In `apps/dashboard/src/app.d.ts`, add after the `AdminProject` interface:

```ts
export interface QuarantineRule {
  id: string;
  projectId: string;
  position: number;
  name: string | null;
  enabled: boolean;
  selectorBranch: string | null;
  selectorFile: string | null;
  selectorTag: string | null;
  action: 'quarantine' | 'exempt';
  conditionType: 'flake_rate' | 'consecutive' | null;
  flakeThreshold: number | null;
  minRuns: number | null;
  windowDays: number | null;
  consecutiveFailures: number | null;
  ttlDays: number | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Write the failing client tests**

Append to `apps/dashboard/src/lib/server/adminApi.test.ts` (inside the existing `describe('adminApi auth + wiring', ...)` block, after the DELETE test), and add the imports `listRules, createRule, patchRule, deleteRule, reorderRules` to the top-of-file import from `./adminApi`:

```ts
  it('GETs a project rules list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rules: [] }));
    await listRules('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer admintok');
  });

  it('POSTs a new rule with a JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rule: {} }, 201));
    await createRule('p1', { action: 'exempt' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ action: 'exempt' });
  });

  it('PATCHes a rule by id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rule: {} }));
    await patchRule('p1', 'r1', { enabled: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules/r1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });

  it('DELETEs a rule by id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await deleteRule('p1', 'r1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules/r1');
    expect(init.method).toBe('DELETE');
  });

  it('POSTs the full id order to reorder', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await reorderRules('p1', ['r2', 'r1']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules/reorder');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ order: ['r2', 'r1'] });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/dashboard && rtk proxy pnpm vitest run src/lib/server/adminApi.test.ts`
Expected: FAIL — `listRules`/`createRule`/etc. are not exported.

- [ ] **Step 4: Implement the client functions**

In `apps/dashboard/src/lib/server/adminApi.ts`, add `QuarantineRule` to the type import from `'../../app.d'`, then append after `deleteProject`:

```ts
export function listRules(id: string): Promise<{ rules: QuarantineRule[] }> {
  return adminFetch(`/api/v1/admin/projects/${id}/rules`);
}

export function createRule(
  id: string,
  body: Record<string, number | string | boolean | null>
): Promise<{ rule: QuarantineRule }> {
  return adminFetch(`/api/v1/admin/projects/${id}/rules`, { method: 'POST', body });
}

export function patchRule(
  id: string,
  ruleId: string,
  body: Record<string, number | string | boolean | null>
): Promise<{ rule: QuarantineRule }> {
  return adminFetch(`/api/v1/admin/projects/${id}/rules/${ruleId}`, { method: 'PATCH', body });
}

export function deleteRule(id: string, ruleId: string): Promise<{ success: boolean }> {
  return adminFetch(`/api/v1/admin/projects/${id}/rules/${ruleId}`, { method: 'DELETE' });
}

export function reorderRules(id: string, order: string[]): Promise<{ success: boolean }> {
  return adminFetch(`/api/v1/admin/projects/${id}/rules/reorder`, {
    method: 'POST',
    body: { order },
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/dashboard && rtk proxy pnpm vitest run src/lib/server/adminApi.test.ts`
Expected: PASS (existing + 5 new).

- [ ] **Step 6: Typecheck**

Run: `rtk proxy pnpm --filter dashboard check`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/app.d.ts apps/dashboard/src/lib/server/adminApi.ts apps/dashboard/src/lib/server/adminApi.test.ts
git commit -m "feat(dashboard): admin rules API client + QuarantineRule type"
```

---

### Task 2: `rule-summary.ts` — `describeRule`

**Files:**
- Create: `apps/dashboard/src/lib/rule-summary.ts`
- Test: `apps/dashboard/src/lib/rule-summary.test.ts`

**Interfaces:**
- Consumes: `QuarantineRule` from `../app.d` (Task 1).
- Produces: `describeRule(rule: QuarantineRule): string` — the exact output strings below are asserted by the render (Task 5) and E2E (Task 6) tests, so they must match byte-for-byte (note the `≥` is U+2265).

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/src/lib/rule-summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { describeRule } from './rule-summary';
import type { QuarantineRule } from '../app.d';

function rule(overrides: Partial<QuarantineRule> = {}): QuarantineRule {
  return {
    id: 'r1', projectId: 'p1', position: 0, name: null, enabled: true,
    selectorBranch: null, selectorFile: null, selectorTag: null,
    action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: 0.3,
    minRuns: 5, windowDays: 14, consecutiveFailures: null, ttlDays: null,
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

describe('describeRule', () => {
  it('formats a full flake_rate rule with a branch selector', () => {
    expect(describeRule(rule({ selectorBranch: 'main' }))).toBe(
      'main · flake ≥ 0.30 over ≥ 5 runs / 14d'
    );
  });

  it('formats a consecutive rule', () => {
    expect(
      describeRule(rule({ conditionType: 'consecutive', flakeThreshold: null, minRuns: null, consecutiveFailures: 5, selectorFile: '*e2e*' }))
    ).toBe('*e2e* · 5 consecutive fails / 14d');
  });

  it('formats an exempt rule with a selector', () => {
    expect(
      describeRule(rule({ action: 'exempt', conditionType: null, flakeThreshold: null, minRuns: null, windowDays: null, selectorFile: 'release/*' }))
    ).toBe('exempt · release/*');
  });

  it('formats an exempt rule with no selectors as "all tests"', () => {
    expect(
      describeRule(rule({ action: 'exempt', conditionType: null, flakeThreshold: null, minRuns: null, windowDays: null }))
    ).toBe('exempt · all tests');
  });

  it('omits the scope prefix when a quarantine rule has no selectors', () => {
    expect(describeRule(rule())).toBe('flake ≥ 0.30 over ≥ 5 runs / 14d');
  });

  it('joins multiple selectors and prefixes a tag with #', () => {
    expect(
      describeRule(rule({ selectorBranch: 'main', selectorFile: 'a.spec.ts', selectorTag: 'smoke' }))
    ).toBe('main a.spec.ts #smoke · flake ≥ 0.30 over ≥ 5 runs / 14d');
  });

  it('drops the runs/window clauses when those fields are null', () => {
    expect(describeRule(rule({ minRuns: null, windowDays: null }))).toBe('flake ≥ 0.30');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/dashboard && rtk proxy pnpm vitest run src/lib/rule-summary.test.ts`
Expected: FAIL — cannot find module `./rule-summary`.

- [ ] **Step 3: Implement `describeRule`**

Create `apps/dashboard/src/lib/rule-summary.ts`:

```ts
// One-line human summary of a quarantine rule for the console list. Pure; no
// I/O. Output strings are asserted verbatim by the render + E2E tests — keep
// the `≥` (U+2265) and separators exact.
import type { QuarantineRule } from '../app.d';

export function describeRule(rule: QuarantineRule): string {
  const scope = describeSelectors(rule);
  if (rule.action === 'exempt') {
    return `exempt · ${scope || 'all tests'}`;
  }
  const cond = describeCondition(rule);
  return scope ? `${scope} · ${cond}` : cond;
}

function describeSelectors(rule: QuarantineRule): string {
  const parts: string[] = [];
  if (rule.selectorBranch) parts.push(rule.selectorBranch);
  if (rule.selectorFile) parts.push(rule.selectorFile);
  if (rule.selectorTag) parts.push(`#${rule.selectorTag}`);
  return parts.join(' ');
}

function describeCondition(rule: QuarantineRule): string {
  if (rule.conditionType === 'consecutive') {
    const win = rule.windowDays != null ? ` / ${rule.windowDays}d` : '';
    return `${rule.consecutiveFailures ?? '?'} consecutive fails${win}`;
  }
  if (rule.conditionType === 'flake_rate') {
    const rate = rule.flakeThreshold != null ? rule.flakeThreshold.toFixed(2) : '?';
    const runs = rule.minRuns != null ? ` over ≥ ${rule.minRuns} runs` : '';
    const win = rule.windowDays != null ? ` / ${rule.windowDays}d` : '';
    return `flake ≥ ${rate}${runs}${win}`;
  }
  return 'no condition';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/dashboard && rtk proxy pnpm vitest run src/lib/rule-summary.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/rule-summary.ts apps/dashboard/src/lib/rule-summary.test.ts
git commit -m "feat(dashboard): describeRule rule-summary helper"
```

---

### Task 3: `rules-validation.ts` — client pre-flight + payload builder

**Files:**
- Create: `apps/dashboard/src/lib/rules-validation.ts`
- Test: `apps/dashboard/src/lib/rules-validation.test.ts`

**Interfaces:**
- Consumes: `validateNumericField`, `NumericFieldSpec` from `./admin-validation` (DRY — reuse the existing numeric-bounds check).
- Produces:
  - `validateRuleForm(raw: Record<string, string>): { valid: boolean; errors: Record<string, string> }`
  - `buildRulePayload(raw: Record<string, string>, enabled: boolean): Record<string, number | string | boolean | null>`

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/src/lib/rules-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateRuleForm, buildRulePayload } from './rules-validation';

function raw(o: Record<string, string> = {}): Record<string, string> {
  return { action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3', ...o };
}

describe('validateRuleForm', () => {
  it('accepts a valid flake_rate quarantine rule', () => {
    expect(validateRuleForm(raw()).valid).toBe(true);
  });

  it('accepts a valid consecutive quarantine rule', () => {
    expect(
      validateRuleForm({ action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: '5' }).valid
    ).toBe(true);
  });

  it('accepts an exempt rule with no condition', () => {
    expect(validateRuleForm({ action: 'exempt' }).valid).toBe(true);
  });

  it('rejects an unknown action', () => {
    const r = validateRuleForm({ action: 'nope' });
    expect(r.valid).toBe(false);
    expect(r.errors.action).toBeTruthy();
  });

  it('rejects an exempt rule that carries a condition', () => {
    const r = validateRuleForm({ action: 'exempt', conditionType: 'flake_rate' });
    expect(r.valid).toBe(false);
    expect(r.errors.action).toBe('exempt rules take no condition');
  });

  it('rejects an exempt rule that carries a threshold value', () => {
    const r = validateRuleForm({ action: 'exempt', flakeThreshold: '0.5' });
    expect(r.valid).toBe(false);
    expect(r.errors.action).toBe('exempt rules take no condition');
  });

  it('rejects a quarantine rule with no condition type', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.conditionType).toBe('quarantine rules need a condition');
  });

  it('rejects an unknown condition type', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: 'weird' });
    expect(r.valid).toBe(false);
    expect(r.errors.conditionType).toBe("must be 'flake_rate' or 'consecutive'");
  });

  it('rejects flake_rate with no threshold', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.flakeThreshold).toBe('flake_rate needs a threshold');
  });

  it('rejects consecutive with no failure count', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.consecutiveFailures).toBe('consecutive needs a failure count');
  });

  it('rejects an out-of-bounds threshold', () => {
    const r = validateRuleForm(raw({ flakeThreshold: '2' }));
    expect(r.valid).toBe(false);
    expect(r.errors.flakeThreshold).toBeTruthy();
  });

  it('rejects a non-integer minRuns', () => {
    const r = validateRuleForm(raw({ minRuns: '2.5' }));
    expect(r.valid).toBe(false);
    expect(r.errors.minRuns).toBeTruthy();
  });
});

describe('buildRulePayload', () => {
  it('parses present values and nulls blanks', () => {
    const body = buildRulePayload(raw({ selectorBranch: 'main', minRuns: '5', windowDays: '', name: '' }), true);
    expect(body).toMatchObject({
      action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: 0.3,
      selectorBranch: 'main', minRuns: 5, windowDays: null, name: null, enabled: true,
    });
  });

  it('forces every condition field to null for an exempt rule', () => {
    const body = buildRulePayload({ action: 'exempt', conditionType: 'flake_rate', flakeThreshold: '0.9', consecutiveFailures: '3' }, false);
    expect(body).toMatchObject({
      action: 'exempt', conditionType: null, flakeThreshold: null,
      minRuns: null, windowDays: null, consecutiveFailures: null, enabled: false,
    });
  });

  it('trims selector strings', () => {
    const body = buildRulePayload(raw({ selectorTag: '  smoke  ' }), true);
    expect(body.selectorTag).toBe('smoke');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/dashboard && rtk proxy pnpm vitest run src/lib/rules-validation.test.ts`
Expected: FAIL — cannot find module `./rules-validation`.

- [ ] **Step 3: Implement the helper**

Create `apps/dashboard/src/lib/rules-validation.ts`:

```ts
// Pure, client-safe pre-flight mirroring the API's rule schema
// (apps/api/src/routes/admin.ts quarantineRuleShape + checkRuleConsistency).
// The API stays authoritative; this only blocks obviously-invalid submits for
// fast inline feedback. No I/O, no env: safe to import into a .svelte
// component. Reuses admin-validation's numeric-bounds check (DRY).
import { validateNumericField, type NumericFieldSpec } from './admin-validation';

const RULE_NUMERIC_SPECS: Record<string, NumericFieldSpec> = {
  flakeThreshold: { min: 0, max: 1, integer: false },
  minRuns: { min: 1, max: 100, integer: true },
  windowDays: { min: 1, max: 90, integer: true },
  consecutiveFailures: { min: 1, max: 100, integer: true },
  ttlDays: { min: 1, max: 365, integer: true },
};

export interface RuleValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

// `raw` holds every rule field as a string (form values). Numeric bounds are
// checked first; then the cross-field consistency rule based on `action`.
export function validateRuleForm(raw: Record<string, string>): RuleValidationResult {
  const errors: Record<string, string> = {};

  for (const [field, spec] of Object.entries(RULE_NUMERIC_SPECS)) {
    const msg = validateNumericField(raw[field] ?? '', spec);
    if (msg) errors[field] = msg;
  }

  const action = raw.action ?? '';
  if (action !== 'quarantine' && action !== 'exempt') {
    errors.action = "must be 'quarantine' or 'exempt'";
    return { valid: false, errors };
  }

  const conditionType = (raw.conditionType ?? '').trim();
  const hasThreshold = (raw.flakeThreshold ?? '').trim() !== '';
  const hasConsecutive = (raw.consecutiveFailures ?? '').trim() !== '';

  if (action === 'exempt') {
    if (conditionType !== '' || hasThreshold || hasConsecutive) {
      errors.action = 'exempt rules take no condition';
    }
    return { valid: Object.keys(errors).length === 0, errors };
  }

  // action === 'quarantine'
  if (conditionType === '') {
    errors.conditionType = 'quarantine rules need a condition';
  } else if (conditionType !== 'flake_rate' && conditionType !== 'consecutive') {
    errors.conditionType = "must be 'flake_rate' or 'consecutive'";
  } else if (conditionType === 'flake_rate' && !hasThreshold) {
    errors.flakeThreshold = 'flake_rate needs a threshold';
  } else if (conditionType === 'consecutive' && !hasConsecutive) {
    errors.consecutiveFailures = 'consecutive needs a failure count';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// Maps the raw form strings to a create/patch body. Blank ⇒ null ("use the
// default"); present ⇒ parsed number / trimmed string. `enabled` is the
// checkbox boolean. For exempt rules, condition fields are forced null so a
// leftover value can't sneak through.
export function buildRulePayload(
  raw: Record<string, string>,
  enabled: boolean
): Record<string, number | string | boolean | null> {
  const str = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  const action = raw.action === 'exempt' ? 'exempt' : 'quarantine';

  const payload: Record<string, number | string | boolean | null> = {
    name: str(raw.name ?? ''),
    enabled,
    selectorBranch: str(raw.selectorBranch ?? ''),
    selectorFile: str(raw.selectorFile ?? ''),
    selectorTag: str(raw.selectorTag ?? ''),
    action,
    ttlDays: num(raw.ttlDays ?? ''),
  };

  if (action === 'exempt') {
    payload.conditionType = null;
    payload.flakeThreshold = null;
    payload.minRuns = null;
    payload.windowDays = null;
    payload.consecutiveFailures = null;
  } else {
    const ct = (raw.conditionType ?? '').trim();
    payload.conditionType = ct === '' ? null : ct;
    payload.flakeThreshold = num(raw.flakeThreshold ?? '');
    payload.minRuns = num(raw.minRuns ?? '');
    payload.windowDays = num(raw.windowDays ?? '');
    payload.consecutiveFailures = num(raw.consecutiveFailures ?? '');
  }

  return payload;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/dashboard && rtk proxy pnpm vitest run src/lib/rules-validation.test.ts`
Expected: PASS (15/15).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/rules-validation.ts apps/dashboard/src/lib/rules-validation.test.ts
git commit -m "feat(dashboard): rules-validation form helper"
```

---

### Task 4: `+page.server.ts` — load + actions

**Files:**
- Create: `apps/dashboard/src/routes/admin/[projectId]/rules/+page.server.ts`
- Test: `apps/dashboard/src/routes/admin/[projectId]/rules/page.server.test.ts`

**Interfaces:**
- Consumes: `listProjects`, `listRules`, `createRule`, `patchRule`, `deleteRule`, `reorderRules`, `adminConfigured`, `AdminApiError`, `MissingAdminTokenError` (Task 1); `validateRuleForm`, `buildRulePayload` (Task 3).
- Produces: `load` returning `{ project, rules }`; `actions` = `{ create, update, toggle, delete, reorder }`. Each action returns `{ action, success }` on success or a `fail(...)` tagged `{ action, message | errors }`.

- [ ] **Step 1: Write the failing server tests**

Create `apps/dashboard/src/routes/admin/[projectId]/rules/page.server.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  listProjects: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  patchRule: vi.fn(),
  deleteRule: vi.fn(),
  reorderRules: vi.fn(),
  adminConfigured: vi.fn(() => true),
  AdminApiError: class AdminApiError extends Error {
    statusCode: number;
    constructor(status: number, message: string) {
      super(message);
      this.statusCode = status;
    }
  },
  MissingAdminTokenError: class MissingAdminTokenError extends Error {},
}));

import {
  listProjects, listRules, createRule, patchRule, deleteRule, reorderRules, adminConfigured,
} from '$lib/server/adminApi';
import { load, actions } from './+page.server';

const mockedList = vi.mocked(listProjects);
const mockedListRules = vi.mocked(listRules);
const mockedCreate = vi.mocked(createRule);
const mockedPatch = vi.mocked(patchRule);
const mockedDelete = vi.mocked(deleteRule);
const mockedReorder = vi.mocked(reorderRules);
const mockedAdminConfigured = vi.mocked(adminConfigured);

const project = { id: 'p1', name: 'Proj', stats: { totalRuns: 0, activeFlakyTests: 0 } } as any;
const ruleRow = (id: string, position: number) => ({ id, position }) as any;

function formEvent(fields: Record<string, string>, id = 'p1') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { request: { formData: async () => fd }, params: { projectId: id } } as any;
}

beforeEach(() => {
  mockedList.mockReset();
  mockedListRules.mockReset();
  mockedCreate.mockReset();
  mockedPatch.mockReset();
  mockedDelete.mockReset();
  mockedReorder.mockReset();
  mockedAdminConfigured.mockReturnValue(true);
});

describe('rules load', () => {
  it('returns the project and its rules', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0)] });
    const result = await load({ params: { projectId: 'p1' } } as any);
    expect(result).toEqual({ project, rules: [ruleRow('r1', 0)] });
  });

  it('403s when ADMIN_TOKEN is not configured', async () => {
    mockedAdminConfigured.mockReturnValueOnce(false);
    await expect(load({ params: { projectId: 'p1' } } as any)).rejects.toMatchObject({ status: 403 });
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('404s when the project is not in the list (and never fetches rules)', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    await expect(load({ params: { projectId: 'nope' } } as any)).rejects.toMatchObject({ status: 404 });
    expect(mockedListRules).not.toHaveBeenCalled();
  });

  it('forwards an AdminApiError status from the rules fetch', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedList.mockResolvedValue({ projects: [project] });
    mockedListRules.mockRejectedValue(new AdminApiError(503, 'API down'));
    await expect(load({ params: { projectId: 'p1' } } as any)).rejects.toMatchObject({ status: 503 });
  });
});

describe('create action', () => {
  it('rejects an invalid rule before calling the API', async () => {
    const result = (await actions.create(formEvent({ action: 'exempt', conditionType: 'flake_rate' }))) as any;
    expect(result.status).toBe(400);
    expect(result.data.errors.action).toBeTruthy();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('builds the payload and creates on valid input', async () => {
    mockedCreate.mockResolvedValue({ rule: {} as any });
    const result = (await actions.create(
      formEvent({ action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3', selectorBranch: 'main', enabled: 'on' })
    )) as any;
    expect(mockedCreate).toHaveBeenCalledWith('p1', expect.objectContaining({
      action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: 0.3, selectorBranch: 'main', enabled: true,
    }));
    expect(result).toMatchObject({ action: 'create', success: true });
  });

  it('forwards an API 400 as a fail with the API message', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedCreate.mockRejectedValue(new AdminApiError(400, 'flake_rate needs flakeThreshold'));
    const result = (await actions.create(
      formEvent({ action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3' })
    )) as any;
    expect(result.status).toBe(400);
    expect(result.data.message).toBe('flake_rate needs flakeThreshold');
  });
});

describe('update action', () => {
  it('fails when ruleId is missing', async () => {
    const result = (await actions.update(formEvent({ action: 'exempt' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('patches the rule with the built payload', async () => {
    mockedPatch.mockResolvedValue({ rule: {} as any });
    await actions.update(formEvent({ ruleId: 'r1', action: 'exempt' }));
    expect(mockedPatch).toHaveBeenCalledWith('p1', 'r1', expect.objectContaining({ action: 'exempt', conditionType: null }));
  });
});

describe('toggle action', () => {
  it('patches only the enabled flag to the requested value', async () => {
    mockedPatch.mockResolvedValue({ rule: {} as any });
    await actions.toggle(formEvent({ ruleId: 'r1', enabled: 'false' }));
    expect(mockedPatch).toHaveBeenCalledWith('p1', 'r1', { enabled: false });
  });
});

describe('delete action', () => {
  it('deletes the rule by id', async () => {
    mockedDelete.mockResolvedValue({ success: true });
    const result = (await actions.delete(formEvent({ ruleId: 'r1' }))) as any;
    expect(mockedDelete).toHaveBeenCalledWith('p1', 'r1');
    expect(result).toMatchObject({ action: 'delete', success: true });
  });
});

describe('reorder action', () => {
  it('re-fetches the current order, swaps up, and posts the full set', async () => {
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0), ruleRow('r2', 1)] });
    mockedReorder.mockResolvedValue({ success: true });
    await actions.reorder(formEvent({ ruleId: 'r2', direction: 'up' }));
    expect(mockedReorder).toHaveBeenCalledWith('p1', ['r2', 'r1']);
  });

  it('is a guarded no-op at the top (no API call)', async () => {
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0), ruleRow('r2', 1)] });
    const result = (await actions.reorder(formEvent({ ruleId: 'r1', direction: 'up' }))) as any;
    expect(mockedReorder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'reorder', success: true });
  });

  it('rejects a bad direction', async () => {
    const result = (await actions.reorder(formEvent({ ruleId: 'r1', direction: 'sideways' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedListRules).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/dashboard && rtk proxy pnpm vitest run 'src/routes/admin/[projectId]/rules/page.server.test.ts'`
Expected: FAIL — cannot find module `./+page.server`.

- [ ] **Step 3: Implement the page server**

Create `apps/dashboard/src/routes/admin/[projectId]/rules/+page.server.ts`:

```ts
import type { PageServerLoad, Actions } from './$types';
import { error, fail } from '@sveltejs/kit';
import {
  listProjects,
  listRules,
  createRule,
  patchRule,
  deleteRule,
  reorderRules,
  adminConfigured,
  AdminApiError,
  MissingAdminTokenError,
} from '$lib/server/adminApi';
import { validateRuleForm, buildRulePayload } from '$lib/rules-validation';

export const load: PageServerLoad = async ({ params }) => {
  if (!adminConfigured()) throw error(403, 'ADMIN_TOKEN not set.');

  let projects;
  try {
    ({ projects } = await listProjects());
  } catch (e) {
    const status = e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load project');
  }
  const project = projects.find((p) => p.id === params.projectId);
  if (!project) throw error(404, 'Project not found');

  let rules;
  try {
    ({ rules } = await listRules(params.projectId));
  } catch (e) {
    const status = e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load rules');
  }

  return { project, rules };
};

// Maps an adminApi throw to the right `fail`, tagged with the action name so
// the page can route feedback to the correct spot.
function actionError(action: string, e: unknown) {
  if (e instanceof MissingAdminTokenError) return fail(403, { action, message: e.message });
  if (e instanceof AdminApiError) return fail(e.statusCode, { action, message: e.message });
  return fail(502, { action, message: 'Unexpected error contacting the API.' });
}

// Every string field the rule form submits. Collected into a flat record so
// validateRuleForm / buildRulePayload can operate on it.
const RULE_FIELDS = [
  'name', 'selectorBranch', 'selectorFile', 'selectorTag',
  'action', 'conditionType', 'flakeThreshold', 'minRuns',
  'windowDays', 'consecutiveFailures', 'ttlDays',
];

function readRuleForm(form: FormData): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const f of RULE_FIELDS) raw[f] = String(form.get(f) ?? '');
  return raw;
}

export const actions = {
  create: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'create', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const raw = readRuleForm(form);
    const { valid, errors } = validateRuleForm(raw);
    if (!valid) return fail(400, { action: 'create', errors });
    try {
      await createRule(params.projectId, buildRulePayload(raw, form.get('enabled') != null));
      return { action: 'create', success: true };
    } catch (e) {
      return actionError('create', e);
    }
  },

  update: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'update', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'update', message: 'Missing rule id.' });
    const raw = readRuleForm(form);
    const { valid, errors } = validateRuleForm(raw);
    if (!valid) return fail(400, { action: 'update', errors });
    try {
      await patchRule(params.projectId, ruleId, buildRulePayload(raw, form.get('enabled') != null));
      return { action: 'update', success: true };
    } catch (e) {
      return actionError('update', e);
    }
  },

  toggle: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'toggle', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'toggle', message: 'Missing rule id.' });
    const enabled = String(form.get('enabled') ?? '') === 'true';
    try {
      await patchRule(params.projectId, ruleId, { enabled });
      return { action: 'toggle', success: true };
    } catch (e) {
      return actionError('toggle', e);
    }
  },

  delete: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'delete', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'delete', message: 'Missing rule id.' });
    try {
      await deleteRule(params.projectId, ruleId);
      return { action: 'delete', success: true };
    } catch (e) {
      return actionError('delete', e);
    }
  },

  reorder: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'reorder', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    const direction = String(form.get('direction') ?? '');
    if (ruleId === '' || (direction !== 'up' && direction !== 'down')) {
      return fail(400, { action: 'reorder', message: 'Invalid reorder request.' });
    }

    // Source the current order server-side — the reorder API demands the exact
    // current id set, so a stale client order can't be trusted.
    let order: string[];
    try {
      const { rules } = await listRules(params.projectId);
      order = rules.map((r) => r.id);
    } catch (e) {
      return actionError('reorder', e);
    }

    const idx = order.indexOf(ruleId);
    if (idx === -1) return fail(400, { action: 'reorder', message: 'Rule not found.' });
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= order.length) {
      // Already at the end in that direction — guarded no-op, no API call.
      return { action: 'reorder', success: true };
    }
    [order[idx], order[swapWith]] = [order[swapWith], order[idx]];

    try {
      await reorderRules(params.projectId, order);
      return { action: 'reorder', success: true };
    } catch (e) {
      return actionError('reorder', e);
    }
  },
} satisfies Actions;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/dashboard && rtk proxy pnpm vitest run 'src/routes/admin/[projectId]/rules/page.server.test.ts'`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Typecheck**

Run: `rtk proxy pnpm --filter dashboard check`
Expected: 0 errors. (The `+page.svelte` does not exist yet; `./$types` still resolves for the server module.)

- [ ] **Step 6: Commit**

```bash
git add 'apps/dashboard/src/routes/admin/[projectId]/rules/+page.server.ts' 'apps/dashboard/src/routes/admin/[projectId]/rules/page.server.test.ts'
git commit -m "feat(dashboard): rules console page server (load + actions)"
```

---

### Task 5: `+page.svelte` — the console UI

**Files:**
- Create: `apps/dashboard/src/routes/admin/[projectId]/rules/+page.svelte`
- Test: `apps/dashboard/src/routes/admin/[projectId]/rules/page.svelte.test.ts`

**Interfaces:**
- Consumes: `PageData` from `./$types` (`{ project, rules }`, Task 4); `describeRule` from `$lib/rule-summary` (Task 2); `enhance` from `$app/forms`.
- Produces: the rendered console. Form field `name` values and action targets (`?/create`, `?/update`, `?/toggle`, `?/delete`, `?/reorder`) must match Task 4's action names and `RULE_FIELDS`.

- [ ] **Step 1: Write the component**

Create `apps/dashboard/src/routes/admin/[projectId]/rules/+page.svelte`:

```svelte
<script lang="ts">
  import type { PageData } from './$types';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { describeRule } from '$lib/rule-summary';

  type Rule = PageData['rules'][number];

  interface RulesFormResult {
    action?: 'create' | 'update' | 'toggle' | 'delete' | 'reorder';
    success?: boolean;
    errors?: Record<string, string>;
    message?: string;
  }
  interface Props {
    data: PageData;
    form: RulesFormResult | null;
  }
  let { data, form }: Props = $props();

  const project = $derived(data.project);
  const rules = $derived(data.rules);

  // Editor state: null = closed, 'new' = create, otherwise the ruleId to edit.
  let editing = $state<string | null>(null);
  // The selected action/condition drive which editor fields are shown; seeded
  // when the editor opens so an edit starts from the rule's own values.
  let formAction = $state<'quarantine' | 'exempt'>('quarantine');
  let formCondition = $state<'flake_rate' | 'consecutive'>('flake_rate');
  // Which row is showing its inline delete confirm.
  let confirmingDelete = $state<string | null>(null);

  const editErrors = $derived(
    (form?.action === 'create' || form?.action === 'update') && form.errors ? form.errors : {}
  );

  const editingRule = $derived(
    editing && editing !== 'new' ? rules.find((r) => r.id === editing) : undefined
  );

  function openCreate() {
    editing = 'new';
    formAction = 'quarantine';
    formCondition = 'flake_rate';
    confirmingDelete = null;
  }
  function openEdit(rule: Rule) {
    editing = rule.id;
    formAction = rule.action;
    formCondition = rule.conditionType === 'consecutive' ? 'consecutive' : 'flake_rate';
    confirmingDelete = null;
  }
  function closeEditor() {
    editing = null;
  }

  function num(n: number | null | undefined): string {
    return n == null ? '' : String(n);
  }

  // Close the editor only when the submit actually succeeded.
  const enhanceEditor: SubmitFunction = () => async ({ result, update }) => {
    await update();
    if (result.type === 'success') closeEditor();
  };
</script>

<svelte:head>
  <title>{project.name} · Rules | Flackyness</title>
</svelte:head>

<div class="mb-8">
  <a href="/admin/{project.id}" class="text-sm text-purple-600 hover:underline">&larr; Back to {project.name}</a>
  <h1 class="text-2xl font-bold text-gray-900 mt-2">Quarantine rules</h1>
  <p class="text-muted">
    Evaluated top-to-bottom; the first matching rule wins. No match falls back to the project's
    quarantine threshold.
  </p>
</div>

{#if (form?.action === 'reorder' || form?.action === 'toggle' || form?.action === 'delete') && form.message}
  <p class="text-sm text-red-600 mb-3">{form.message}</p>
{/if}

<section class="card p-6 max-w-3xl mb-8">
  <div class="flex items-center justify-between mb-4">
    <h2 class="text-lg font-semibold text-gray-900">Rules ({rules.length})</h2>
    <button type="button" class="pill-btn pill-btn-primary" onclick={openCreate}>+ Add rule</button>
  </div>

  {#if rules.length === 0}
    <p class="text-sm text-muted">
      No rules yet. Tests are quarantined using the project's quarantine threshold until you add one.
    </p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each rules as rule, i (rule.id)}
        <li
          class="flex items-center gap-3 border border-subtle rounded-lg px-3 py-2"
          class:opacity-50={!rule.enabled}
        >
          <span class="text-xs text-muted w-6 tabular-nums">#{i + 1}</span>

          <div class="flex flex-col leading-none">
            <form method="POST" action="?/reorder" use:enhance>
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="direction" value="up" />
              <button
                type="submit"
                disabled={i === 0}
                aria-label="Move up"
                class="text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed"
              >▲</button>
            </form>
            <form method="POST" action="?/reorder" use:enhance>
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="direction" value="down" />
              <button
                type="submit"
                disabled={i === rules.length - 1}
                aria-label="Move down"
                class="text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed"
              >▼</button>
            </form>
          </div>

          <div class="flex-1 min-w-0">
            {#if rule.name}<span class="text-sm font-medium text-gray-900 block">{rule.name}</span>{/if}
            <span class="text-sm text-gray-700 block truncate">{describeRule(rule)}</span>
          </div>

          <span
            class="text-xs px-2 py-0.5 rounded-full {rule.action === 'exempt'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-amber-100 text-amber-700'}"
          >{rule.action}</span>

          <form method="POST" action="?/toggle" use:enhance>
            <input type="hidden" name="ruleId" value={rule.id} />
            <input type="hidden" name="enabled" value={(!rule.enabled).toString()} />
            <button type="submit" class="pill-btn pill-btn-ghost text-xs">
              {rule.enabled ? 'Disable' : 'Enable'}
            </button>
          </form>

          <button type="button" class="pill-btn pill-btn-ghost text-xs" onclick={() => openEdit(rule)}>Edit</button>

          {#if confirmingDelete === rule.id}
            <form method="POST" action="?/delete" use:enhance class="flex items-center gap-1">
              <input type="hidden" name="ruleId" value={rule.id} />
              <span class="text-xs text-red-600">Delete?</span>
              <button type="submit" class="pill-btn bg-red-600 text-white text-xs">Yes</button>
              <button type="button" class="pill-btn pill-btn-ghost text-xs" onclick={() => (confirmingDelete = null)}>No</button>
            </form>
          {:else}
            <button
              type="button"
              class="pill-btn pill-btn-ghost text-xs text-red-600"
              onclick={() => (confirmingDelete = rule.id)}
            >Delete</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if editing !== null}
  <section class="card p-6 max-w-3xl mb-8">
    <h2 class="text-lg font-semibold text-gray-900 mb-4">
      {editing === 'new' ? 'Add rule' : 'Edit rule'}
    </h2>
    <form
      method="POST"
      action={editing === 'new' ? '?/create' : '?/update'}
      use:enhance={enhanceEditor}
      class="flex flex-col gap-4"
    >
      {#if editing !== 'new' && editingRule}
        <input type="hidden" name="ruleId" value={editingRule.id} />
      {/if}

      <div>
        <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name (optional)</label>
        <input id="name" name="name" type="text" value={editingRule?.name ?? ''} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div>
          <label for="selectorBranch" class="block text-sm font-medium text-gray-700 mb-1">Branch glob</label>
          <input id="selectorBranch" name="selectorBranch" type="text" placeholder="main" value={editingRule?.selectorBranch ?? ''} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label for="selectorFile" class="block text-sm font-medium text-gray-700 mb-1">File glob</label>
          <input id="selectorFile" name="selectorFile" type="text" placeholder="*e2e*" value={editingRule?.selectorFile ?? ''} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label for="selectorTag" class="block text-sm font-medium text-gray-700 mb-1">Tag</label>
          <input id="selectorTag" name="selectorTag" type="text" value={editingRule?.selectorTag ?? ''} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      <div>
        <label for="action" class="block text-sm font-medium text-gray-700 mb-1">Action</label>
        <select id="action" name="action" bind:value={formAction} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm">
          <option value="quarantine">Quarantine</option>
          <option value="exempt">Exempt</option>
        </select>
      </div>

      {#if formAction === 'quarantine'}
        <div>
          <label for="conditionType" class="block text-sm font-medium text-gray-700 mb-1">Condition</label>
          <select id="conditionType" name="conditionType" bind:value={formCondition} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm">
            <option value="flake_rate">Flake rate</option>
            <option value="consecutive">Consecutive failures</option>
          </select>
        </div>

        {#if formCondition === 'flake_rate'}
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label for="flakeThreshold" class="block text-sm font-medium text-gray-700 mb-1">Threshold (0–1)</label>
              <input id="flakeThreshold" name="flakeThreshold" type="text" value={num(editingRule?.flakeThreshold)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.flakeThreshold}<p class="text-xs text-red-600 mt-1">{editErrors.flakeThreshold}</p>{/if}
            </div>
            <div>
              <label for="minRuns" class="block text-sm font-medium text-gray-700 mb-1">Min runs (1–100)</label>
              <input id="minRuns" name="minRuns" type="text" value={num(editingRule?.minRuns)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.minRuns}<p class="text-xs text-red-600 mt-1">{editErrors.minRuns}</p>{/if}
            </div>
            <div>
              <label for="windowDays" class="block text-sm font-medium text-gray-700 mb-1">Window days (1–90)</label>
              <input id="windowDays" name="windowDays" type="text" value={num(editingRule?.windowDays)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.windowDays}<p class="text-xs text-red-600 mt-1">{editErrors.windowDays}</p>{/if}
            </div>
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="consecutiveFailures" class="block text-sm font-medium text-gray-700 mb-1">Consecutive fails (1–100)</label>
              <input id="consecutiveFailures" name="consecutiveFailures" type="text" value={num(editingRule?.consecutiveFailures)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.consecutiveFailures}<p class="text-xs text-red-600 mt-1">{editErrors.consecutiveFailures}</p>{/if}
            </div>
            <div>
              <label for="windowDays" class="block text-sm font-medium text-gray-700 mb-1">Window days (1–90)</label>
              <input id="windowDays" name="windowDays" type="text" value={num(editingRule?.windowDays)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.windowDays}<p class="text-xs text-red-600 mt-1">{editErrors.windowDays}</p>{/if}
            </div>
          </div>
        {/if}

        <div class="max-w-xs">
          <label for="ttlDays" class="block text-sm font-medium text-gray-700 mb-1">Quarantine TTL days (1–365, optional)</label>
          <input id="ttlDays" name="ttlDays" type="text" value={num(editingRule?.ttlDays)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
          {#if editErrors.ttlDays}<p class="text-xs text-red-600 mt-1">{editErrors.ttlDays}</p>{/if}
        </div>
      {/if}

      <label class="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="enabled" checked={editingRule?.enabled ?? true} />
        Enabled
      </label>

      {#if editErrors.action}<p class="text-sm text-red-600">{editErrors.action}</p>{/if}
      {#if editErrors.conditionType}<p class="text-sm text-red-600">{editErrors.conditionType}</p>{/if}
      {#if (form?.action === 'create' || form?.action === 'update') && form.message}
        <p class="text-sm text-red-600">{form.message}</p>
      {/if}

      <div class="flex gap-2">
        <button type="submit" class="pill-btn pill-btn-primary">
          {editing === 'new' ? 'Create rule' : 'Save rule'}
        </button>
        <button type="button" class="pill-btn pill-btn-ghost" onclick={closeEditor}>Cancel</button>
      </div>
    </form>
  </section>
{/if}
```

- [ ] **Step 2: Write the failing render tests**

Create `apps/dashboard/src/routes/admin/[projectId]/rules/page.svelte.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const project = { id: 'p1', name: 'Proj', stats: { totalRuns: 0, activeFlakyTests: 0 } } as any;

function rule(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'r1', projectId: 'p1', position: 0, name: null, enabled: true,
    selectorBranch: 'main', selectorFile: null, selectorTag: null,
    action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: 0.3,
    minRuns: 5, windowDays: 14, consecutiveFailures: null, ttlDays: null,
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

describe('admin rules page', () => {
  it('lists rules in order with their summaries', async () => {
    render(Page, {
      props: {
        data: {
          project,
          rules: [
            rule(),
            rule({ id: 'r2', action: 'exempt', conditionType: null, flakeThreshold: null, minRuns: null, windowDays: null, selectorBranch: null, selectorFile: 'release/*' }),
          ],
        },
        form: null,
      },
    });
    await expect.element(page.getByText('main · flake ≥ 0.30 over ≥ 5 runs / 14d')).toBeInTheDocument();
    await expect.element(page.getByText('exempt · release/*')).toBeInTheDocument();
  });

  it('shows the empty state when there are no rules', async () => {
    render(Page, { props: { data: { project, rules: [] }, form: null } });
    await expect.element(page.getByText(/No rules yet/)).toBeInTheDocument();
  });

  it('opens the editor with flake_rate fields when editing a flake_rate rule', async () => {
    render(Page, { props: { data: { project, rules: [rule()] }, form: null } });
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect.element(page.getByLabelText('Threshold (0–1)')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Min runs (1–100)')).toBeInTheDocument();
  });

  it('hides condition fields when editing an exempt rule', async () => {
    render(Page, {
      props: {
        data: { project, rules: [rule({ action: 'exempt', conditionType: null, flakeThreshold: null, minRuns: null, windowDays: null })] },
        form: null,
      },
    });
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect.element(page.getByLabelText('Threshold (0–1)')).not.toBeInTheDocument();
    await expect.element(page.getByLabelText('Condition')).not.toBeInTheDocument();
  });

  it('disables the up arrow on the first rule', async () => {
    render(Page, { props: { data: { project, rules: [rule(), rule({ id: 'r2' })] }, form: null } });
    await expect.element(page.getByRole('button', { name: 'Move up' }).first()).toBeDisabled();
  });
});
```

- [ ] **Step 3: Run the render tests (browser mode)**

Run: `cd apps/dashboard && rtk proxy pnpm test:browser 'src/routes/admin/[projectId]/rules/page.svelte.test.ts'`
Expected: PASS (5/5).

- [ ] **Step 4: Typecheck**

Run: `rtk proxy pnpm --filter dashboard check`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add 'apps/dashboard/src/routes/admin/[projectId]/rules/+page.svelte' 'apps/dashboard/src/routes/admin/[projectId]/rules/page.svelte.test.ts'
git commit -m "feat(dashboard): rules console page component"
```

---

### Task 6: Link from the project page + E2E round-trip

**Files:**
- Modify: `apps/dashboard/src/routes/admin/[projectId]/+page.svelte` (add the link)
- Create: `apps/dashboard/e2e/admin-rules.spec.ts`
- Modify: `plans/README.md` (add plan-055 row; mark backlog #17 done)

**Interfaces:**
- Consumes: the `/admin/[projectId]/rules` route (Tasks 4–5); the existing `/admin/new` create flow + `/admin` list (for E2E project setup).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the link on the project page**

In `apps/dashboard/src/routes/admin/[projectId]/+page.svelte`, inside the header `<div class="mb-8">`, add the link immediately after the `<p class="text-muted">…active flaky</p>` block:

```svelte
  <a href="/admin/{project.id}/rules" class="text-sm text-purple-600 hover:underline">
    Manage quarantine rules &rarr;
  </a>
```

- [ ] **Step 2: Write the E2E spec**

Create `apps/dashboard/e2e/admin-rules.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('quarantine rules console', () => {
  test('adds, reorders, edits, and deletes rules', async ({ page }) => {
    const name = `e2e-rules-${Date.now()}`;

    // Create a project via the admin UI, then open its rules console.
    await page.goto('/admin/new');
    await page.getByLabel('Project name').fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByTestId('token-reveal')).toBeVisible();

    await page.goto('/admin');
    await page.getByRole('row', { name: new RegExp(name) }).getByRole('link', { name: 'Manage' }).click();
    await page.getByRole('link', { name: /Manage quarantine rules/ }).click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByText(/No rules yet/)).toBeVisible();

    // Add a flake_rate rule.
    await page.getByRole('button', { name: '+ Add rule' }).click();
    await page.getByLabel('Branch glob').fill('main');
    await page.getByLabel('Threshold (0–1)').fill('0.3');
    await page.getByRole('button', { name: 'Create rule' }).click();
    await expect(page.getByText(/main · flake ≥ 0.30/)).toBeVisible();

    // Add an exempt rule (appended below the first).
    await page.getByRole('button', { name: '+ Add rule' }).click();
    await page.getByLabel('Action').selectOption('exempt');
    await page.getByLabel('File glob').fill('release/*');
    await page.getByRole('button', { name: 'Create rule' }).click();
    await expect(page.getByText('exempt · release/*')).toBeVisible();

    // Reorder: move the exempt rule (row 2) up; it should become row 1.
    const items = page.getByRole('listitem');
    await items.nth(1).getByRole('button', { name: 'Move up' }).click();
    await expect(page.getByRole('listitem').first()).toContainText('exempt · release/*');

    // Edit the flake_rate rule's threshold.
    await page.getByRole('listitem').filter({ hasText: 'flake ≥' }).getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Threshold (0–1)').fill('0.5');
    await page.getByRole('button', { name: 'Save rule' }).click();
    await expect(page.getByText(/flake ≥ 0.50/)).toBeVisible();

    // Delete the exempt rule via the two-step confirm.
    const exemptRow = page.getByRole('listitem').filter({ hasText: 'exempt · release/*' });
    await exemptRow.getByRole('button', { name: 'Delete' }).click();
    await exemptRow.getByRole('button', { name: 'Yes' }).click();
    await expect(page.getByText('exempt · release/*')).not.toBeVisible();
  });
});
```

- [ ] **Step 3: Run the E2E suite**

Run: `rtk proxy pnpm --filter dashboard test:e2e admin-rules`
Expected: PASS (1 test). (The E2E webServer already sets `ADMIN_TOKEN` and `ORIGIN`; if the whole suite is run, the pre-existing `admin.spec.ts` also passes.)

- [ ] **Step 4: Update `plans/README.md`**

Add a row to the plans table (after the `054` row), matching the existing column format:

```
| 055 | Roadmap #4b fast-follow: rules console UI — `/admin/[projectId]/rules` dashboard screen (list, create, edit, delete, reorder, enable-toggle) over plan 054's admin rules API. Server-only `adminApi.ts` + form actions (no `ADMIN_TOKEN` in the browser); pure `$lib` helpers `rule-summary.ts` + `rules-validation.ts`; reorder re-fetches the authoritative order server-side; delete is a two-step client confirm | P2 | S | 054 (hard; consumes its admin rules API) | OPEN |
```

Then update backlog item **#17** ("Rules console UI is the sanctioned fast-follow"): change its `[OPEN — …]` marker to `[DONE — plan 055]` and append a one-line note: `Shipped in plan 055 (this branch).`

- [ ] **Step 5: Commit**

```bash
git add 'apps/dashboard/src/routes/admin/[projectId]/+page.svelte' apps/dashboard/e2e/admin-rules.spec.ts plans/README.md
git commit -m "feat(dashboard): link rules console from project page + E2E"
```

---

### Task 7: Mutation-gate floors for the rule helpers

**Files:**
- Modify: `scripts/mutation-gate.mjs` (add two entries to the `HARDENED` array)

**Interfaces:**
- Consumes: `rule-summary.ts` (Task 2), `rules-validation.ts` (Task 3) and their tests.
- Produces: enforced per-file mutation floors so a future regression that guts a helper's assertions fails the nightly `Mutation` gate.

**Note:** `apps/dashboard/stryker.conf.mjs` already mutates `['src/lib/**/*.ts', '!src/lib/**/*.test.ts']`, so both new helpers are covered automatically — **no config edit needed.** This task mirrors plan 054's Task 5 (which added `services/rules.ts` at floor 84 from a measured 89.23%).

- [ ] **Step 1: Measure the per-file mutation scores**

Run: `cd apps/dashboard && rtk proxy pnpm test:mutation`
Expected: Stryker runs against `$lib` (no Postgres needed) and prints a per-file clear-text table. Record the `% score` for `src/lib/rule-summary.ts` and `src/lib/rules-validation.ts` (the pure helpers should score high, like `format.ts`'s 96.88%). If either is below ~85%, the tests have a mutation gap — strengthen the Task 2/3 tests until the surviving mutant is killed **before** setting a floor (a floor must never paper over a real gap).

- [ ] **Step 2: Add the floors to `HARDENED`**

In `scripts/mutation-gate.mjs`, add two entries to the `HARDENED` array alongside the existing dashboard rows (the ones with `report: 'apps/dashboard/reports/mutation/mutation.json'`). Match the exact object shape and the trailing `// baseline: <score>%` comment; set each `floor` to `floor(measured) − 5` (the repo convention — never above the measured score):

```js
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/rule-summary.ts',     floor: /* floor(measured)-5 */ }, // baseline: <measured>%
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/rules-validation.ts', floor: /* floor(measured)-5 */ }, // baseline: <measured>%
```

Replace each `/* … */` with the computed integer and `<measured>` with the recorded score.

- [ ] **Step 3: Verify the two new floors pass (dashboard report only)**

The bare `node scripts/mutation-gate.mjs` reads BOTH package reports and would error on the missing `apps/api` report locally, so verify just the dashboard entries against the report produced in Step 1 using the module's exported `evaluate()`:

Run:
```bash
node --input-type=module -e "
import { evaluate, HARDENED } from './scripts/mutation-gate.mjs';
import { readFileSync } from 'node:fs';
const dash = HARDENED.filter((h) => h.report.includes('dashboard'));
const { ok, results } = evaluate(dash, (p) => JSON.parse(readFileSync(p, 'utf8')));
for (const r of results) console.log(\`\${r.pass ? 'PASS' : 'FAIL'} \${r.score.toFixed(1)}% (floor \${r.floor}) \${r.file}\`);
process.exit(ok ? 0 : 1);
"
```
Expected: exit 0; `rule-summary.ts` and `rules-validation.ts` both listed as PASS at/above their new floors. (The full cross-package `node scripts/mutation-gate.mjs` runs in the nightly `Mutation` workflow, which produces both reports.)

- [ ] **Step 4: Commit**

```bash
git add scripts/mutation-gate.mjs
git commit -m "test(dashboard): mutation-gate floors for rules helpers"
```

---

## Final verification (run after all tasks)

- `rtk proxy pnpm --filter dashboard test` — node suite green (excludes `*.svelte.test.ts`).
- `rtk proxy pnpm --filter dashboard test:browser` — render suite green.
- `rtk proxy pnpm --filter dashboard test:e2e` — E2E green.
- `rtk proxy pnpm --filter dashboard check` — svelte-check 0 errors.
- `rtk proxy pnpm lint` — oxlint clean.

## Deferred follow-ups (not in this plan)

- Rule dry-run / preview against recent runs (needs a new API endpoint).
- Drag-and-drop reorder (enhancement over the ▲/▼ baseline).
- Bulk enable/disable / multi-select.
