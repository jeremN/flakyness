# Admin Console UI (Roadmap 4a) — Design

**Status:** Design approved (scope B full console; auth A reuse `DASHBOARD_PASSWORD`
with `ADMIN_TOKEN` server-side; API stays the real boundary; destructive ops get
typed-confirm). Awaiting spec review before planning.

**Roadmap:** STRATEGY.md #4 — "Rule engine de seuils + UI admin". This spec covers
**4a only** (the admin console UI). The rule engine (**4b**) is a separate
spec/plan cycle that builds on the config surface 4a establishes. Effort ~1j (UI).

**Goal:** Give operators a curl-free, password-gated web console to manage projects
end-to-end — view/edit every per-project knob, create projects, rotate tokens,
prune stale data, and delete projects — without ever shipping `ADMIN_TOKEN` to the
browser.

---

## Why

Every privileged operation today is a raw `curl` against an `ADMIN_TOKEN`-gated
endpoint (`docs/API.md`). That is fine for a scripted CI setup but hostile to a
human operator: creating a project, reading back the one-time ingest token,
adjusting a flake threshold, or pruning a year-old database all mean hand-building
Bearer-auth requests. Roadmap #4 promises "UI admin"; 4a delivers it.

The design is constrained by three existing facts:

1. **The dashboard already holds `ADMIN_TOKEN` and spends it server-side.** Plan 031
   established the pattern: the `flaky` page's mute/unmute form action calls the
   API with the server-held token on the operator's behalf, and
   `hooks.server.ts` gates *every* route behind `DASHBOARD_PASSWORD` so the
   requester must authenticate first. The admin console is the same pattern at
   larger surface area — it adds **no** new auth code.

2. **The API is, and stays, the real security boundary.** The dashboard is a thin,
   replaceable proxy. Per-user auth / roles / SSO is roadmap #6, and it slots in
   at the API layer. 4a must not build throwaway auth complexity in the dashboard
   that #6 would rip out; reusing the existing Basic Auth gate is the thinnest
   replaceable seam.

3. **The admin endpoints already model the affordances the UI needs.** Create and
   rotate return the plaintext token exactly once (only the hash is stored). Prune
   is two-phase (dry-run preview → `?confirm=true` execute). Delete is a
   transactional cascade. The UI surfaces contracts that already exist rather than
   inventing new ones.

---

## Auth model (locked)

- **Gate:** reuse `DASHBOARD_PASSWORD`. `hooks.server.ts` already runs HTTP Basic
  Auth in front of every route by construction, so any `/admin` page is gated with
  zero new code. A deployment with `DASHBOARD_PASSWORD` unset is unchanged
  (single-operator, network-isolated — the plan-031 decision), but the boot-time
  warning about an ungated privileged write path now covers the admin console too.
- **Token custody:** `ADMIN_TOKEN` is held server-side and spent on the operator's
  behalf via SvelteKit **form actions** in `+page.server.ts`. It never crosses the
  network boundary to the client.
- **Defense in depth:** the API admin routes stay `ADMIN_TOKEN`-gated. The
  dashboard gate authenticates the *human*; the API token authenticates the
  *dashboard*. Roadmap #6 replaces the API layer with per-user auth without
  touching this proxy.
- **`ADMIN_TOKEN` unset:** admin actions `fail` with a clear message ("server has
  no ADMIN_TOKEN configured") — the server cannot spend a token it does not hold.
  This mirrors the existing mute/unmute behavior.

---

## Architecture

Neutral shape: **gated `/admin` route tree → per-page `load` (read) + form actions
(write) → server-only admin client → existing `ADMIN_TOKEN`-gated API.**

```
/admin              list page      load: GET /admin/projects (list+stats+config)
/admin/new          create page    action: POST /admin/projects            → show-once token
/admin/[projectId]  detail page    load: filter the list payload by id
                                    actions: PATCH (settings), rotate, prune, delete
```

### Units

- **`$lib/server/adminApi.ts`** (new, server-only) — the write counterpart to the
  read client `$lib/server/api.ts`. Exposes typed helpers that attach
  `Authorization: Bearer ${ADMIN_TOKEN}` and issue POST/PATCH/DELETE against
  `PUBLIC_API_URL`. Imports `$env/dynamic/private`, so it is unimportable from any
  `.svelte` component — the compile-time guarantee that the token stays server-side.
  A missing `ADMIN_TOKEN` is surfaced as a typed error, not a silent unauth request.
  - What it does: server-side privileged API calls. How you use it: from
    `+page.server.ts` `load`/`actions` only. Depends on: `$env/dynamic/private`
    (`ADMIN_TOKEN`), `$env/dynamic/public` (`PUBLIC_API_URL`).

- **`$lib/admin-validation.ts`** (new, pure) — mirrors the API's zod bounds for
  instant client-side feedback: `flakeThreshold` & `quarantineThreshold` ∈ [0, 1];
  `windowDays` int ∈ [1, 90]; `minRuns` & `quarantineMinRuns` int ∈ [1, 100];
  `retentionDays` int ∈ [1, 3650]; `quarantineTtlDays` int ∈ [1, 365];
  `webhookUrl` an http(s) URL ≤ 2048 chars; `webhookKind` ∈ {slack, generic};
  `autoQuarantineEnabled` a boolean; and the cross-field rule
  `retentionDays >= resolved windowDays`. **The API remains the source of truth**;
  this module only pre-empts obviously-invalid submits. Pure, node-unit-tested,
  mutation-provable.
  - What it does: validate admin form input shape/bounds. How you use it: called
    from both the page component (live feedback) and the action (pre-flight).
    Depends on: nothing (pure functions over primitives).

- **`/admin` route pages** — `+page.server.ts` (`load` + `actions`) + `+page.svelte`
  (forms, `use:enhance` progressive enhancement). Each page is one clear surface;
  the detail page composes settings-edit + three lifecycle actions.

### Data flow

- **Read:** `load` → `adminApi` GET `/admin/projects` → typed list. The detail page
  filters that same payload by `projectId` in its `load` — **no new
  `GET /admin/projects/:id`** (YAGNI at operator scale; add it only if the list
  ever needs pagination).
- **Write:** form submit → `+page.server.ts` action → `adminApi` POST/PATCH/DELETE →
  API. On success, redirect or return data (e.g. the show-once token). On the API
  returning 4xx, the action forwards the API's error body to `form.error` for
  inline display — the API's validation is authoritative.

---

## Surfaces

### 1 · Project list — `/admin`
`load` calls `GET /admin/projects` (already returns list + per-project stats +
config). Renders a row per project (name, key config summary, stats) with links to
the detail page and a "New project" button. A single "Admin" link is added to the
layout header.

### 2 · Create — `/admin/new`
A form (name, optional `gitlabProjectId`). The action calls `POST /admin/projects`,
which returns `{ project, token, warning }` at 201. **Show-once token UX** (below).
A dedicated page (not a modal) because it owns the token-reveal panel.

### 3 · Settings edit — `/admin/[projectId]` (PATCH)
Form over the exact set `PATCH /admin/projects/:id` accepts: `flakeThreshold`,
`windowDays`, `minRuns`, `retentionDays`, `webhookUrl`, `webhookKind`, and the
auto-quarantine knobs `autoQuarantineEnabled`, `quarantineThreshold`,
`quarantineMinRuns`, `quarantineTtlDays`. Semantics match the API: an omitted field
is unchanged; every field except `autoQuarantineEnabled` (a plain boolean) is
nullable, and sending it as `null` resets it to the service default. The current
values come straight from the list payload (`GET /admin/projects` already returns
all of these). Live validation via `$lib/admin-validation.ts`; authoritative
validation is the API's `PATCH` 400 (incl. the `retentionDays >= windowDays` rule).

### 4 · Rotate token — `/admin/[projectId]` (action)
`POST /admin/projects/:id/rotate-token` returns `{ project, token, warning }`. The
old token dies **immediately** (CI using it 401s until the secret is updated), so
the button carries an explicit confirm ("the current token stops working
immediately") — **not** typed-confirm (rotating is recoverable). On success, the
**show-once token panel** renders.

### 5 · Prune — `/admin/[projectId]` (two-phase)
Leans on the API's own two-phase contract:
- **Preview:** a "Prune old data" action POSTs prune with no `?confirm`, receiving
  `{ dryRun: true, cutoff, runsToDelete, resultsToDelete }`. The UI shows "This will
  delete N runs / M results older than `<cutoff>`."
- **Execute:** a second "Confirm prune" action re-POSTs with `?confirm=true`,
  receiving `{ dryRun: false, runsDeleted, resultsDeleted }`.
The count display **is** the guard — no typed confirmation. The UI is not inventing
a confirmation dance; it surfaces the dry-run the API already computes.

### 6 · Delete — `/admin/[projectId]` (typed-confirm)
`DELETE /admin/projects/:id` is an irreversible transactional cascade. The operator
must type the project's **exact name** to enable the "Delete permanently" button
(the locked condition). Standard destructive-action pattern.

---

## Show-once token UX

Applies to **create** and **rotate**. Both return `{ token, warning }`; the API
stores only the hash and can never return the plaintext again.

- The action passes the token to the page via SvelteKit's `form` prop.
- The page renders a prominent panel: the token in a monospace box, a
  copy-to-clipboard button, and the API's own `warning` string verbatim.
- The token lives **only** in that action response — never persisted, never logged,
  never placed in a URL. On reload/navigation it is gone, which is correct: it
  matches the API contract (hash-only storage). Losing it means rotating again.

---

## Error handling

- **API 4xx:** the action reads the API's JSON error body and returns
  `fail(status, { error })`; the page renders `form.error` inline next to the form.
  The API's zod validation and business-rule checks (e.g.
  `retentionDays >= windowDays`, duplicate-name 409) are authoritative.
- **`ADMIN_TOKEN` unset:** `adminApi` throws a typed error; the action converts it
  to a clear `fail` message rather than issuing an unauthenticated request.
- **Network/5xx to the API:** surfaced as a generic "the API is unreachable" inline
  error; no partial state is assumed.
- **Client-side pre-flight:** `$lib/admin-validation.ts` blocks obviously-invalid
  submits for fast feedback, but never substitutes for the server check.

---

## Testing

- **`$lib/admin-validation.ts`** and any new pure helpers → node-env `*.test.ts`,
  written to be mutation-provable (a repo standard: every assertion must fail under
  some mutant). This is the mutation-hardened surface.
- **Show-once-token and typed-confirm-delete flows** → **Playwright E2E**
  (`apps/dashboard/e2e/`, real Postgres + built dashboard + real API). This is the
  only layer that can prove "token shown once, gone on reload" and "delete requires
  the exact name" end-to-end.
- **Rendered admin components** carrying view logic (settings form, token panel,
  typed-confirm) → Vitest **browser-mode** `*.svelte.test.ts` (the A3b infra, plan
  046). Route render-test files must **not** carry the `+` prefix (SvelteKit's route
  scanner rejects `+`-prefixed non-reserved files).
- **`adminApi.ts`** (server-only, does I/O) is exercised through the E2E flows
  rather than a unit that mocks `fetch`.

---

## Scope boundaries (YAGNI)

**In:** project list; settings edit (all existing knobs incl. `webhookUrl` /
`webhookKind` / auto-quarantine); create; rotate token; prune (two-phase); delete
(typed-confirm); show-once token panel; one nav link.

**Out (deliberately):**
- The **rule engine (4b)** — its own spec/plan; 4a only establishes the config
  surface it will extend.
- Any change to the **API auth model** — roadmap #6 (SSO/roles) owns that.
- **Multi-user / roles** in the dashboard.
- A **`quarantine_events` audit-log viewer** — the table exists; a viewer is its own
  feature.
- **Bulk operations** across projects.
- A **single-project admin GET** endpoint — reuse the list payload until pagination
  forces it.

---

## Open questions

None blocking. The one soft call — reuse the list payload vs. add
`GET /admin/projects/:id` — is resolved in favor of reuse (YAGNI); revisit only if
the project list grows past what a single response should carry.
