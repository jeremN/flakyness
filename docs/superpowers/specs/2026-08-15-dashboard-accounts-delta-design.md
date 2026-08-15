# Plan 059 delta — what plan 058b changed underneath it

**Status:** approved 2026-08-15. Amends, does not replace,
`docs/superpowers/specs/2026-07-25-teams-identity-access-control-design.md`
(§Dashboard / Phase D) and the implementation plan at
`plans/059-dashboard-accounts-and-teams.md`.

## Why this exists

`plans/059-dashboard-accounts-and-teams.md` is a complete, task-by-task
implementation plan, but it was last edited in plan 058's merge (`3d09576`) and
therefore predates plan 058b (`mustChangePassword` enforcement, PR #133,
`e689af0`). Four of its assumptions moved. Three are small; one makes the login
page unusable for any team larger than ten people and is the reason this
document exists.

Everything not listed here stands as written in plan 059.

---

## D1 — Login throttling collapses to a whole-install ceiling

### The defect

Plan 059 makes the dashboard a **confidential client**: the browser POSTs to the
dashboard's SvelteKit form action, and the dashboard *server* calls
`POST /api/v1/auth/login`. The API therefore sees every login in the
installation arriving from one socket — the dashboard container.

`authRateLimit` is `{ windowMs: 60_000, limit: 10 }` keyed on `getClientIp`
(`apps/api/src/middleware/rate-limit.ts:30,110`), with a comment that explicitly
rejects any exemption:

> Plain per-IP throttling with no bearer exemption — unlike adminRateLimit, a
> login request never carries a valid credential to exempt (that's the whole
> point of the request), so every attempt counts against the bucket.

That reasoning is correct for browser→API traffic and wrong once the dashboard
mediates. The result is **ten logins per minute for the entire installation**,
shared across all users. `/auth/change-password` sits behind the same limiter,
so the ceiling also binds during onboarding — precisely when every user rotates
a temporary password at once.

This is plan 055's bug on a different limiter. That plan already fixed the same
shape once, recorded in its own `plans/README.md` row: *"fixing the per-IP
`5/60s` limit that made a server-mediated admin console — whose calls all share
one IP — unusable."*

It fails at a threshold rather than immediately, which is what makes it
dangerous: the install works through development and small-team testing, then
breaks on the eleventh concurrent sign-in.

### It is broader than login

Found while self-reviewing this spec, by checking which routes each limiter
actually covers instead of assuming. `authRateLimit` is mounted on `/login` and
`/change-password` only (`routes/auth.ts:48-49`); **`apiRateLimit` covers
everything else** (`:47`, plus the `projects` and `tests` routers) and is keyed
per-IP by the same `getClientIp`, at `{ windowMs: 60_000, limit: 100 }`.

Once the dashboard mediates, that bucket is shared too. A single page view costs
several API calls (the layout's `getProjects`, then the page's stats, flaky
list, and trend calls), and `fetchMe` runs in `hooks.server.ts` on *every*
request. At roughly five calls per view, 100/min is on the order of twenty page
views per minute **for the whole installation** — so ordinary browsing degrades,
not merely sign-in.

Two limiters are exposed, and only these two:

| Limiter | Limit | Dashboard traffic | Exposed? |
|---|---|---|---|
| `authRateLimit` | 10/min | `/login`, `/change-password` | **yes** |
| `apiRateLimit` | 100/min | every read route + `/me`, `/logout` | **yes** |
| `adminRateLimit` | 5/min | admin console | no — `hasAdminStanding` exempts any signed-in session |
| `reportRateLimit` | 60/min | none (CI ingest) | no |

This is why D1.2 puts the forwarding in the shared fetch layer rather than on
the three auth calls: the problem is every dashboard→API request, not just the
ones that sign a user in.

### The chosen fix

Forward the real client IP and make the API able to trust it — four pieces,
each closing one distinct failure mode.

**D1.1 — Normalize IPv4-mapped addresses in `getClientIp`.**

`getClientIp` gates on `trustedProxies.includes(socketIp)`, an exact string
match. **Measured 2026-08-15**, not assumed: Node reports an IPv4 connection on
a **dual-stack** listener as `::ffff:127.0.0.1`, not `127.0.0.1` — but a
listener bound to an explicit IPv4 host reports the **bare** form.

**This is forward-compatible hardening, not a bug fix.** Corrected 2026-08-15
after an earlier draft of this section claimed the exact-match comparison was
"silently failing in every real deployment": it was not. This app sets
`API_HOST='0.0.0.0'` in both the code default (`apps/api/src/index.ts`) and
`docker-compose.yml`, so no documented deployment ever presents the `::ffff:`
form and the pre-existing code already worked.

What the normalization buys is the case where `API_HOST` is unset (Node's
no-host dual-stack default) or set to `::`. There an operator who sets
`TRUSTED_PROXY_IPS=172.20.0.5` never matches a socket reporting
`::ffff:172.20.0.5`, the trust check silently fails, and the shared bucket
returns with no error anywhere. Today it is harmless; then it is load-bearing.

The existing tests (`rate-limit.test.ts:37-60`) use synthetic addresses like
`1.2.3.4` and never exercise the IPv4-mapped form, so they pass either way —
which is why the gap was invisible, not why it was breaking anything.

Strip a leading `::ffff:` from the socket address before comparison, and compare
normalized-to-normalized so a configured value in either form matches. New tests
MUST use the `::ffff:` form; a test written with a bare IPv4 address proves
nothing here.

**D1.2 — The dashboard forwards the browser's IP on every API call.**

The dashboard sends `X-Forwarded-For`, derived from SvelteKit's
`event.getClientAddress()`, on **all** server→API requests — not just the auth
ones, per the table above.

Put it in the shared fetch layer: `createApi`, `createAdminApi` (plan 059
Task 2) and `fetchMe` (Task 2, Step 5). Those factories already take the
caller's session token; they take the caller's IP the same way and for the same
reason. Threading it through individual call sites instead would leave the
forwarding optional, which is the failure class plan 059's factory conversion
exists to eliminate — an omitted call site keeps compiling and quietly shares
the bucket.

Note for deployments where the dashboard is itself behind a reverse proxy:
`@sveltejs/adapter-node` derives `getClientAddress()` from `ADDRESS_HEADER` /
`XFF_DEPTH`. Those are the operator's existing knobs and this design does not
change them; it only documents that they feed this path.

**D1.3 — Pin the dashboard's address; do not trust a range.**

`docker-compose.yml` assigns the dashboard a static IPv4 on the app network and
sets the API's `TRUSTED_PROXY_IPS` to exactly that address.

Deliberately **not** the bridge CIDR. With published ports, Docker's userland
proxy can present external traffic as a bridge address, so trusting the range
would let an outside client spoof `X-Forwarded-For` and evade the login
throttle entirely. Trust exactly one address, and let it be one the operator
controls.

**D1.4 — Warn once at boot when the trust is unconfigured.**

When `TRUSTED_PROXY_IPS` is unset, the API logs a single startup warning naming
the consequence: `X-Forwarded-For` is ignored, so a server-mediated dashboard
shares one login bucket for all users.

This is the piece that stops D1 failing silently open. It mirrors the existing
boot-warning pattern (`apps/dashboard/src/hooks.server.ts:20`, which warns when
`ADMIN_TOKEN` is set without `DASHBOARD_PASSWORD`) — logged once at startup, not
per request.

### Rejected alternatives

- **Raise `AUTH_RATE_LIMIT`.** One-line change, but it weakens brute-force
  protection for direct API callers and only moves the ceiling — it returns as
  the team grows.
- **Key the login limiter by submitted email.** Immune to the shared-IP problem
  and aimed at the real threat, but it lets one source spray many accounts, and
  the key would come from the request body.
- **Give the dashboard a rate-limit-exemption credential.** Re-introduces the
  ambient authority plan 059 exists to remove, for a narrower benefit.

### Testing

- Unit: a spoofed `X-Forwarded-For` from an **untrusted** socket is ignored.
- Unit: an `X-Forwarded-For` from a **trusted** socket is honored.
- Unit: `::ffff:`-prefixed socket addresses match a configured bare IPv4 value,
  and vice versa.
- Unit: the boot warning fires when `TRUSTED_PROXY_IPS` is unset and does not
  fire when it is set.
- Unit (dashboard): each of `createApi`, `createAdminApi` and `fetchMe` sends
  `X-Forwarded-For` with the address it was given, and omits the header rather
  than sending an empty one when it has no address.
- Regression: two requests carrying **different** trusted-proxy-forwarded IPs
  occupy **separate** buckets. This is the assertion that actually proves the
  fix; one that only checks a single request still passes against the shared
  bucket this delta exists to eliminate.

---

## D2 — A mid-reset user sees "Cannot reach the API" on the recovery page

Plan 059's root `+layout.server.ts` (Task 6, Step 1) calls `api.getProjects()`
on every route and converts any failure into
`apiError = 'Cannot reach the Flackyness API. Showing an empty dashboard.'`

The root layout load runs for `/change-password` too. Under 058b a mid-reset
session receives `403 {error, code:'password_change_required'}` from every
non-allowlisted route, including `GET /api/v1/projects`. The user is therefore
told the API is unreachable, on the one page they must use to recover, while the
API is healthy and answering correctly.

**Fix:** skip the projects fetch entirely when
`locals.user?.mustChangePassword` — there is nothing to show a user who cannot
read projects yet — and, where an API error is surfaced, branch on the `code`
field rather than the message string. `code` is the machine-readable contract
058b introduced precisely so clients need not parse prose.

**Testing:** a load test asserting that a mid-reset user's layout load performs
no projects fetch and surfaces no `apiError`.

---

## D3 — Pin the two halves of one contract

Plan 059's `redirectTargetFor` keeps `ESCAPE_HATCHES = ['/change-password',
'/logout']` — the dashboard routes a mid-reset user may reach. 058b's
`PASSWORD_CHANGE_ALLOWLIST` holds the API requests such a user may make:
`POST /auth/change-password`, `GET`+`HEAD /auth/me`, `POST /auth/logout`,
`POST /auth/login`.

These are two halves of one contract. If the dashboard redirects a user to a
page whose load calls an API route the gate refuses, the user is trapped in a
loop with no way out. They agree today — `/change-password` → `POST
/auth/change-password`, `/logout` → `POST /auth/logout`, and the session gate's
`fetchMe` → `GET /auth/me`, all allowlisted. 058b's allowlist comment already
records that `/auth/me` is allowlisted *specifically* so the change-password
page can render.

Agreement by coincidence is not a guarantee. Add a test asserting that every API
call reachable from a dashboard escape-hatch route is on the API allowlist, so
that removing an allowlist entry or adding an escape hatch fails loudly rather
than producing a lockout in production.

---

## D4 — Form validation errors degrade to a generic message

Follow-up #25 (`plans/README.md`): all 14 `zValidator` call sites are mounted
without a custom hook, so a schema-validation `400` returns the library's own
shape, in which `error` is an **object**, not a string. The console's error
mapping (plan 059 Task 2, and plan 053's existing `adminApi.ts`) checks
`typeof errBody.error === 'string'` and otherwise falls back to
`API request failed (400)`.

Consequence: a console form that fails schema validation shows a generic message
instead of the actual problem. It degrades safely — no crash, no wrong data —
so this plan does **not** fix it; that is follow-up #25's job, and doing it here
would mean changing the error contract of 14 API routes mid-feature.

Recorded so the behavior is understood rather than rediscovered as a bug during
console testing.

---

## Scope

**In:** D1 (all four pieces), D2, D3. D4 is documentation only.

**Unchanged:** every other task, constraint, file, and Definition-of-done item
in `plans/059-dashboard-accounts-and-teams.md`, including the breaking removal
of `DASHBOARD_PASSWORD` and the requirement that `ADMIN_TOKEN` leave the
dashboard entirely.

**Out:** fixing follow-up #25; external SSO/OIDC; self-signup or
password-reset-by-email; per-user audit trail; team-scoped notification routing
(all already listed as non-goals in plan 059).

## Plan impact

D1 becomes a new **Task 0** in `plans/059-dashboard-accounts-and-teams.md`: it
is API-side, it is a prerequisite for the login page being usable, and it is
independently testable. D2 amends Task 6 Step 1. D3 adds an assertion to Task 3.
D4 adds a note to Task 7.
