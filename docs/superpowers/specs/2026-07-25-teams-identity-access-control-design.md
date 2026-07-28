# Teams, Identity & Per-Team Access Control — design

**Date:** 2026-07-25
**Roadmap:** #5 (multi-tenant) combined with #6 (SSO/accounts/roles), re-scoped
**Status:** approved, ready for implementation plan

## Context

Flackyness is single-tenant to its core. `projects` is simultaneously the
tenant boundary, the API-credential holder (`projects.token_hash`), and the
scoping key; there is **no notion of org, tenant, user, or account anywhere**
(`db/schema.ts` — six tables, all keyed off `projects`). All authentication is
via **global static env secrets** (`ADMIN_TOKEN`, optional `READ_TOKEN`,
`METRICS_TOKEN`) plus per-project bearer tokens, and the dashboard is gated by
a single global `DASHBOARD_PASSWORD` (HTTP Basic Auth in `hooks.server.ts`).
Query scoping is enforced by ~15 hand-written `eq(*.project_id, …)` predicates
spread across the route handlers — there is no central guard.

`STRATEGY.md` lists multi-tenant (#5) and SSO/accounts/roles (#6) as separate
roadmap items. Brainstorming re-scoped them: the concrete need is **one
organization that wants to group its projects under teams and restrict which
team's projects a person can see.** That is not hard cross-tenant isolation
(the "agency hosts competing clients" case was explicitly ruled out) and it is
not a lightweight visual grouping either — it is **real per-team access
control**, which is impossible without knowing *who the viewer is*. Since no
account system exists, identity is a hard prerequisite. Rather than build a
throwaway per-team password and rip it out later, the decision is to design
**identity + teams + access control as one combined system.**

## Goal

Let a single organization run one Flackyness deployment where:

- People sign in with **individual accounts** (email + password).
- Projects are grouped under **teams**; a person is a member of one or more
  teams.
- A signed-in **member sees only their teams' projects** — in the dashboard
  and through the API — while a **global admin** (the operator) sees and
  manages everything.

All enforcement lives **in the API**, which stays the real security boundary;
the dashboard is a client, never the enforcement point.

## Scope boundaries (YAGNI)

**In scope:**

- Local accounts (email + password), sessions, login/logout/me.
- Teams, team membership (many-to-many, with a per-membership role), team CRUD.
- `projects.team_id` and a **central access-scope guard** applied to every
  read route + role checks on mutations.
- Dashboard login flow, team-scoped views, team/user management console.
- Migration that assigns all existing projects to an auto-created **Default**
  team so nothing disappears on upgrade.

**Deliberately out of scope** (named, not built speculatively):

- **External SSO / OIDC / SAML.** The account layer is designed *OIDC-ready*
  (identity is an API concern, sessions are provider-agnostic) but no external
  IdP is wired here. That is the remaining slice of #6, a clean fast-follow at
  the same seam.
- **Hard cross-tenant isolation** (schema-per-tenant, DB-per-tenant). This is
  one trusted org; a shared schema with a `team_id` scope key is sufficient.
- **The Redis / shared rate-limit store.** `STRATEGY.md` bundled it into #5,
  but it exists only to allow >1 API replica for *multi-client agency hosting*,
  which is ruled out. A single-org single-deployment install does not need
  horizontal scaling to add teams. The in-memory limiter stays.
- **Open self-signup, email-based invites, password-reset-by-email.** No SMTP
  is in the stack. Users are admin-provisioned with a show-once temporary
  password; first login forces a reset.
- **Per-user audit log / activity trail.** The existing `quarantine_events`
  audit is unchanged; a user-action audit is a later item.

## Architecture — API-owned identity (chosen approach)

Users, teams, memberships, roles, and sessions live in Postgres, owned by the
Hono API. The API gains auth endpoints and a central authorization middleware;
the dashboard becomes a client that logs in against the API and carries a
session cookie. Machine callers (per-project ingest tokens, `ADMIN_TOKEN`,
`READ_TOKEN`) continue to authenticate as they do today, resolving to their
existing (narrower or global-machine) scope.

Two alternatives were rejected:

- **Dashboard-owned identity** (SvelteKit holds users/sessions and filters
  results before rendering) — fastest, but leaves the API globally open behind
  the static tokens, so direct API access or a leaked `READ_TOKEN` bypasses
  teams entirely. Wrong boundary for a security-sovereignty product.
- **Split with minted scoped tokens** (API owns data + authz, dashboard mints
  per-request tokens) — Approach 1 plus a token-exchange layer; more moving
  parts for no gain at single-org scale.

## Data model (migration `0011`)

Four new tables plus one column on `projects`.

```
users
  id              uuid PK
  email           varchar(255) UNIQUE NOT NULL      -- login identity
  password_hash   varchar(256) NOT NULL             -- scrypt, see "Authentication"
  display_name    varchar(255)
  is_global_admin boolean NOT NULL default false    -- operator; bypasses team scoping
  must_change_pw  boolean NOT NULL default false    -- set on admin-provisioned temp passwords
  created_at      timestamptz NOT NULL default now()
  last_login_at   timestamptz

teams
  id         uuid PK
  name       varchar(255) UNIQUE NOT NULL
  created_at timestamptz NOT NULL default now()

team_members                                        -- user <-> team (many-to-many)
  user_id uuid NOT NULL -> users.id  ON DELETE cascade
  team_id uuid NOT NULL -> teams.id  ON DELETE cascade
  role    varchar(16) NOT NULL                       -- 'team_admin' | 'member'
  UNIQUE(user_id, team_id)

sessions
  id           uuid PK
  user_id      uuid NOT NULL -> users.id ON DELETE cascade
  token_hash   varchar(64) NOT NULL                  -- SHA-256 of the cookie token (raw never stored)
  created_at   timestamptz NOT NULL default now()
  expires_at   timestamptz NOT NULL
  last_seen_at timestamptz NOT NULL default now()
  INDEX(token_hash)

projects
  + team_id uuid -> teams.id ON DELETE SET NULL       -- nullable; orphans on team delete, never wipes
```

**`projects.team_id` uses `ON DELETE SET NULL`, deliberately breaking the
"projects child tables cascade" convention.** A team is an *organizational*
parent, not an ownership parent — deleting a team must never delete project
data. Orphaned (`team_id IS NULL`) projects are visible only to global admins
until reassigned. Every genuinely-owned new table (`team_members`, `sessions`)
still cascades from its owner.

Decimal/string and logging conventions from `AGENTS.md` continue to apply to
any numeric columns; there are none new here.

## Authentication & sessions

- **Endpoints:**
  - `POST /api/v1/auth/login` — `{ email, password }` → verify → create a
    session row → `Set-Cookie: fk_session=<token>; HttpOnly; Secure;
    SameSite=Lax; Path=/`. On a `must_change_pw` account, the response signals
    a forced reset.
  - `POST /api/v1/auth/logout` — deletes the current session row, clears cookie.
  - `GET /api/v1/auth/me` — returns the current user, their teams, and
    per-team roles (the dashboard's source of truth for scoping the UI).
  - `POST /api/v1/auth/change-password` — for the forced first-login reset and
    voluntary changes (verifies the old password, clears `must_change_pw`).
- **Password hashing: Node's built-in `crypto.scrypt`, not argon2.** Both are
  memory-hard and adequate; scrypt is chosen because it ships in Node core and
  therefore cannot be a blocked native build (`pnpm-workspace.yaml`
  `allowBuilds` allowlist) or a `minimumReleaseAge` snag. Store
  `scrypt(password, salt)` with a per-user random salt, encoded with the
  parameters, compared via `timingSafeEqual`.
- **Session tokens:** 256-bit random, delivered raw in the cookie, stored only
  as a SHA-256 `token_hash` (identical pattern to `projects.token_hash`).
  Sliding TTL (7 days, refreshed via `last_seen_at` on use); revocable by row
  deletion. Expired/absent/invalid session → treated as anonymous.
- **CSRF:** state-changing calls are same-origin from the dashboard's server;
  `SameSite=Lax` plus the existing `ORIGIN`/adapter-node CSRF configuration
  (fixed in plan 053) cover the login/logout/mutation POSTs. No new CSRF
  surface beyond what plan 053 already hardened.

## Authorization — the central seam

- **`resolveAccess(c)` middleware** runs ahead of read/mutation handlers and
  resolves the caller into a context value:
  `{ kind: 'user'|'project-token'|'admin-token'|'read-token'|'anonymous',
     isGlobalAdmin, teamIds[], roleByTeam }`. For a user it reads the session
  cookie → session → memberships. For machine tokens it maps to today's scope
  (a project token → that one project; `READ_TOKEN` → global machine read;
  `ADMIN_TOKEN` → global admin). Global admin bypasses all team filtering.
- **Read routes** replace the bare `eq(project.project_id, X)` with a scope
  assertion: a requested `projectId` must belong to a team in `teamIds` (or the
  caller is global admin), else **`404`** — existence-hiding, consistent with
  the existing confused-deputy-safe join pattern (`projects.ts:300`). List
  routes (`GET /projects`, `GET /admin/projects`) filter to `teamIds`.
- **Role checks on mutations:** `member` = read-only within their teams;
  `team_admin` = manage *their* team's projects (config, rules, token rotate);
  `global_admin` = everything, plus team CRUD and user CRUD. `ADMIN_TOKEN`
  remains a break-glass global-admin machine credential.
- **Coverage guard:** `routes-auth-coverage.test.ts` (which already fails CI if
  a new `GET` under `/api/v1` lacks `readAuth`) is extended so a read route
  that does not pass through `resolveAccess` fails CI. This turns "every author
  must remember the scope predicate" into "the middleware guarantees it."

## API surface

| New | Changed |
|---|---|
| `POST /api/v1/auth/login`, `/logout`, `/change-password`; `GET /api/v1/auth/me` | Every `GET` read route: team-scoped via `resolveAccess` |
| `GET/POST/PATCH/DELETE /api/v1/admin/teams` + membership sub-routes (add/remove/set-role) | `GET /projects`, `GET /admin/projects`: filtered to caller's teams |
| `GET/POST/PATCH/DELETE /api/v1/admin/users` (global admin only; create returns a show-once temp password) | `POST /admin/projects` (create) accepts an optional `teamId`; project settings PATCH accepts `teamId` |
| — | `routes-auth-coverage.test.ts` guard extended for the new auth/scope mounts (route-count bump is deliberate) |

`docs/API.md` is updated for every new/changed endpoint, per the API
conventions in `AGENTS.md`.

## Dashboard

- **Replaces the global `DASHBOARD_PASSWORD` Basic Auth** with a real `/login`
  page hitting `POST /auth/login`. `hooks.server.ts` validates the session via
  `/auth/me`, populates `locals.user`, and redirects unauthenticated traffic to
  `/login`. `DASHBOARD_PASSWORD` is **removed** — the account system supersedes
  it; global-admin bootstrap (below) covers first access.
- **Team-scoped views:** project lists and dashboards render only the user's
  teams' projects (the API already filters; the UI reflects it). A **team
  switcher/filter** appears for multi-team users. A forced
  change-password screen gates a `must_change_pw` account on first login.
- **Admin console** (global admin only) gains **team management** (CRUD,
  assign projects, manage membership + roles) and **user management** (create
  user → show-once temp password, deactivate, reset password), reusing plan
  053's server-only `$lib/server/adminApi.ts` + SvelteKit form-action pattern
  so no token reaches the browser.

## Migration & backward-compatibility

- `0011` creates `users`, `teams`, `team_members`, `sessions`; adds
  `projects.team_id`; creates a **"Default" team**; assigns **all existing
  projects** to it. Nothing becomes invisible on upgrade.
- **First global-admin user** is created *after* migration via an
  `ADMIN_TOKEN`-authenticated `POST /api/v1/admin/users` call (documented in
  the upgrade guide) — no magic DB seeding, no plaintext secret in a migration.
- **Machine auth is untouched:** per-project ingest tokens keep working;
  `ADMIN_TOKEN` still authorizes the admin API; **`READ_TOKEN` is kept
  unchanged** as an optional global machine-read escape hatch alongside user
  sessions.
- **`DASHBOARD_PASSWORD` is retired**; the upgrade guide states that operators
  must create their admin user and sign in instead. This is the one
  intentional breaking change, called out in `GETTING_STARTED`/`AGENTS.md`.

## Testing strategy

- **Unit (node, mutation-gate candidates):** scrypt hash/verify (incl. wrong
  password, tampered hash), session create/validate/expire/slide, and the
  **`resolveAccess` scope resolution** (membership → allowed projects; global
  admin bypass; each token kind) and role gates. These pure functions join the
  hardened set in `scripts/mutation-gate.mjs`.
- **Route tests (real Postgres):** login/logout/me/change-password; team &
  user CRUD; the **scoped-read matrix** — a member sees only their team's
  projects, a cross-team `projectId` returns `404`, a global admin sees all;
  role-forbidden mutations `403`. `routes-auth-coverage.test.ts` updated.
- **Dashboard:** login-flow + forced-reset render/E2E; team-scoped list render
  tests (Vitest browser mode); the show-once temp-password lifecycle as a
  Playwright E2E (mirrors plan 053's show-once-token E2E).
- **Backward-compat:** a test proving an existing project (assigned to Default)
  and existing machine tokens keep working after `0011`.

## Phasing (input to `writing-plans`)

Designed as four independently reviewable phases; A–C are API-only, D is
dashboard-only. Each ends with a shippable, tested increment.

- **Phase A — Identity core.** `users` + `sessions` tables, scrypt hashing,
  `POST /auth/login|logout|change-password`, `GET /auth/me`, session
  middleware. No teams yet; no scoping change.
- **Phase B — Teams & membership.** `teams` + `team_members` + `projects.team_id`,
  migration `0011` with the Default-team backfill, admin team/membership CRUD,
  `POST /admin/users`. Still no read-scoping change (global admin token drives
  it).
- **Phase C — Authorization enforcement.** `resolveAccess` guard across every
  read route, role checks on mutations, `GET /projects` + `GET /admin/projects`
  filtering, coverage-guard extension. This is the phase that actually turns on
  per-team access control.
- **Phase D — Dashboard.** `/login`, session in `hooks.server.ts`, forced
  first-login reset, team-scoped views + switcher, team/user admin console,
  retire `DASHBOARD_PASSWORD`.

Whether these become one plan with four phases or four plans is a
`writing-plans` decision; each phase boundary is a natural plan boundary.

## Locked decisions (from brainstorming)

1. **Scenario:** one org, many teams — not agency multi-client, not visual
   grouping only.
2. **Access control is real** and enforced in the **API** (Approach 1).
3. **Identity is a prerequisite**, so identity + teams + access control ship as
   **one combined spec** (staged A–D).
4. **Local accounts now, OIDC-ready but deferred** (external IdP = fast-follow).
5. **scrypt** (Node core) for password hashing; **cookie server sessions**
   (not JWT).
6. **Cardinality:** a project belongs to **one** team; a user belongs to
   **many** teams.
7. **Roles:** global `admin`, `team_admin`, `member`.
8. **User provisioning:** admin-created, **show-once temp password**,
   `must_change_pw` forces first-login reset. **No open self-signup.**
9. **`DASHBOARD_PASSWORD` removed**; **`READ_TOKEN` kept**; machine ingest
   tokens and `ADMIN_TOKEN` unchanged.
10. **Out of scope:** Redis/shared rate-limit store, external OIDC, email
    invites/resets, per-user audit trail.
