# Admin Console UI (Roadmap 4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a password-gated `/admin` web console that lets an operator manage projects end-to-end — list, edit every per-project knob, create, rotate token, prune, delete — without ever shipping `ADMIN_TOKEN` to the browser.

**Architecture:** A gated `/admin` route tree in the SvelteKit dashboard. Reads go through a new server-only `$lib/server/adminApi.ts` (attaches `Authorization: Bearer ${ADMIN_TOKEN}`); writes go through SvelteKit **form actions** in `+page.server.ts` calling that same client. The existing `hooks.server.ts` Basic Auth (`DASHBOARD_PASSWORD`) gates every route by construction, so the console needs **no new auth code**. The API's admin endpoints stay `ADMIN_TOKEN`-gated as the real security boundary — the dashboard is a thin proxy (roadmap #6 replaces the API auth layer later). No new API endpoints are added.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, Tailwind v4 (CSS-first), Vitest (node unit + browser-mode render), Playwright E2E. Spec: `docs/superpowers/specs/2026-07-23-admin-console-ui-design.md`.

## Global Constraints

- **`ADMIN_TOKEN` is server-side only.** It lives in `$lib/server/` (which SvelteKit refuses to bundle to the client) and is read via `$env/dynamic/private`. It must never be importable from a `.svelte` component or prefixed `PUBLIC_`. This is the entire security seam of the feature.
- **No new API endpoints.** 4a only *calls* the existing `ADMIN_TOKEN`-gated admin routes. The `routes-auth-coverage.test.ts` route-count guard in `apps/api` is therefore untouched.
- **The API is authoritative for validation.** Client-side `admin-validation.ts` is a fast-feedback pre-flight only; every action still forwards the API's 4xx body on rejection.
- **Show-once token:** create and rotate return the plaintext token exactly once (the API stores only the hash). It rides the action response, is never persisted/logged, and is gone on reload — by design.
- **Destructive-op UX:** delete requires typed exact-name confirmation, enforced **server-side** in the action (the client-disabled button is UX, the server check is the guard). Prune uses the API's own two-phase dry-run → confirm.
- **Tests must be mutation-provable** — every assertion must be able to fail under some mutant (repo standard; no vacuous assertions).
- **Route render-test files must NOT carry the `+` prefix** — SvelteKit's route scanner rejects `+`-prefixed non-reserved files. Use `page.svelte.test.ts`, not `+page.svelte.test.ts`. Component imports inside keep the `+` (`./+page.svelte`).
- **Browser-mode render tests are `src/**/*.svelte.test.ts`**, run via `vitest.browser.config.ts` (`pnpm --filter dashboard test:browser`); the node suite (`pnpm --filter dashboard test`) excludes them and runs `*.test.ts`.
- **`pnpm --filter dashboard check`** (svelte-check) must stay clean — and it type-checks `src/**/*.ts` (verified: `.svelte-kit/tsconfig.json` includes `../src/**/*.ts`), so the test files count. Four typing rules follow from this and are non-negotiable:
  1. **Render-test `data` fixtures MUST include the layout `PageData` keys** (`projects: []`, `selectedProject: <Project>`, `apiError: null`) merged with the page-load keys — a page's `data` is layout-data ∪ page-load-data. See the existing `flaky/page.svelte.test.ts` `base` fixture for the exact shape.
  2. **The admin list load returns `adminProjects`, NOT `projects`** — the layout already puts `projects: Project[]` on every page's `data`; a page-load `projects` key would shadow it and read confusingly. Use a distinct key.
  3. **Page components type `form` with a hand-written interface, not the generated `ActionData`** — `ActionData` is a discriminated union of every action's success return *and* its `fail` payloads, and narrowing it to reach `form.errors`/`form.token` fights the type system. A manual `interface Props { data: PageData; form: XxxFormResult | null }` (matching the repo's existing `interface Props` style) is clean. `data` still uses the generated `PageData`.
  4. **Server-test result access uses `as any`** — calling an action directly returns `ActionFailure<…> | {…success…}`; accessing `.status`/`.data`/`.action` on that union errors under `strict`. Cast results to `any` (the repo already uses `as any` freely in `*.server.test.ts`, e.g. `analysis/page.server.test.ts`).
- **vitest-browser locator API (verified against `@vitest/browser@4.1.10` in Task 4):** the `page` locator has **`getByLabelText`**, NOT `getByLabel` (which is Playwright's name). Render tests (`*.svelte.test.ts`) use `page.getByLabelText(...)`. The **Playwright E2E** in Task 7 keeps `page.getByLabel(...)` (Playwright's own locator has it). Also: never write a single-statement `beforeEach(() => mock.mockReset())` — an unbraced arrow *returns* the mock, and Vitest runs a hook-returned function as an afterEach teardown (phantom call); always brace: `beforeEach(() => { mock.mockReset(); })`. Passing a flat-optional `form.x` into a component prop typed `string` needs a `!` assertion (`form.token!`).
- **Commits:** single-line conventional-commit subject. **NO `Co-Authored-By` trailers.** Never `--no-verify`. Work stays on branch `feat/admin-console-ui` (already created; `main` is branch-protected).
- **RTK note for the implementer:** the shell hook garbles `pnpm` stdout — prefix pnpm commands with `rtk proxy` (e.g. `rtk proxy pnpm --filter dashboard test`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/dashboard/src/lib/admin-validation.ts` *(new, pure)* | Client-side bounds mirror of the API's zod schema + form→patch builder. No I/O, no env. |
| `apps/dashboard/src/lib/admin-validation.test.ts` *(new, node)* | Mutation-hardened unit tests for the above. |
| `apps/dashboard/src/lib/server/adminApi.ts` *(new, server-only)* | `ADMIN_TOKEN`-bearing write/read client for the admin API. Typed helpers per operation. |
| `apps/dashboard/src/lib/server/adminApi.test.ts` *(new, node)* | Unit tests: token header, missing-token error, query wiring, error-body forwarding (mocked `fetch`). |
| `apps/dashboard/src/app.d.ts` *(modify)* | Add `AdminProject` (config + stats row) + response types. |
| `apps/dashboard/src/lib/components/TokenReveal.svelte` *(new)* | Show-once token panel (monospace token, copy button, warning). Reused by create + rotate. |
| `apps/dashboard/src/lib/components/TokenReveal.svelte.test.ts` *(new, browser)* | Render test for the panel. |
| `apps/dashboard/src/routes/admin/+page.server.ts` *(new)* | List load. |
| `apps/dashboard/src/routes/admin/+page.svelte` *(new)* | Project list + "New project" link. |
| `apps/dashboard/src/routes/admin/page.server.test.ts` *(new, node)* | Load test. |
| `apps/dashboard/src/routes/admin/page.svelte.test.ts` *(new, browser)* | List render test. |
| `apps/dashboard/src/routes/admin/new/+page.server.ts` *(new)* | Create action. |
| `apps/dashboard/src/routes/admin/new/+page.svelte` *(new)* | Create form + `TokenReveal` on success. |
| `apps/dashboard/src/routes/admin/new/page.server.test.ts` *(new, node)* | Create action test. |
| `apps/dashboard/src/routes/admin/new/page.svelte.test.ts` *(new, browser)* | Create page render test. |
| `apps/dashboard/src/routes/admin/[projectId]/+page.server.ts` *(new)* | Detail load + `patch`/`rotate`/`pruneDryRun`/`pruneConfirm`/`delete` actions. |
| `apps/dashboard/src/routes/admin/[projectId]/+page.svelte` *(new)* | Settings form + lifecycle sections. |
| `apps/dashboard/src/routes/admin/[projectId]/page.server.test.ts` *(new, node)* | Actions test. |
| `apps/dashboard/src/routes/admin/[projectId]/page.svelte.test.ts` *(new, browser)* | Detail render test. |
| `apps/dashboard/src/routes/+layout.svelte` *(modify)* | Add "Admin" nav item. |
| `apps/dashboard/e2e/admin.spec.ts` *(new)* | E2E: create → token-once → gone-on-reload → typed-confirm delete. |
| `docs/API.md`, `AGENTS.md`, `plans/README.md`, `docs/STRATEGY.md` *(modify)* | Document the console; mark #4a. |

Tasks 1–2 are foundation (pure + client). Tasks 3–6 are the pages, each an independently testable route. Task 7 is E2E + docs.

---

### Task 1: `admin-validation.ts` — pure bounds mirror + patch builder

**Files:**
- Create: `apps/dashboard/src/lib/admin-validation.ts`
- Test: `apps/dashboard/src/lib/admin-validation.test.ts`

**Interfaces:**
- Produces: `validateNumericField(raw, spec)`, `validateWebhookUrl(raw)`, `validateWebhookKind(raw)`, `validateConfigForm(input)`, `buildConfigPatch(raw, autoQuarantineEnabled)`, and the constant `CONFIG_FIELD_SPECS`. Types: `NumericFieldSpec`, `ValidationResult`. Consumed by Tasks 5 (settings action + form).

Bounds copied verbatim from `apps/api/src/routes/admin.ts` `projectConfigPatchSchema`: `flakeThreshold`/`quarantineThreshold` ∈ [0,1] (float); `windowDays` int [1,90]; `minRuns`/`quarantineMinRuns` int [1,100]; `retentionDays` int [1,3650]; `quarantineTtlDays` int [1,365]; `webhookUrl` http(s) URL ≤ 2048 chars; `webhookKind` ∈ {slack, generic}. Empty string means "reset to default" (`null`) and is always valid client-side.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/lib/admin-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  validateNumericField,
  validateWebhookUrl,
  validateWebhookKind,
  validateConfigForm,
  buildConfigPatch,
  CONFIG_FIELD_SPECS,
} from './admin-validation';

describe('validateNumericField', () => {
  const intSpec = { min: 1, max: 90, integer: true };
  const floatSpec = { min: 0, max: 1, integer: false };

  it('treats empty/whitespace as valid (reset-to-default)', () => {
    expect(validateNumericField('', intSpec)).toBeNull();
    expect(validateNumericField('   ', intSpec)).toBeNull();
  });
  it('rejects non-numbers', () => {
    expect(validateNumericField('abc', intSpec)).toBe('must be a number');
  });
  it('rejects a decimal for an integer field', () => {
    expect(validateNumericField('1.5', intSpec)).toBe('must be a whole number');
  });
  it('accepts a decimal for a float field', () => {
    expect(validateNumericField('0.25', floatSpec)).toBeNull();
  });
  it('rejects below min and above max (inclusive bounds pass)', () => {
    expect(validateNumericField('0', intSpec)).toBe('must be between 1 and 90');
    expect(validateNumericField('91', intSpec)).toBe('must be between 1 and 90');
    expect(validateNumericField('1', intSpec)).toBeNull();
    expect(validateNumericField('90', intSpec)).toBeNull();
  });
});

describe('validateWebhookUrl', () => {
  it('empty is valid', () => expect(validateWebhookUrl('')).toBeNull());
  it('accepts http and https', () => {
    expect(validateWebhookUrl('http://x.test/hook')).toBeNull();
    expect(validateWebhookUrl('https://hooks.slack.com/x')).toBeNull();
  });
  it('rejects a non-http(s) protocol', () => {
    expect(validateWebhookUrl('ftp://x.test')).toBe('must use http or https');
  });
  it('rejects an unparseable URL', () => {
    expect(validateWebhookUrl('not a url')).toBe('must be a valid URL');
  });
  it('rejects over 2048 chars', () => {
    expect(validateWebhookUrl('https://x.test/' + 'a'.repeat(2048))).toBe(
      'must be at most 2048 characters'
    );
  });
});

describe('validateWebhookKind', () => {
  it('empty is valid', () => expect(validateWebhookKind('')).toBeNull());
  it('accepts slack and generic', () => {
    expect(validateWebhookKind('slack')).toBeNull();
    expect(validateWebhookKind('generic')).toBeNull();
  });
  it('rejects anything else', () => {
    expect(validateWebhookKind('teams')).toBe("must be 'slack' or 'generic'");
  });
});

describe('validateConfigForm', () => {
  it('is valid when everything is empty', () => {
    expect(validateConfigForm({})).toEqual({ valid: true, errors: {} });
  });
  it('collects a per-field error message', () => {
    const r = validateConfigForm({ windowDays: '0', webhookKind: 'teams' });
    expect(r.valid).toBe(false);
    expect(r.errors.windowDays).toBe('must be between 1 and 90');
    expect(r.errors.webhookKind).toBe("must be 'slack' or 'generic'");
  });
  it('flags retentionDays below windowDays as a cross-field error', () => {
    const r = validateConfigForm({ windowDays: '30', retentionDays: '10' });
    expect(r.valid).toBe(false);
    expect(r.errors.retentionDays).toBe('must be at least the flake window (windowDays)');
  });
  it('does not cross-check when only one of the two is set', () => {
    expect(validateConfigForm({ retentionDays: '10' }).valid).toBe(true);
  });
});

describe('buildConfigPatch', () => {
  it('maps empty numeric fields to null (reset) and parses set ones', () => {
    const patch = buildConfigPatch({ flakeThreshold: '', windowDays: '14' }, false);
    expect(patch.flakeThreshold).toBeNull();
    expect(patch.windowDays).toBe(14);
  });
  it('maps empty webhook fields to null and keeps set strings verbatim', () => {
    const patch = buildConfigPatch(
      { webhookUrl: '', webhookKind: 'slack' },
      false
    );
    expect(patch.webhookUrl).toBeNull();
    expect(patch.webhookKind).toBe('slack');
  });
  it('always includes autoQuarantineEnabled as a boolean, never null', () => {
    expect(buildConfigPatch({}, true).autoQuarantineEnabled).toBe(true);
    expect(buildConfigPatch({}, false).autoQuarantineEnabled).toBe(false);
  });
  it('emits every nullable numeric key even when the form omits it', () => {
    const patch = buildConfigPatch({}, false);
    for (const key of Object.keys(CONFIG_FIELD_SPECS)) {
      expect(patch[key]).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/lib/admin-validation.test.ts`
Expected: FAIL — module not found / exports undefined.

- [ ] **Step 3: Write the implementation**

Create `apps/dashboard/src/lib/admin-validation.ts`:

```ts
// Pure, client-safe pre-flight mirroring the API's zod bounds
// (apps/api/src/routes/admin.ts projectConfigPatchSchema). The API stays
// authoritative — this only blocks obviously-invalid submits for fast
// feedback. No I/O, no env: safe to import into a .svelte component.

export interface NumericFieldSpec {
  min: number;
  max: number;
  integer: boolean;
}

// Keyed by the exact PATCH field names. Empty string ⇒ "reset to default"
// (null) ⇒ always valid here; a present value must satisfy the spec.
export const CONFIG_FIELD_SPECS: Record<string, NumericFieldSpec> = {
  flakeThreshold: { min: 0, max: 1, integer: false },
  windowDays: { min: 1, max: 90, integer: true },
  minRuns: { min: 1, max: 100, integer: true },
  retentionDays: { min: 1, max: 3650, integer: true },
  quarantineThreshold: { min: 0, max: 1, integer: false },
  quarantineMinRuns: { min: 1, max: 100, integer: true },
  quarantineTtlDays: { min: 1, max: 365, integer: true },
};

export function validateNumericField(raw: string, spec: NumericFieldSpec): string | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'must be a number';
  if (spec.integer && !Number.isInteger(n)) return 'must be a whole number';
  if (n < spec.min || n > spec.max) return `must be between ${spec.min} and ${spec.max}`;
  return null;
}

export function validateWebhookUrl(raw: string): string | null {
  if (raw.trim() === '') return null;
  if (raw.length > 2048) return 'must be at most 2048 characters';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be a valid URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https';
  return null;
}

export function validateWebhookKind(raw: string): string | null {
  if (raw.trim() === '') return null;
  if (raw !== 'slack' && raw !== 'generic') return "must be 'slack' or 'generic'";
  return null;
}

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export function validateConfigForm(input: Record<string, string>): ValidationResult {
  const errors: Record<string, string> = {};
  for (const [field, spec] of Object.entries(CONFIG_FIELD_SPECS)) {
    const msg = validateNumericField(input[field] ?? '', spec);
    if (msg) errors[field] = msg;
  }
  const urlMsg = validateWebhookUrl(input.webhookUrl ?? '');
  if (urlMsg) errors.webhookUrl = urlMsg;
  const kindMsg = validateWebhookKind(input.webhookKind ?? '');
  if (kindMsg) errors.webhookKind = kindMsg;

  // Cross-field: retentionDays must not undercut windowDays. Only checked when
  // BOTH are present and finite (mirrors the API's post-parse refine).
  const rdRaw = (input.retentionDays ?? '').trim();
  const wdRaw = (input.windowDays ?? '').trim();
  if (rdRaw !== '' && wdRaw !== '') {
    const rd = Number(rdRaw);
    const wd = Number(wdRaw);
    if (Number.isFinite(rd) && Number.isFinite(wd) && rd < wd) {
      errors.retentionDays = 'must be at least the flake window (windowDays)';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// Maps the raw form strings to a PATCH body: empty ⇒ null (reset to default),
// present ⇒ parsed number / verbatim string. autoQuarantineEnabled is a
// checkbox — always a boolean, never null.
export function buildConfigPatch(
  raw: Record<string, string>,
  autoQuarantineEnabled: boolean
): Record<string, number | string | boolean | null> {
  const patch: Record<string, number | string | boolean | null> = {};
  for (const field of Object.keys(CONFIG_FIELD_SPECS)) {
    const v = (raw[field] ?? '').trim();
    patch[field] = v === '' ? null : Number(v);
  }
  const urlV = (raw.webhookUrl ?? '').trim();
  patch.webhookUrl = urlV === '' ? null : urlV;
  const kindV = (raw.webhookKind ?? '').trim();
  patch.webhookKind = kindV === '' ? null : kindV;
  patch.autoQuarantineEnabled = autoQuarantineEnabled;
  return patch;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/lib/admin-validation.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/admin-validation.ts apps/dashboard/src/lib/admin-validation.test.ts
git commit -m "feat(dashboard): admin config validation + patch-builder helpers"
```

---

### Task 2: `AdminProject` types + `adminApi.ts` server client

**Files:**
- Modify: `apps/dashboard/src/app.d.ts` (add types)
- Create: `apps/dashboard/src/lib/server/adminApi.ts`
- Test: `apps/dashboard/src/lib/server/adminApi.test.ts`

**Interfaces:**
- Consumes: `$env/dynamic/private` (`ADMIN_TOKEN`), `$env/dynamic/public` (`PUBLIC_API_URL`).
- Produces: `AdminProject` type; `adminConfigured()`, `listProjects()`, `createProject(body)`, `patchProject(id, body)`, `rotateToken(id)`, `pruneProject(id, confirm)`, `deleteProject(id)`; error classes `AdminApiError` (carries `statusCode`) and `MissingAdminTokenError`. Consumed by Tasks 3–6.

- [ ] **Step 1: Add the types to `app.d.ts`**

Append to `apps/dashboard/src/app.d.ts` (near the other exported interfaces). Field types match `GET /api/v1/admin/projects`'s mapped row in `apps/api/src/routes/admin.ts:103-124`:

```ts
export interface AdminProject {
  id: string;
  name: string;
  gitlabProjectId: string | null;
  hasToken: boolean;
  createdAt: string;
  flakeThreshold: number | null;
  windowDays: number | null;
  minRuns: number | null;
  webhookUrl: string | null;
  webhookKind: 'slack' | 'generic' | null;
  retentionDays: number | null;
  autoQuarantineEnabled: boolean;
  quarantineThreshold: number | null;
  quarantineMinRuns: number | null;
  quarantineTtlDays: number | null;
  stats: {
    totalRuns: number;
    totalTests: number;
    activeFlakyTests: number;
  };
}

export interface CreateProjectResult {
  project: { id: string; name: string; gitlabProjectId: string | null; createdAt: string };
  token: string;
  warning: string;
}

export interface RotateTokenResult {
  project: { id: string; name: string };
  token: string;
  warning: string;
}

export interface PruneResult {
  dryRun: boolean;
  cutoff: string;
  runsToDelete?: number;
  resultsToDelete?: number;
  runsDeleted?: number;
  resultsDeleted?: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/dashboard/src/lib/server/adminApi.test.ts`. The node vitest config aliases `$env/dynamic/private` to a mutable stub (`src/tests/env-private-stub.ts`, an empty `env` object) — mutate it per test.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env as privateEnv } from '$env/dynamic/private';
import {
  listProjects,
  createProject,
  patchProject,
  rotateToken,
  pruneProject,
  deleteProject,
  adminConfigured,
  AdminApiError,
  MissingAdminTokenError,
} from './adminApi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  privateEnv.ADMIN_TOKEN = 'admintok';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete privateEnv.ADMIN_TOKEN;
});

describe('adminConfigured', () => {
  it('reflects presence of ADMIN_TOKEN', () => {
    expect(adminConfigured()).toBe(true);
    delete privateEnv.ADMIN_TOKEN;
    expect(adminConfigured()).toBe(false);
  });
});

describe('adminApi auth + wiring', () => {
  it('throws MissingAdminTokenError and never fetches without a token', async () => {
    delete privateEnv.ADMIN_TOKEN;
    await expect(listProjects()).rejects.toBeInstanceOf(MissingAdminTokenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the bearer token and hits the list endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await listProjects();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer admintok');
  });

  it('POSTs create with a JSON body and Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {}, token: 't', warning: 'w' }, 201));
    await createProject({ name: 'proj' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ name: 'proj' });
  });

  it('PATCHes the project config', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await patchProject('p1', { windowDays: 14 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ windowDays: 14 });
  });

  it('rotates the token via POST with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {}, token: 't', warning: 'w' }));
    await rotateToken('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rotate-token');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('adds ?confirm=true only when confirming a prune', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ dryRun: true, cutoff: 'x' }));
    await pruneProject('p1', false);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/v1/admin/projects/p1/prune');
    await pruneProject('p1', true);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://localhost:8080/api/v1/admin/projects/p1/prune?confirm=true'
    );
  });

  it('DELETEs the project', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, message: 'gone' }));
    await deleteProject('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1');
    expect(init.method).toBe('DELETE');
  });

  it('forwards the API error body and status on a non-2xx', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'Project with this name already exists' }, 409)
    );
    const err = await createProject({ name: 'dup' }).catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Project with this name already exists');
  });

  it('falls back to a generic message when the error body has no `error`', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const err = await listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('API request failed (500)');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/lib/server/adminApi.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `apps/dashboard/src/lib/server/adminApi.ts`:

```ts
import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import type {
  AdminProject,
  CreateProjectResult,
  RotateTokenResult,
  PruneResult,
} from '../../app.d';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

// A non-2xx from the admin API. Carries the status + the API's own error
// message so the calling action can forward both to the user.
export class AdminApiError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

// The dashboard has no ADMIN_TOKEN — it cannot spend a token it does not hold.
// Actions convert this to a 403 fail; it must never become an unauthenticated
// request to the API.
export class MissingAdminTokenError extends Error {
  constructor() {
    super('The dashboard server has no ADMIN_TOKEN configured; admin actions are disabled.');
    this.name = 'MissingAdminTokenError';
  }
}

export function adminConfigured(): boolean {
  return Boolean(privateEnv.ADMIN_TOKEN);
}

async function adminFetch<T>(
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' }
): Promise<T> {
  const token = privateEnv.ADMIN_TOKEN;
  if (!token) throw new MissingAdminTokenError();

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const hasBody = init.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, {
    method: init.method,
    headers,
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });

  if (!res.ok) {
    let message = `API request failed (${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: unknown };
      if (errBody && typeof errBody.error === 'string') message = errBody.error;
    } catch {
      // keep the generic message
    }
    throw new AdminApiError(res.status, message);
  }

  return res.json() as Promise<T>;
}

export function listProjects(): Promise<{ projects: AdminProject[] }> {
  return adminFetch('/api/v1/admin/projects');
}

export function createProject(body: {
  name: string;
  gitlabProjectId?: string;
}): Promise<CreateProjectResult> {
  return adminFetch('/api/v1/admin/projects', { method: 'POST', body });
}

export function patchProject(
  id: string,
  body: Record<string, number | string | boolean | null>
): Promise<unknown> {
  return adminFetch(`/api/v1/admin/projects/${id}`, { method: 'PATCH', body });
}

export function rotateToken(id: string): Promise<RotateTokenResult> {
  return adminFetch(`/api/v1/admin/projects/${id}/rotate-token`, { method: 'POST' });
}

export function pruneProject(id: string, confirm: boolean): Promise<PruneResult> {
  const query = confirm ? '?confirm=true' : '';
  return adminFetch(`/api/v1/admin/projects/${id}/prune${query}`, { method: 'POST' });
}

export function deleteProject(id: string): Promise<{ success: boolean; message: string }> {
  return adminFetch(`/api/v1/admin/projects/${id}`, { method: 'DELETE' });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/lib/server/adminApi.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `rtk proxy pnpm --filter dashboard check` — Expected: no new errors.

```bash
git add apps/dashboard/src/app.d.ts apps/dashboard/src/lib/server/adminApi.ts apps/dashboard/src/lib/server/adminApi.test.ts
git commit -m "feat(dashboard): server-only admin API client + project types"
```

---

### Task 3: `/admin` list page + Admin nav link

**Files:**
- Create: `apps/dashboard/src/routes/admin/+page.server.ts`, `apps/dashboard/src/routes/admin/+page.svelte`
- Modify: `apps/dashboard/src/routes/+layout.svelte`
- Test: `apps/dashboard/src/routes/admin/page.server.test.ts` (node), `apps/dashboard/src/routes/admin/page.svelte.test.ts` (browser)

**Interfaces:**
- Consumes: `listProjects()`, `adminConfigured()`, `AdminApiError` (Task 2).
- Produces: `load` → `{ adminProjects: AdminProject[]; adminEnabled: boolean }` (key is `adminProjects`, per Global Constraint 2). Consumed by the list `+page.svelte`.

- [ ] **Step 1: Write the failing load test**

Create `apps/dashboard/src/routes/admin/page.server.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  listProjects: vi.fn(),
  adminConfigured: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    statusCode: number;
    constructor(status: number, message: string) {
      super(message);
      this.statusCode = status;
    }
  },
}));

import { listProjects, adminConfigured } from '$lib/server/adminApi';
import { load } from './+page.server';

const mockedList = vi.mocked(listProjects);
const mockedConfigured = vi.mocked(adminConfigured);

beforeEach(() => {
  mockedList.mockReset();
  mockedConfigured.mockReset();
});

describe('routes/admin load', () => {
  it('returns adminEnabled=false and skips the fetch when ADMIN_TOKEN is unset', async () => {
    mockedConfigured.mockReturnValue(false);
    const result = (await load({} as any)) as any;
    expect(result).toEqual({ adminProjects: [], adminEnabled: false });
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('returns the project list when configured', async () => {
    mockedConfigured.mockReturnValue(true);
    const projects = [{ id: 'p1', name: 'A' }] as any;
    mockedList.mockResolvedValue({ projects });
    const result = (await load({} as any)) as any;
    expect(result).toEqual({ adminProjects: projects, adminEnabled: true });
  });

  it('surfaces an API failure as an HTTP error', async () => {
    mockedConfigured.mockReturnValue(true);
    mockedList.mockRejectedValue(
      new (await import('$lib/server/adminApi')).AdminApiError(502, 'boom')
    );
    await expect(load({} as any)).rejects.toMatchObject({ status: 502 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/page.server.test.ts`
Expected: FAIL — `./+page.server` not found.

- [ ] **Step 3: Write the load**

Create `apps/dashboard/src/routes/admin/+page.server.ts`:

```ts
import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { listProjects, adminConfigured, AdminApiError } from '$lib/server/adminApi';

export const load: PageServerLoad = async () => {
  if (!adminConfigured()) {
    return { adminProjects: [], adminEnabled: false };
  }
  try {
    const { projects } = await listProjects();
    return { adminProjects: projects, adminEnabled: true };
  } catch (e) {
    const status = e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load projects');
  }
};
```

- [ ] **Step 4: Run the load test — PASS**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/page.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the list page**

Create `apps/dashboard/src/routes/admin/+page.svelte`:

```svelte
<script lang="ts">
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head>
  <title>Admin | Flackyness</title>
</svelte:head>

<div class="mb-8 flex items-center justify-between">
  <div>
    <h1 class="text-2xl font-bold text-gray-900 mb-1">Admin</h1>
    <p class="text-muted">Manage projects, tokens, and data retention.</p>
  </div>
  {#if data.adminEnabled}
    <a href="/admin/new" class="pill-btn pill-btn-primary">New project</a>
  {/if}
</div>

{#if !data.adminEnabled}
  <div class="card p-8 text-center">
    <h3 class="text-lg font-semibold text-gray-900 mb-2">Admin actions are disabled</h3>
    <p class="text-muted">
      Set <code class="font-mono">ADMIN_TOKEN</code> in the dashboard's environment to manage
      projects from here.
    </p>
  </div>
{:else if data.adminProjects.length === 0}
  <div class="card p-12 text-center">
    <h3 class="text-lg font-semibold text-gray-900 mb-2">No projects yet</h3>
    <p class="text-muted">Create your first project to start ingesting reports.</p>
  </div>
{:else}
  <div class="card overflow-hidden">
    <table class="w-full">
      <thead>
        <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light bg-gray-50">
          <th class="py-4 px-4 font-medium">Project</th>
          <th class="py-4 px-4 font-medium">Runs</th>
          <th class="py-4 px-4 font-medium">Active flaky</th>
          <th class="py-4 px-4 font-medium">Webhook</th>
          <th class="py-4 px-4 font-medium"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each data.adminProjects as project}
          <tr class="hover:bg-gray-50 transition-colors">
            <td class="py-4 px-4 font-medium text-gray-900">{project.name}</td>
            <td class="py-4 px-4 text-muted">{project.stats.totalRuns}</td>
            <td class="py-4 px-4 text-muted">{project.stats.activeFlakyTests}</td>
            <td class="py-4 px-4 text-muted text-sm">
              {project.webhookUrl ? 'configured' : '—'}
            </td>
            <td class="py-4 px-4">
              <a
                href="/admin/{project.id}"
                class="text-purple-600 hover:text-purple-700 font-medium hover:underline"
              >
                Manage
              </a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
```

- [ ] **Step 6: Add the Admin nav item**

In `apps/dashboard/src/routes/+layout.svelte`, extend the `navItems` array (line ~15-20) — append one entry:

```ts
  const navItems = [
    { href: '/', label: 'Overview', icon: '📊', color: 'purple' },
    { href: '/flaky', label: 'Flaky Tests', icon: '⚡', color: 'orange' },
    { href: '/runs', label: 'Test Runs', icon: '🧪', color: 'blue' },
    { href: '/analysis', label: 'Analysis', icon: '🔬', color: 'purple' },
    { href: '/admin', label: 'Admin', icon: '⚙️', color: 'purple' },
  ];
```

(No other layout change; the existing `layout.svelte.test.ts` asserts specific links by name, not a count, so it stays green.)

- [ ] **Step 7: Write the list render test**

Create `apps/dashboard/src/routes/admin/page.svelte.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import type { AdminProject } from '../../app.d';

const proj = (over: Partial<AdminProject> = {}): AdminProject => ({
  id: 'p1',
  name: 'Project One',
  gitlabProjectId: null,
  hasToken: true,
  createdAt: '2026-01-01T00:00:00Z',
  flakeThreshold: null,
  windowDays: null,
  minRuns: null,
  webhookUrl: null,
  webhookKind: null,
  retentionDays: null,
  autoQuarantineEnabled: false,
  quarantineThreshold: null,
  quarantineMinRuns: null,
  quarantineTtlDays: null,
  stats: { totalRuns: 7, totalTests: 42, activeFlakyTests: 2 },
  ...over,
});

// Layout half of PageData (Global Constraint 1): every page's `data` merges the
// layout load's { projects, selectedProject, apiError } with the page-load keys.
const layout = {
  projects: [],
  selectedProject: { id: 'p1', name: 'Project One', createdAt: '2026-01-01T00:00:00Z' },
  apiError: null,
};

describe('admin/+page (list)', () => {
  it('shows the disabled notice when adminEnabled is false', async () => {
    render(Page, { props: { data: { ...layout, adminProjects: [], adminEnabled: false } } });
    await expect.element(page.getByText('Admin actions are disabled')).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('shows the empty state when enabled with no projects', async () => {
    render(Page, { props: { data: { ...layout, adminProjects: [], adminEnabled: true } } });
    await expect.element(page.getByText('No projects yet')).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'New project' })).toBeInTheDocument();
  });

  it('renders a manage link and stats per project', async () => {
    render(Page, { props: { data: { ...layout, adminProjects: [proj()], adminEnabled: true } } });
    await expect.element(page.getByText('Project One')).toBeInTheDocument();
    const manage = page.getByRole('link', { name: 'Manage' });
    await expect.element(manage).toBeInTheDocument();
    await expect.element(manage).toHaveAttribute('href', '/admin/p1');
  });
});
```

- [ ] **Step 8: Run render test + typecheck**

Run: `rtk proxy pnpm --filter dashboard test:browser` — Expected: admin list render test PASS (existing render tests still green).
Run: `rtk proxy pnpm --filter dashboard check` — Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard/src/routes/admin/+page.server.ts apps/dashboard/src/routes/admin/+page.svelte apps/dashboard/src/routes/admin/page.server.test.ts apps/dashboard/src/routes/admin/page.svelte.test.ts apps/dashboard/src/routes/+layout.svelte
git commit -m "feat(dashboard): admin project list page + nav link"
```

---

### Task 4: `/admin/new` create page + `TokenReveal` show-once panel

**Files:**
- Create: `apps/dashboard/src/lib/components/TokenReveal.svelte`, `apps/dashboard/src/lib/components/TokenReveal.svelte.test.ts` (browser)
- Create: `apps/dashboard/src/routes/admin/new/+page.server.ts`, `apps/dashboard/src/routes/admin/new/+page.svelte`
- Test: `apps/dashboard/src/routes/admin/new/page.server.test.ts` (node), `apps/dashboard/src/routes/admin/new/page.svelte.test.ts` (browser)

**Interfaces:**
- Consumes: `createProject()`, `adminConfigured()`, `AdminApiError`, `MissingAdminTokenError` (Task 2).
- Produces: `TokenReveal` component (`{ token: string; warning: string }`); create action returning `{ created: true; token; warning; projectName }` or `fail(...)`.

- [ ] **Step 1: Write the `TokenReveal` render test**

Create `apps/dashboard/src/lib/components/TokenReveal.svelte.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import TokenReveal from './TokenReveal.svelte';

describe('TokenReveal', () => {
  it('renders the token and the warning verbatim', async () => {
    render(TokenReveal, { props: { token: 'flk_secret_123', warning: 'Save this now.' } });
    await expect.element(page.getByText('flk_secret_123')).toBeInTheDocument();
    await expect.element(page.getByText('Save this now.')).toBeInTheDocument();
  });

  it('exposes a copy control', async () => {
    render(TokenReveal, { props: { token: 't', warning: 'w' } });
    await expect.element(page.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Write `TokenReveal.svelte`**

Create `apps/dashboard/src/lib/components/TokenReveal.svelte`:

```svelte
<script lang="ts">
  interface Props {
    token: string;
    warning: string;
  }

  let { token, warning }: Props = $props();
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<div class="card p-6 border border-orange-200 bg-orange-50" data-testid="token-reveal">
  <h3 class="text-lg font-semibold text-gray-900 mb-2">API token</h3>
  <p class="text-sm text-orange-800 mb-3">{warning}</p>
  <div class="flex items-center gap-2">
    <code class="flex-1 font-mono text-sm bg-white border border-subtle rounded-lg px-3 py-2 break-all">{token}</code>
    <button type="button" class="pill-btn pill-btn-primary" onclick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  </div>
</div>
```

- [ ] **Step 3: Write the failing create-action test**

Create `apps/dashboard/src/routes/admin/new/page.server.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  createProject: vi.fn(),
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

import { createProject } from '$lib/server/adminApi';
import { actions } from './+page.server';

const mockedCreate = vi.mocked(createProject);

function formEvent(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { request: { formData: async () => fd } } as any;
}

beforeEach(() => mockedCreate.mockReset());

describe('admin/new create action', () => {
  it('rejects a blank name with a 400', async () => {
    const result = (await actions.default(formEvent({ name: '   ' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('returns the show-once token on success', async () => {
    mockedCreate.mockResolvedValue({
      project: { id: 'p1', name: 'proj', gitlabProjectId: null, createdAt: 'x' },
      token: 'flk_abc',
      warning: 'Save it.',
    });
    const result = (await actions.default(formEvent({ name: 'proj' }))) as any;
    expect(mockedCreate).toHaveBeenCalledWith({ name: 'proj' });
    expect(result).toMatchObject({ created: true, token: 'flk_abc', warning: 'Save it.', projectName: 'proj' });
  });

  it('passes gitlabProjectId through only when non-empty', async () => {
    mockedCreate.mockResolvedValue({
      project: { id: 'p1', name: 'proj', gitlabProjectId: '42', createdAt: 'x' },
      token: 't',
      warning: 'w',
    });
    await actions.default(formEvent({ name: 'proj', gitlabProjectId: '42' }));
    expect(mockedCreate).toHaveBeenCalledWith({ name: 'proj', gitlabProjectId: '42' });
  });

  it('forwards a duplicate-name 409 as a fail', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedCreate.mockRejectedValue(new AdminApiError(409, 'Project with this name already exists'));
    const result = (await actions.default(formEvent({ name: 'dup' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.message).toBe('Project with this name already exists');
  });
});
```

- [ ] **Step 4: Run it — FAIL**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/new/page.server.test.ts`
Expected: FAIL — `./+page.server` not found.

- [ ] **Step 5: Write the create action**

Create `apps/dashboard/src/routes/admin/new/+page.server.ts`:

```ts
import type { Actions } from './$types';
import { fail } from '@sveltejs/kit';
import {
  createProject,
  adminConfigured,
  AdminApiError,
  MissingAdminTokenError,
} from '$lib/server/adminApi';

export const actions = {
  default: async ({ request }) => {
    if (!adminConfigured()) {
      return fail(403, { message: 'The dashboard server has no ADMIN_TOKEN configured.' });
    }
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    const gitlabProjectId = String(form.get('gitlabProjectId') ?? '').trim();

    if (!name) {
      return fail(400, { message: 'Project name is required.', name });
    }

    try {
      const body: { name: string; gitlabProjectId?: string } = { name };
      if (gitlabProjectId) body.gitlabProjectId = gitlabProjectId;
      const result = await createProject(body);
      return {
        created: true,
        token: result.token,
        warning: result.warning,
        projectName: result.project.name,
      };
    } catch (e) {
      if (e instanceof MissingAdminTokenError) return fail(403, { message: e.message, name });
      if (e instanceof AdminApiError) return fail(e.statusCode, { message: e.message, name });
      return fail(502, { message: 'Unexpected error contacting the API.', name });
    }
  },
} satisfies Actions;
```

- [ ] **Step 6: Run the action test — PASS**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/new/page.server.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the create page**

Create `apps/dashboard/src/routes/admin/new/+page.svelte`:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import TokenReveal from '$lib/components/TokenReveal.svelte';

  // Manual form-result type (Global Constraint 3) — cleaner than narrowing the
  // generated ActionData union. The create page has no `load`, so it needs no
  // `data` prop.
  interface CreateFormResult {
    created?: boolean;
    token?: string;
    warning?: string;
    projectName?: string;
    message?: string;
    name?: string;
  }
  interface Props {
    form: CreateFormResult | null;
  }

  let { form }: Props = $props();
</script>

<svelte:head>
  <title>New project | Flackyness</title>
</svelte:head>

<div class="mb-8">
  <a href="/admin" class="text-sm text-purple-600 hover:underline">&larr; Back to projects</a>
  <h1 class="text-2xl font-bold text-gray-900 mt-2">New project</h1>
</div>

{#if form?.created}
  <div class="flex flex-col gap-4 max-w-2xl">
    <div class="card p-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-1">
        Project “{form.projectName}” created
      </h3>
      <p class="text-muted text-sm">Copy the ingest token below — it is shown only once.</p>
    </div>
    <TokenReveal token={form.token} warning={form.warning} />
    <a href="/admin" class="pill-btn pill-btn-primary self-start">Done</a>
  </div>
{:else}
  <form method="POST" use:enhance class="card p-6 max-w-lg flex flex-col gap-4">
    {#if form?.message}
      <p class="text-sm text-red-600">{form.message}</p>
    {/if}
    <div>
      <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Project name</label>
      <input
        id="name"
        name="name"
        type="text"
        required
        value={form?.name ?? ''}
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
    </div>
    <div>
      <label for="gitlabProjectId" class="block text-sm font-medium text-gray-700 mb-1">
        GitLab project ID <span class="text-muted">(optional)</span>
      </label>
      <input
        id="gitlabProjectId"
        name="gitlabProjectId"
        type="text"
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
    </div>
    <button type="submit" class="pill-btn pill-btn-primary self-start">Create project</button>
  </form>
{/if}
```

- [ ] **Step 8: Write the create page render test**

Create `apps/dashboard/src/routes/admin/new/page.svelte.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

describe('admin/new/+page', () => {
  it('shows the create form by default', async () => {
    render(Page, { props: { form: null } });
    await expect.element(page.getByLabel('Project name')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Create project' })).toBeInTheDocument();
  });

  it('shows the show-once token panel after a successful create', async () => {
    render(Page, {
      props: {
        form: { created: true, token: 'flk_xyz', warning: 'Shown once.', projectName: 'proj' },
      },
    });
    await expect.element(page.getByText('flk_xyz')).toBeInTheDocument();
    await expect.element(page.getByText('Shown once.')).toBeInTheDocument();
    // the input form is replaced by the reveal, not shown alongside it
    await expect.element(page.getByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
  });

  it('surfaces an error message on the form', async () => {
    render(Page, { props: { form: { message: 'Project with this name already exists' } } });
    await expect
      .element(page.getByText('Project with this name already exists'))
      .toBeInTheDocument();
  });
});
```

- [ ] **Step 9: Run render tests + typecheck**

Run: `rtk proxy pnpm --filter dashboard test:browser` — Expected: `TokenReveal` + create render tests PASS.
Run: `rtk proxy pnpm --filter dashboard check` — Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add apps/dashboard/src/lib/components/TokenReveal.svelte apps/dashboard/src/lib/components/TokenReveal.svelte.test.ts apps/dashboard/src/routes/admin/new/
git commit -m "feat(dashboard): create-project page with show-once token reveal"
```

---

### Task 5: `/admin/[projectId]` detail load + settings (PATCH) form

**Files:**
- Create: `apps/dashboard/src/routes/admin/[projectId]/+page.server.ts`, `apps/dashboard/src/routes/admin/[projectId]/+page.svelte`
- Test: `apps/dashboard/src/routes/admin/[projectId]/page.server.test.ts` (node), `apps/dashboard/src/routes/admin/[projectId]/page.svelte.test.ts` (browser)

**Interfaces:**
- Consumes: `listProjects()` (filter by `params.projectId`), `patchProject()`, `adminConfigured()`, error classes (Task 2); `validateConfigForm()`, `buildConfigPatch()` (Task 1).
- Produces: `load` → `{ project: AdminProject }`; `actions.patch`. The lifecycle actions (rotate/prune/delete) are added in Task 6 — this task ships `load` + `patch` only.

- [ ] **Step 1: Write the failing load + patch tests**

Create `apps/dashboard/src/routes/admin/[projectId]/page.server.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  listProjects: vi.fn(),
  patchProject: vi.fn(),
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

import { listProjects, patchProject } from '$lib/server/adminApi';
import { load, actions } from './+page.server';

const mockedList = vi.mocked(listProjects);
const mockedPatch = vi.mocked(patchProject);

const project = {
  id: 'p1',
  name: 'Proj',
  gitlabProjectId: null,
  hasToken: true,
  createdAt: 'x',
  flakeThreshold: 0.1,
  windowDays: 14,
  minRuns: 5,
  webhookUrl: null,
  webhookKind: null,
  retentionDays: 30,
  autoQuarantineEnabled: false,
  quarantineThreshold: null,
  quarantineMinRuns: null,
  quarantineTtlDays: null,
  stats: { totalRuns: 3, totalTests: 9, activeFlakyTests: 1 },
} as any;

function formEvent(fields: Record<string, string>, id = 'p1') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { request: { formData: async () => fd }, params: { projectId: id } } as any;
}

beforeEach(() => {
  mockedList.mockReset();
  mockedPatch.mockReset();
});

describe('admin/[projectId] load', () => {
  it('returns the matching project', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    const result = await load({ params: { projectId: 'p1' } } as any);
    expect(result).toEqual({ project });
  });

  it('404s when the project id is not in the list', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    await expect(load({ params: { projectId: 'nope' } } as any)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('admin/[projectId] patch action', () => {
  it('rejects out-of-bounds input before calling the API', async () => {
    const result = (await actions.patch(formEvent({ windowDays: '0' }))) as any;
    expect(result.status).toBe(400);
    expect(result.data.errors.windowDays).toBeTruthy();
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('builds a full patch (empty ⇒ null) and calls the API on valid input', async () => {
    mockedPatch.mockResolvedValue({});
    const result = (await actions.patch(
      formEvent({ windowDays: '20', flakeThreshold: '', webhookKind: 'slack' })
    )) as any;
    expect(mockedPatch).toHaveBeenCalledWith('p1', expect.objectContaining({
      windowDays: 20,
      flakeThreshold: null,
      webhookKind: 'slack',
      autoQuarantineEnabled: false,
    }));
    expect(result).toMatchObject({ action: 'patch', success: true });
  });

  it('sets autoQuarantineEnabled true when the checkbox is present', async () => {
    mockedPatch.mockResolvedValue({});
    await actions.patch(formEvent({ autoQuarantineEnabled: 'on' }));
    expect(mockedPatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ autoQuarantineEnabled: true })
    );
  });

  it('forwards an API 400 as a fail with the API message', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedPatch.mockRejectedValue(new AdminApiError(400, 'retentionDays must be >= windowDays'));
    const result = (await actions.patch(formEvent({ windowDays: '20' }))) as any;
    expect(result.status).toBe(400);
    expect(result.data.message).toBe('retentionDays must be >= windowDays');
  });
});
```

- [ ] **Step 2: Run it — FAIL**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/\[projectId\]/page.server.test.ts`
Expected: FAIL — `./+page.server` not found.

- [ ] **Step 3: Write the load + patch action**

Create `apps/dashboard/src/routes/admin/[projectId]/+page.server.ts`. (Task 6 extends this file with the lifecycle actions — keep the imports it will also need.)

```ts
import type { PageServerLoad, Actions } from './$types';
import { error, fail } from '@sveltejs/kit';
import {
  listProjects,
  patchProject,
  adminConfigured,
  AdminApiError,
  MissingAdminTokenError,
} from '$lib/server/adminApi';
import { validateConfigForm, buildConfigPatch, CONFIG_FIELD_SPECS } from '$lib/admin-validation';

export const load: PageServerLoad = async ({ params }) => {
  const { projects } = await listProjects();
  const project = projects.find((p) => p.id === params.projectId);
  if (!project) throw error(404, 'Project not found');
  return { project };
};

// Converts an adminApi throw to the right `fail`, tagged with the action name
// so the page can route the feedback to the correct section.
function actionError(action: string, e: unknown) {
  if (e instanceof MissingAdminTokenError) return fail(403, { action, message: e.message });
  if (e instanceof AdminApiError) return fail(e.statusCode, { action, message: e.message });
  return fail(502, { action, message: 'Unexpected error contacting the API.' });
}

export const actions = {
  patch: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'patch', message: 'ADMIN_TOKEN not set.' });

    const form = await request.formData();
    const raw: Record<string, string> = {};
    for (const field of Object.keys(CONFIG_FIELD_SPECS)) {
      raw[field] = String(form.get(field) ?? '');
    }
    raw.webhookUrl = String(form.get('webhookUrl') ?? '');
    raw.webhookKind = String(form.get('webhookKind') ?? '');

    const { valid, errors } = validateConfigForm(raw);
    if (!valid) return fail(400, { action: 'patch', errors });

    const body = buildConfigPatch(raw, form.get('autoQuarantineEnabled') != null);
    try {
      await patchProject(params.projectId, body);
      return { action: 'patch', success: true };
    } catch (e) {
      return actionError('patch', e);
    }
  },
} satisfies Actions;
```

- [ ] **Step 4: Run the load + patch tests — PASS**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/\[projectId\]/page.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the detail page (settings section only)**

Create `apps/dashboard/src/routes/admin/[projectId]/+page.svelte`. Task 6 appends the lifecycle sections to this file; this step is the settings form. Helper `val()` renders a current numeric value or `''` (so an empty field means reset-to-default).

```svelte
<script lang="ts">
  import type { PageData } from './$types';
  import { enhance } from '$app/forms';

  // `data` uses the generated PageData; `form` is hand-typed (Global Constraint
  // 3) — the union of all four actions' returns is not worth narrowing. Task 6
  // adds `token`/`warning`/`prune` to this same interface.
  interface DetailFormResult {
    action?: 'patch' | 'rotate' | 'prune' | 'delete';
    success?: boolean;
    errors?: Record<string, string>;
    message?: string;
  }
  interface Props {
    data: PageData;
    form: DetailFormResult | null;
  }

  let { data, form }: Props = $props();

  const project = $derived(data.project);
  // form.errors is set only by the patch action's validation fail. Typed
  // Record<string,string> so `patchErrors[field.name]` indexes cleanly.
  const patchErrors: Record<string, string> = $derived(
    form?.action === 'patch' && form.errors ? form.errors : {}
  );

  function val(n: number | null): string {
    return n === null ? '' : String(n);
  }
</script>

<svelte:head>
  <title>{project.name} · Admin | Flackyness</title>
</svelte:head>

<div class="mb-8">
  <a href="/admin" class="text-sm text-purple-600 hover:underline">&larr; Back to projects</a>
  <h1 class="text-2xl font-bold text-gray-900 mt-2">{project.name}</h1>
  <p class="text-muted">
    {project.stats.totalRuns} runs · {project.stats.activeFlakyTests} active flaky
  </p>
</div>

<!-- Settings -->
<section class="card p-6 max-w-2xl mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-4">Settings</h2>
  {#if form?.action === 'patch' && form.success}
    <p class="text-sm text-green-600 mb-3">Settings saved.</p>
  {/if}
  {#if form?.action === 'patch' && form.message}
    <p class="text-sm text-red-600 mb-3">{form.message}</p>
  {/if}
  <form method="POST" action="?/patch" use:enhance class="flex flex-col gap-4">
    <p class="text-xs text-muted">Leave a field blank to reset it to the system default.</p>

    {#each [
      { name: 'flakeThreshold', label: 'Flake threshold (0–1)', value: val(project.flakeThreshold) },
      { name: 'windowDays', label: 'Window days (1–90)', value: val(project.windowDays) },
      { name: 'minRuns', label: 'Min runs (1–100)', value: val(project.minRuns) },
      { name: 'retentionDays', label: 'Retention days (1–3650)', value: val(project.retentionDays) },
      { name: 'quarantineThreshold', label: 'Quarantine threshold (0–1)', value: val(project.quarantineThreshold) },
      { name: 'quarantineMinRuns', label: 'Quarantine min runs (1–100)', value: val(project.quarantineMinRuns) },
      { name: 'quarantineTtlDays', label: 'Quarantine TTL days (1–365)', value: val(project.quarantineTtlDays) },
    ] as field}
      <div>
        <label for={field.name} class="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
        <input
          id={field.name}
          name={field.name}
          type="text"
          value={field.value}
          class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
        />
        {#if patchErrors[field.name]}
          <p class="text-xs text-red-600 mt-1">{patchErrors[field.name]}</p>
        {/if}
      </div>
    {/each}

    <div>
      <label for="webhookUrl" class="block text-sm font-medium text-gray-700 mb-1">Webhook URL</label>
      <input
        id="webhookUrl"
        name="webhookUrl"
        type="text"
        value={project.webhookUrl ?? ''}
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
      {#if patchErrors.webhookUrl}
        <p class="text-xs text-red-600 mt-1">{patchErrors.webhookUrl}</p>
      {/if}
    </div>

    <div>
      <label for="webhookKind" class="block text-sm font-medium text-gray-700 mb-1">Webhook kind</label>
      <select
        id="webhookKind"
        name="webhookKind"
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      >
        <option value="" selected={project.webhookKind === null}>Auto-detect</option>
        <option value="slack" selected={project.webhookKind === 'slack'}>Slack</option>
        <option value="generic" selected={project.webhookKind === 'generic'}>Generic</option>
      </select>
    </div>

    <label class="flex items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" name="autoQuarantineEnabled" checked={project.autoQuarantineEnabled} />
      Enable auto-quarantine
    </label>

    <button type="submit" class="pill-btn pill-btn-primary self-start">Save settings</button>
  </form>
</section>
```

- [ ] **Step 6: Write the settings render test**

Create `apps/dashboard/src/routes/admin/[projectId]/page.svelte.test.ts` (Task 6 adds lifecycle cases to this file):

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import type { AdminProject } from '../../../app.d';

const project = (over: Partial<AdminProject> = {}): AdminProject => ({
  id: 'p1',
  name: 'Proj One',
  gitlabProjectId: null,
  hasToken: true,
  createdAt: '2026-01-01T00:00:00Z',
  flakeThreshold: 0.1,
  windowDays: 14,
  minRuns: 5,
  webhookUrl: null,
  webhookKind: null,
  retentionDays: 30,
  autoQuarantineEnabled: false,
  quarantineThreshold: null,
  quarantineMinRuns: null,
  quarantineTtlDays: null,
  stats: { totalRuns: 3, totalTests: 9, activeFlakyTests: 1 },
  ...over,
});

// Layout half of PageData (Global Constraint 1). `data` for this route =
// { projects, selectedProject, apiError } ∪ { project }.
const layout = {
  projects: [],
  selectedProject: { id: 'p1', name: 'Proj One', createdAt: '2026-01-01T00:00:00Z' },
  apiError: null,
};

describe('admin/[projectId]/+page settings', () => {
  it('pre-fills numeric fields and leaves nulls blank', async () => {
    render(Page, { props: { data: { ...layout, project: project() }, form: null } });
    await expect.element(page.getByLabelText('Window days (1–90)')).toHaveValue('14');
    await expect.element(page.getByLabelText('Quarantine TTL days (1–365)')).toHaveValue('');
  });

  it('renders per-field validation errors from a patch fail', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project() },
        form: { action: 'patch', errors: { windowDays: 'must be between 1 and 90' } },
      },
    });
    await expect.element(page.getByText('must be between 1 and 90')).toBeInTheDocument();
  });

  it('confirms a successful save', async () => {
    render(Page, {
      props: { data: { ...layout, project: project() }, form: { action: 'patch', success: true } },
    });
    await expect.element(page.getByText('Settings saved.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run render tests + typecheck**

Run: `rtk proxy pnpm --filter dashboard test:browser` — Expected: settings render tests PASS.
Run: `rtk proxy pnpm --filter dashboard check` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/routes/admin/\[projectId\]/
git commit -m "feat(dashboard): project detail page with settings editor"
```

---

### Task 6: Detail page lifecycle — rotate, prune (two-phase), delete (typed-confirm)

**Files:**
- Modify: `apps/dashboard/src/routes/admin/[projectId]/+page.server.ts` (add 4 actions)
- Modify: `apps/dashboard/src/routes/admin/[projectId]/+page.svelte` (add 3 sections)
- Modify: `apps/dashboard/src/routes/admin/[projectId]/page.server.test.ts` (add cases)
- Modify: `apps/dashboard/src/routes/admin/[projectId]/page.svelte.test.ts` (add cases)

**Interfaces:**
- Consumes: `rotateToken()`, `pruneProject()`, `deleteProject()` (Task 2); `TokenReveal` (Task 4); `formatDate` (`$lib/format`).
- Produces: `actions.rotate`, `actions.pruneDryRun`, `actions.pruneConfirm`, `actions.delete`. `delete` enforces typed-name confirmation server-side and `redirect`s to `/admin` on success.

- [ ] **Step 1: Add the failing action tests**

Append to `apps/dashboard/src/routes/admin/[projectId]/page.server.test.ts` these describe blocks (and add `rotateToken, pruneProject, deleteProject` to the `vi.mock` factory and imports). Full updated mock factory:

```ts
vi.mock('$lib/server/adminApi', () => ({
  listProjects: vi.fn(),
  patchProject: vi.fn(),
  rotateToken: vi.fn(),
  pruneProject: vi.fn(),
  deleteProject: vi.fn(),
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
```

New describe blocks (import the added mocks + `redirect` awareness — a thrown `redirect` has a `status` and `location`):

```ts
import { rotateToken, pruneProject, deleteProject } from '$lib/server/adminApi';
const mockedRotate = vi.mocked(rotateToken);
const mockedPrune = vi.mocked(pruneProject);
const mockedDelete = vi.mocked(deleteProject);

describe('admin/[projectId] rotate action', () => {
  it('returns the show-once token', async () => {
    mockedRotate.mockResolvedValue({ project: { id: 'p1', name: 'Proj' }, token: 'new_tok', warning: 'gone' });
    const result = (await actions.rotate(formEvent({}))) as any;
    expect(mockedRotate).toHaveBeenCalledWith('p1');
    expect(result).toMatchObject({ action: 'rotate', token: 'new_tok', warning: 'gone' });
  });
});

describe('admin/[projectId] prune actions', () => {
  it('dry-run returns the preview counts', async () => {
    mockedPrune.mockResolvedValue({ dryRun: true, cutoff: '2026-01-01', runsToDelete: 5, resultsToDelete: 20 });
    const result = (await actions.pruneDryRun(formEvent({}))) as any;
    expect(mockedPrune).toHaveBeenCalledWith('p1', false);
    expect(result).toMatchObject({ action: 'prune', prune: { dryRun: true, runsToDelete: 5 } });
  });

  it('confirm executes the prune', async () => {
    mockedPrune.mockResolvedValue({ dryRun: false, cutoff: '2026-01-01', runsDeleted: 5, resultsDeleted: 20 });
    const result = (await actions.pruneConfirm(formEvent({}))) as any;
    expect(mockedPrune).toHaveBeenCalledWith('p1', true);
    expect(result).toMatchObject({ action: 'prune', prune: { dryRun: false, runsDeleted: 5 } });
  });
});

describe('admin/[projectId] delete action', () => {
  it('rejects when the typed name does not match', async () => {
    const result = (await actions.delete(formEvent({ name: 'Proj', confirmName: 'wrong' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it('deletes and redirects to /admin when the typed name matches', async () => {
    mockedDelete.mockResolvedValue({ success: true, message: 'gone' });
    // The success path throws redirect(303, '/admin'); catch it to inspect.
    const thrown: any = await actions.delete(formEvent({ name: 'Proj', confirmName: 'Proj' })).catch((e) => e);
    expect(mockedDelete).toHaveBeenCalledWith('p1');
    expect(thrown.status).toBe(303);
    expect(thrown.location).toBe('/admin');
  });
});
```

- [ ] **Step 2: Run — FAIL**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/\[projectId\]/page.server.test.ts`
Expected: FAIL — `actions.rotate`/`pruneDryRun`/`pruneConfirm`/`delete` undefined.

- [ ] **Step 3: Add the lifecycle actions**

In `apps/dashboard/src/routes/admin/[projectId]/+page.server.ts`: add `redirect` to the `@sveltejs/kit` import and `rotateToken, pruneProject, deleteProject` to the adminApi import, then add these actions inside the `actions` object (alongside `patch`):

```ts
  rotate: async ({ params }) => {
    if (!adminConfigured()) return fail(403, { action: 'rotate', message: 'ADMIN_TOKEN not set.' });
    try {
      const result = await rotateToken(params.projectId);
      return { action: 'rotate', token: result.token, warning: result.warning };
    } catch (e) {
      return actionError('rotate', e);
    }
  },

  pruneDryRun: async ({ params }) => {
    if (!adminConfigured()) return fail(403, { action: 'prune', message: 'ADMIN_TOKEN not set.' });
    try {
      const prune = await pruneProject(params.projectId, false);
      return { action: 'prune', prune };
    } catch (e) {
      return actionError('prune', e);
    }
  },

  pruneConfirm: async ({ params }) => {
    if (!adminConfigured()) return fail(403, { action: 'prune', message: 'ADMIN_TOKEN not set.' });
    try {
      const prune = await pruneProject(params.projectId, true);
      return { action: 'prune', prune };
    } catch (e) {
      return actionError('prune', e);
    }
  },

  delete: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'delete', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const name = String(form.get('name') ?? '');
    const confirmName = String(form.get('confirmName') ?? '');
    // Server-side footgun guard: the typed name must match the name we showed.
    // (The client also disables the button; this is the real check.)
    if (confirmName !== name || name === '') {
      return fail(400, { action: 'delete', message: 'Type the exact project name to confirm.' });
    }
    try {
      await deleteProject(params.projectId);
    } catch (e) {
      return actionError('delete', e);
    }
    throw redirect(303, '/admin');
  },
```

> **Note:** `throw redirect(...)` must sit OUTSIDE the try/catch — a redirect is a control-flow throw, and catching it would turn a successful delete into a 502.

- [ ] **Step 4: Run the action tests — PASS**

Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/\[projectId\]/page.server.test.ts`
Expected: PASS (all patch + lifecycle blocks).

- [ ] **Step 5: Add the lifecycle sections to the page**

In `apps/dashboard/src/routes/admin/[projectId]/+page.svelte`: add `import TokenReveal from '$lib/components/TokenReveal.svelte';` and `import { formatDate } from '$lib/format';` to the script. Extend the `DetailFormResult` interface from Task 5 with the lifecycle fields, and add the typed-confirm state:

```ts
  // Extend the Task 5 interface — add these fields:
  interface DetailFormResult {
    action?: 'patch' | 'rotate' | 'prune' | 'delete';
    success?: boolean;
    errors?: Record<string, string>;
    message?: string;
    token?: string;
    warning?: string;
    prune?: {
      dryRun: boolean;
      cutoff: string;
      runsToDelete?: number;
      resultsToDelete?: number;
      runsDeleted?: number;
      resultsDeleted?: number;
    };
  }
```

```ts
  let confirmName = $state('');
  const canDelete = $derived(confirmName === project.name);
```

Append these three sections after the settings `<section>`:

```svelte
<!-- Rotate token -->
<section class="card p-6 max-w-2xl mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-2">API token</h2>
  {#if form?.action === 'rotate' && form.token}
    <div class="mb-4">
      <TokenReveal token={form.token!} warning={form.warning!} />
    </div>
  {/if}
  {#if form?.action === 'rotate' && form.message}
    <p class="text-sm text-red-600 mb-3">{form.message}</p>
  {/if}
  <p class="text-sm text-muted mb-3">
    Rotating issues a new token and invalidates the current one immediately — CI using the old
    token will fail until its secret is updated.
  </p>
  <form method="POST" action="?/rotate" use:enhance>
    <button type="submit" class="pill-btn pill-btn-ghost">Rotate token</button>
  </form>
</section>

<!-- Prune -->
<section class="card p-6 max-w-2xl mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-2">Prune old data</h2>
  {#if form?.action === 'prune' && form.prune}
    {#if form.prune.dryRun}
      <p class="text-sm text-gray-700 mb-3">
        This will delete {form.prune.runsToDelete} runs / {form.prune.resultsToDelete} results
        older than {formatDate(form.prune.cutoff)}.
      </p>
      <form method="POST" action="?/pruneConfirm" use:enhance class="mb-4">
        <button
          type="submit"
          class="pill-btn bg-red-600 text-white hover:bg-red-700"
        >
          Confirm prune
        </button>
      </form>
    {:else}
      <p class="text-sm text-green-600 mb-3">
        Deleted {form.prune.runsDeleted} runs / {form.prune.resultsDeleted} results.
      </p>
    {/if}
  {/if}
  {#if form?.action === 'prune' && form.message}
    <p class="text-sm text-red-600 mb-3">{form.message}</p>
  {/if}
  <form method="POST" action="?/pruneDryRun" use:enhance>
    <button type="submit" class="pill-btn pill-btn-ghost">Preview prune…</button>
  </form>
</section>

<!-- Delete -->
<section class="card p-6 max-w-2xl border border-red-200">
  <h2 class="text-lg font-semibold text-red-700 mb-2">Delete project</h2>
  <p class="text-sm text-muted mb-3">
    Permanently deletes “{project.name}” and all its runs, results, and flaky-test history. This
    cannot be undone.
  </p>
  {#if form?.action === 'delete' && form.message}
    <p class="text-sm text-red-600 mb-3">{form.message}</p>
  {/if}
  <form method="POST" action="?/delete" use:enhance class="flex flex-col gap-3">
    <input type="hidden" name="name" value={project.name} />
    <label for="confirmName" class="text-sm text-gray-700">
      Type <span class="font-mono font-semibold">{project.name}</span> to confirm:
    </label>
    <input
      id="confirmName"
      name="confirmName"
      type="text"
      autocomplete="off"
      bind:value={confirmName}
      aria-label="Type the project name to confirm"
      class="w-full max-w-sm border border-subtle rounded-lg px-3 py-2 text-sm"
    />
    <button
      type="submit"
      disabled={!canDelete}
      class="pill-btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed self-start"
    >
      Delete permanently
    </button>
  </form>
</section>
```

- [ ] **Step 6: Add the lifecycle render tests**

Append to `apps/dashboard/src/routes/admin/[projectId]/page.svelte.test.ts`:

```ts
describe('admin/[projectId]/+page lifecycle', () => {
  it('shows the token reveal after a rotate', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project() },
        form: { action: 'rotate', token: 'rot_tok', warning: 'gone forever' },
      },
    });
    await expect.element(page.getByText('rot_tok')).toBeInTheDocument();
  });

  it('shows prune preview counts and a confirm button on a dry run', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project() },
        form: {
          action: 'prune',
          prune: { dryRun: true, cutoff: '2026-01-01T00:00:00Z', runsToDelete: 5, resultsToDelete: 20 },
        },
      },
    });
    await expect.element(page.getByText(/will delete 5 runs \/ 20 results/)).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Confirm prune' })).toBeInTheDocument();
  });

  it('keeps Delete disabled until the exact name is typed', async () => {
    render(Page, { props: { data: { ...layout, project: project() }, form: null } });
    const btn = page.getByRole('button', { name: 'Delete permanently' });
    await expect.element(btn).toBeDisabled();
    await page.getByLabelText('Type the project name to confirm').fill('wrong');
    await expect.element(btn).toBeDisabled();
    await page.getByLabelText('Type the project name to confirm').fill('Proj One');
    await expect.element(btn).toBeEnabled();
  });
});
```

- [ ] **Step 7: Run render tests + node tests + typecheck**

Run: `rtk proxy pnpm --filter dashboard test:browser` — Expected: lifecycle render tests PASS.
Run: `rtk proxy pnpm --filter dashboard exec vitest run src/routes/admin/\[projectId\]/page.server.test.ts` — Expected: PASS.
Run: `rtk proxy pnpm --filter dashboard check` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/routes/admin/\[projectId\]/
git commit -m "feat(dashboard): project rotate, prune, and typed-confirm delete"
```

---

### Task 7: E2E lifecycle spec + docs

**Files:**
- Create: `apps/dashboard/e2e/admin.spec.ts`
- Modify: `docs/API.md`, `AGENTS.md`, `plans/README.md`, `docs/STRATEGY.md`

**Interfaces:**
- Consumes: the running API + built dashboard (Playwright `webServer`). Relies on `ADMIN_TOKEN` being exported (already required by `e2e/global-setup.ts`) and `DASHBOARD_PASSWORD` being unset (already the case for the green suite). No `playwright.config.ts` change: the webServer inherits the full `process.env` (`{ ...DEFAULT, ...process.env, ...options.env }`), so the dashboard server sees `ADMIN_TOKEN`.

> **Why no seed change:** the spec creates and deletes its OWN uniquely-named project, so it never touches the shared seed project other specs depend on. Create and delete are synchronous (no flaky-reconcile race), so no `waitFor` polling is needed here.

- [ ] **Step 1: Write the E2E spec**

Create `apps/dashboard/e2e/admin.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('admin console (/admin)', () => {
  test('creates a project, reveals its token once, then deletes it', async ({ page }) => {
    const name = `e2e-admin-${Date.now()}`;

    // Create
    await page.goto('/admin/new');
    await page.getByLabel('Project name').fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();

    // Token is revealed exactly once
    const tokenPanel = page.getByTestId('token-reveal');
    await expect(tokenPanel).toBeVisible();
    const tokenText = await tokenPanel.locator('code').textContent();
    expect(tokenText?.trim().length ?? 0).toBeGreaterThan(0);

    // Reload the create page — the token is gone (never re-fetchable)
    await page.goto('/admin/new');
    await expect(page.getByTestId('token-reveal')).not.toBeVisible();

    // The new project appears in the list
    await page.goto('/admin');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();

    // Open detail, delete with typed confirmation
    await row.getByRole('link', { name: 'Manage' }).click();
    const deleteBtn = page.getByRole('button', { name: 'Delete permanently' });
    await expect(deleteBtn).toBeDisabled();
    await page.getByLabel('Type the project name to confirm').fill(name);
    await expect(deleteBtn).toBeEnabled();
    await deleteBtn.click();

    // Redirected to the list; the project is gone
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('row', { name: new RegExp(name) })).not.toBeVisible();
  });
});
```

> **Load-bearing assertion:** the "token non-empty on create, then gone after reload" pair is the whole point of the show-once test — keep it intact even if selectors need tweaking against the built page.

- [ ] **Step 2: Run the E2E suite**

Requires a running Postgres + API with `ADMIN_TOKEN` exported (see `AGENTS.md` E2E row). From `apps/dashboard`:

Run: `rtk proxy pnpm --filter dashboard test:e2e`
Expected: the existing specs + the new `admin.spec.ts` all PASS. (If the API isn't up, start a disposable Postgres via `docker run` and `pnpm --filter api dev` per `AGENTS.md` — never `docker compose`.)

- [ ] **Step 3: Update the docs**

**`docs/API.md`** — under the admin section, add a short note that the dashboard now ships a `/admin` console over these same endpoints (gated by `DASHBOARD_PASSWORD`, spending `ADMIN_TOKEN` server-side). No endpoint contract changes.

**`AGENTS.md`** — add a Sharp-edges/Conventions bullet:

```
- **The dashboard `/admin` console spends `ADMIN_TOKEN` server-side (plan
  053).** Reads/writes go through `$lib/server/adminApi.ts` (server-only) and
  SvelteKit form actions — the token never reaches the browser. The console is
  gated by the same `hooks.server.ts` `DASHBOARD_PASSWORD` Basic Auth as every
  other route; the API admin endpoints stay `ADMIN_TOKEN`-gated as the real
  boundary (roadmap #6 owns per-user auth). Delete requires server-side typed
  name confirmation; prune uses the API's two-phase dry-run→confirm.
```

**`plans/README.md`** — add the row for plan 053 (Admin console UI, roadmap 4a), following the existing table format.

**`docs/STRATEGY.md`** — mark roadmap #4 as partially delivered: 4a (admin config UI) shipped, 4b (rule engine) still pending as its own spec/plan.

- [ ] **Step 4: Full verification + commit**

Run: `rtk proxy pnpm --filter dashboard test` (node) — Expected: PASS.
Run: `rtk proxy pnpm --filter dashboard test:browser` — Expected: PASS.
Run: `rtk proxy pnpm --filter dashboard check` — Expected: clean.
Run: `rtk proxy pnpm --filter dashboard exec oxlint` (or repo lint command) — Expected: clean.

```bash
git add apps/dashboard/e2e/admin.spec.ts docs/API.md AGENTS.md plans/README.md docs/STRATEGY.md
git commit -m "test(dashboard): admin console E2E lifecycle + docs"
```

---

## Self-Review

**Spec coverage** (each design section → task):
- Routes & nav → Tasks 3 (list + nav), 4 (new), 5 (detail).
- Write path (server-only client + form actions) → Task 2 (`adminApi`), used by 3–6.
- Read source (reuse list, no single-project GET) → Task 5 `load` filters the list by id. ✓
- Show-once token → Task 4 (`TokenReveal` + create), Task 6 (rotate). ✓
- Prune two-phase → Task 6. Delete typed-confirm (server-enforced) → Task 6. ✓
- Validation & errors → Task 1 (pure) + every action forwarding the API 4xx. ✓
- Testing (node unit / browser render / E2E) → every task; E2E → Task 7. ✓
- Scope-out (rule engine, single-project GET, audit viewer, roles) → not built. ✓

**Placeholder scan:** none — every step ships complete code or exact edits.

**Type consistency:** `AdminProject` (Task 2) is the single row type used by list load (Task 3), detail load (Task 5), and every render fixture. The list load's return key is `adminProjects` (not `projects`) to avoid shadowing the layout's `projects` in `PageData` (Global Constraint 2) — the page and its tests use that key consistently. The `form` prop is hand-typed per page (`CreateFormResult`, `DetailFormResult`) rather than the generated `ActionData` union (Global Constraint 3); Task 6 extends `DetailFormResult` with `token`/`warning`/`prune`. Action discriminator `action: 'patch'|'rotate'|'prune'|'delete'` is consistent between the actions and the `{#if form?.action === ...}` guards. `buildConfigPatch`/`validateConfigForm` signatures (Task 1) match their call sites (Task 5). Render-test `data` fixtures carry the layout `PageData` keys (Global Constraint 1); server-test result access is `as any` (Global Constraint 4).

**svelte-check note:** every page-owning task ends with a `check` step, because `.svelte-kit/tsconfig.json` type-checks `src/**/*.ts` (tests included). The four typing rules in Global Constraints exist specifically to keep that step green.
