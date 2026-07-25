# Rules Console UI — design

**Date:** 2026-07-24
**Roadmap:** #4b fast-follow (deferred from plan 054)
**Status:** approved, ready for implementation plan

## Context

Plan 054 (merged as PR #112, commit `3866a7a`) shipped the quarantine **rule
engine** (`services/rules.ts`) and its **admin CRUD + reorder API**
(`/api/v1/admin/projects/:id/rules(/:ruleId)` + `.../rules/reorder`), but no
dashboard surface. Creating, editing, or reordering rules today means calling
the admin API directly with `curl`/Postman. This spec covers the **dashboard
console UI** that manages those rules — the sanctioned fast-follow named in
plan 054's own "Scope boundaries (YAGNI)" section.

The UI is a thin, server-mediated view over an API that already exists and
already enforces every invariant. It adds **no** new API endpoints and **no**
new business logic — it is the operator's window onto plan 054's engine.

## Goal

Give an operator a focused screen to list a project's quarantine rules in
evaluation (priority) order, create/edit/delete them, reorder them, and
quickly enable/disable one — all without ever exposing `ADMIN_TOKEN` to the
browser.

## Scope boundaries (YAGNI)

**In scope:** list, create, edit, delete (typed-confirm), reorder (up/down),
quick enable-toggle.

**Deliberately out of scope** (named follow-ups, not built speculatively):

- **Rule dry-run / preview** against recent runs — the API exposes no such
  endpoint; building one is its own roadmap item.
- **Drag-and-drop reorder** — up/down buttons are the honest,
  progressive-enhancement baseline; drag-drop is a later enhancement.
- **Bulk enable/disable / multi-select.**

## Existing patterns this reuses (roadmap 4a, plan 053)

- **Server-only token spend:** `$lib/server/adminApi.ts` holds `ADMIN_TOKEN`
  (private env), talks to the API with `Authorization: Bearer`, and is
  imported only from `+page.server.ts`. The token never reaches the browser.
- **Error taxonomy:** `AdminApiError(statusCode, message)` (non-2xx from the
  API, carries the API's own error string) and `MissingAdminTokenError` (the
  dashboard has no token configured). The page-server `actionError(action, e)`
  helper maps these to the right `fail(...)`.
- **Form actions + `use:enhance`:** every mutation is a named SvelteKit form
  action; the page re-renders from the re-run `load` after each submit.
- **Basic Auth gate:** `hooks.server.ts` `DASHBOARD_PASSWORD` already covers
  every `/admin` route.
- **Testable view-logic in `$lib`:** pure helpers (`format.ts`, `status.ts`,
  `admin-validation.ts`) are node-unit-tested and mutation-proven; `.svelte`
  components import them rather than inlining logic.

## API contract consumed (already live)

All under `/api/v1/admin`, `ADMIN_TOKEN`-gated. Documented in `docs/API.md`.

| Method & path | Body | Response |
|---|---|---|
| `GET /projects/:id/rules` | — | `{ rules: Rule[] }` ordered by ascending `position` (first match wins) |
| `POST /projects/:id/rules` | full rule (see shape) | `{ rule }` `201`; appended after current max position unless `position` given |
| `PATCH /projects/:id/rules/:ruleId` | partial rule | `{ rule }`; the **merged** (existing + patch) row is re-validated server-side |
| `DELETE /projects/:id/rules/:ruleId` | — | `{ success: true }`; `404` if not found |
| `POST /projects/:id/rules/reorder` | `{ order: ruleId[] }` | `{ success: true }`; `order` must be **exactly** the project's current rule id set (no missing/extra/duplicate) |

Cross-project isolation: `GET`/`POST` return `404` on an unknown project;
`PATCH`/`DELETE`/reorder scope by `(projectId, ruleId)`.

### Rule shape (`serializeRule` output)

```
id, projectId, position (int)
name          : string | null
enabled       : boolean
selectorBranch: string | null   // glob, no regex
selectorFile  : string | null   // glob, no regex
selectorTag   : string | null   // exact tag membership
action        : 'quarantine' | 'exempt'
conditionType : 'flake_rate' | 'consecutive' | null
flakeThreshold: number | null   // 0..1 (surfaced as number; stored .toFixed(4))
minRuns       : number | null   // 1..100
windowDays    : number | null   // 1..90
consecutiveFailures: number | null  // 1..100
ttlDays       : number | null   // 1..365
createdAt, updatedAt
```

### Consistency invariants (enforced by the API; mirrored by the UI for UX)

- `action === 'exempt'` ⇒ **no** condition fields (`conditionType`,
  `flakeThreshold`, `consecutiveFailures` must all be null).
- `action === 'quarantine'` ⇒ `conditionType` **required**; and
  - `flake_rate` ⇒ `flakeThreshold` required;
  - `consecutive` ⇒ `consecutiveFailures` required.
- A blank/omitted optional field means `null` = "use the project/system
  default", the same convention as the 4a Settings form.

## Architecture

### Route

New route **`/admin/[projectId]/rules`**, linked from the existing
`/admin/[projectId]` settings page ("Quarantine rules →").

`+page.server.ts`:

- `load({ params })`: `403` if `!adminConfigured()`; fetch the project via
  `listProjects()` + `.find(id)` (for name/breadcrumb, `404` if absent) and
  the rules via `listRules(projectId)`. Returns `{ project, rules }`.
- `actions`:
  - `create` — `validateRuleForm(raw)` → `fail(400, { errors })` on invalid;
    else `createRule(id, buildRulePayload(raw))`.
  - `update` — same validation → `patchRule(id, ruleId, payload)`.
  - `delete` — `deleteRule(id, ruleId)`. No server-side typed-name gate: a
    rule delete is low-stakes and re-addable (unlike project delete's cascade
    data loss), and rule `name` is nullable so a typed-name confirm is
    ill-defined. The confirmation is a lightweight **client** two-step (see
    component); the action itself just deletes.
  - `toggle` — `patchRule(id, ruleId, { enabled })`; a quick per-row
    enable/disable that does not open the editor.
  - `reorder` — form submits a `ruleId` + `direction` (`up`/`down`). The
    action **re-fetches the authoritative current order** via
    `listRules(id)`, swaps the target with its adjacent neighbor, and posts
    the **full** reordered id array to `reorderRules(id, order)`. Sourcing the
    current order server-side (not from a hidden client field) keeps it
    authoritative; reorder is all-or-nothing so the action always submits the
    complete current id set. A no-op (▲ at the top / ▼ at the bottom) is a
    guarded no-op, not an API call.
  - Each catches via `actionError(action, e)`.

### Server client additions (`$lib/server/adminApi.ts`)

Five thin functions over the existing `adminFetch`:

```
listRules(id): Promise<{ rules: QuarantineRule[] }>
createRule(id, body): Promise<{ rule: QuarantineRule }>
patchRule(id, ruleId, body): Promise<{ rule: QuarantineRule }>
deleteRule(id, ruleId): Promise<{ success: boolean }>
reorderRules(id, order: string[]): Promise<{ success: boolean }>
```

New `QuarantineRule` type in `app.d.ts` matching the serialized shape above.

### Pure helpers (`$lib`, node-unit-tested, mutation-gate candidates)

- **`$lib/rules-validation.ts`** — `validateRuleForm(raw): { valid, errors }`
  and `buildRulePayload(raw): body`. Encodes the same consistency invariants
  and bounds the server enforces, so the operator gets inline errors before
  the round-trip. The server remains the real boundary (a stale/edited client
  can still submit anything; the API rejects it).
- **`$lib/rule-summary.ts`** — `describeRule(rule): string`. Renders a
  one-line human summary used in list rows, e.g.
  `"main · flake ≥ 0.30 over ≥ 5 runs / 14d"` or `"exempt · release/*"`.

### Component (`+page.svelte`)

- **Header:** breadcrumb back to the project, project name, "+ Add rule".
- **List** in priority order — each row: position #, ▲/▼ reorder buttons (▲
  disabled at position 0, ▼ disabled at the last row), `describeRule(rule)`
  summary, an enable/disable toggle (posts `toggle`), **Edit**, **Delete**.
  Delete is a lightweight two-step: the first click flips the row into an
  inline "Confirm delete? [Yes] [Cancel]" state (client `$state`), and only
  "Yes" submits the `delete` action — proportionate to a low-stakes,
  re-addable row. Disabled rules are visibly dimmed. Empty state when a
  project has no rules yet, explaining the legacy-threshold fallback.
- **Inline editor panel** below the list — a single form serving both add (no
  ruleId) and edit (prefilled), toggled by a client `$state<string | null>`
  (`null` closed, `'new'`, or a ruleId). Conditional fields:
  `action` select → when `quarantine`, reveal `conditionType` select →
  `flake_rate` reveals threshold/minRuns/windowDays; `consecutive` reveals
  consecutiveFailures/windowDays. Plus selectors (branch glob, file glob,
  tag), name, ttlDays, enabled. On a successful submit the panel closes.
- All forms use `use:enhance`.

### Error handling

- `MissingAdminTokenError` → `fail(403)`; the load throws `error(403)` when
  `!adminConfigured()` so the whole page shows the standard error surface.
- `AdminApiError` → `fail(e.statusCode, { action, message })`; the API's own
  message (e.g. "order must be exactly the project's current rule ids",
  "flake_rate needs flakeThreshold") is surfaced verbatim to the operator.
- Client validation errors (`validateRuleForm`) render inline per-field; they
  never replace the server check.

## Testing

- **`rules-validation.test.ts`, `rule-summary.test.ts`** — node env,
  mutation-proven (every invariant branch reddable by a mutation).
- **`page.server.test.ts`** — `load` (403 no-token / 404 missing project /
  happy) and every action (happy path + `AdminApiError`/`MissingAdminToken`
  mapping), including the reorder swap computation (re-fetch current order →
  adjacent swap → full-set post; guarded no-op at the ends) and the toggle.
- **`page.svelte.test.ts`** — Vitest browser mode (per AGENTS.md; jsdom does
  not compile `.svelte` here): renders rules in order, conditional editor
  fields show/hide by action+conditionType, reorder buttons disabled at the
  ends, disabled rules dimmed.
- **E2E** — extend the existing admin Playwright spec with a rules
  round-trip: create → reorder → edit → toggle → delete, each change visible
  after reload. `ORIGIN` is already set in `playwright.config.ts`'s
  `webServer.env` (the CSRF caveat from plan 053).

## Constraints honored

- No `ADMIN_TOKEN` in the browser — server-only client + form actions.
- No new API endpoint ⇒ no `readAuth`/route-count-guard change (the endpoints
  are ADMIN_TOKEN-gated and already counted).
- Decimal `flakeThreshold` compared via `Number(...)`, written via API (which
  does `.toFixed(4)`); the UI never touches the DB.
- Structured logger only (no `console.log`) in any server code.
- Basic-Auth gate via existing `hooks.server.ts`.
- Single-line conventional-commit subjects; no `Co-Authored-By` trailers.

## Deliverables

- `apps/dashboard/src/routes/admin/[projectId]/rules/+page.server.ts`
- `apps/dashboard/src/routes/admin/[projectId]/rules/+page.svelte`
- `apps/dashboard/src/lib/server/adminApi.ts` (+5 functions)
- `apps/dashboard/src/lib/rules-validation.ts` + test
- `apps/dashboard/src/lib/rule-summary.ts` + test
- `apps/dashboard/src/app.d.ts` (`QuarantineRule` type)
- `apps/dashboard/src/routes/admin/[projectId]/+page.svelte` (add the link)
- Render + server + E2E tests as above
- `docs/API.md` unchanged (no API change); `plans/README.md` backlog item
  closed.
