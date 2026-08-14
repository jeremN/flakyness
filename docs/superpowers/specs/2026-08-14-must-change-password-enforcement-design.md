# Enforcing `mustChangePassword` — design

**Date:** 2026-08-14
**Status:** approved, awaiting implementation plan
**Scope:** `apps/api` only. Ships before plan 059 (Phase D) so the dashboard builds against a settled contract.

## Problem

`users.must_change_password` is set when a global admin provisions an account
(`routes/admin-users.ts:197`) or resets one (`:308`), cleared by
`POST /auth/change-password` (`routes/auth.ts:256`), carried on the session user
(`middleware/session.ts:20,58,105`) and returned by both `POST /auth/login` and
`GET /auth/me`.

**No code path reads it for an authorization decision.** It is stored, returned
and displayed, and enforces nothing — the exact shape `isGlobalAdmin` had before
plan 058, which that plan treated as a defect worth a dedicated fix.

Plan 058 deferred the decision ("does `resolveAccess` refuse such sessions?") and
merged without making it, so plan 059 would inherit the default: a dashboard
redirect, which is UX, not a boundary. A user who ignores the redirect and calls
the API directly keeps full authority on an unrotated, admin-known password.

## What is actually at risk

Established by inspection, not assumption:

- **Brute force is a non-threat.** `generateTempPassword()` is
  `randomBytes(18).toString('base64url')` (`services/auth/membership.ts:15`) —
  144 bits from a CSPRNG.
- **There is no attribution to forge.** `quarantine_events` records `event`,
  `source`, `rule_id` and timestamps, but **no actor column**
  (`db/schema.ts:153-170`). "An admin could impersonate a user and it would look
  like the user" is moot: nothing records who did anything.
- **The exposure is credential lifetime, and it is concentrated.**
  `canWriteProject` lets a `team_admin` mute tests, and its own comment states
  the consequence: *"a muted test feeds the CI skip-list"* (plan 031's P0
  confused deputy). An unrotated temp password belonging to a `team_admin` is a
  standing credential that can **disable tests in CI**, sitting in whatever
  Slack thread or inbox delivered it.

### What enforcement buys

Not protection against someone holding the temp password — they can simply
change it, since they hold the old one. It removes the **silent** path:

| | Unenforced | Enforced |
|---|---|---|
| Leaked temp password grants | full user authority, indefinitely | nothing but the password change |
| Legitimate user notices | never — their password still works | immediately — they are locked out |
| Compromise is | invisible | loud, and generates a support ticket |

Enforcement converts silent standing access into noisy account theft.

## Prior art

- **NIST SP 800-63B §6.1.1** — *"Temporary secrets SHALL NOT be reused"*;
  *"Long-term authenticator secrets SHALL only be issued to the applicant within
  a protected session."* Temporary secrets are enrollment verification tokens,
  not substitute long-term credentials. This does not conflict with Rev 4's
  stance against periodic rotation: that guidance still requires change when a
  secret is known-exposed, and an out-of-band temp password is exposed by
  definition.
- **Keycloak** enforces its `UPDATE_PASSWORD` required action at **token
  issuance** — the token endpoint returns `invalid_grant` until it completes.
  Its most-reported flaw is that the refusal is *opaque*: API clients get a bare
  `invalid_grant` with no indication of the remedy.
- **AWS IAM `PasswordResetRequired`** — the user must reset before performing
  other actions, with a minimal allowlist: `iam:ChangePassword` on their own
  user **plus** `iam:GetAccountPasswordPolicy`, i.e. what is needed to *complete*
  the remedy, not only the remedy itself.

Both reference implementations enforce server-side with a small allowlist.
Neither leaves it to the UI.

## Design

Defence in depth: **two enforcement points, one shared rule.** The redundancy is
deliberate (maintainer decision).

- *Drift is designed out* — both layers import the same `requiresPasswordChange`
  predicate; there is no second copy of the rule to fall out of sync. Only layer
  2 consults the allowlist (layer 1 exempts the auth routes structurally, by
  never being invoked on them), so the allowlist likewise has exactly one
  consumer and one definition.

- **The layers are independent in COVERAGE, not in INPUT.** An earlier draft of
  this spec claimed independent inputs. That was false and is corrected here:
  `resolveAccessValue` opens with `getSessionUser(c)`
  (`middleware/access.ts:51`) — the very function layer 2 would call — so both
  layers read one value, set once by `sessionAuth()` from one row
  (`middleware/session.ts:100-107`).

  What the two layers *do* cover independently: layer 2 catches a route that
  never consults the decision table; layer 1 catches a wrong allowlist entry or
  a router that failed to mount the gate. Different *forgetting* bugs.

  What they do **not** cover: a session-resolution bug. If `sessionAuth` stops
  populating the context, or a future edit drops `mustChangePassword` from the
  projection at `session.ts:105`, **both layers fail open together**.

  Buying real input independence would cost a second DB read on every
  authenticated request. Rejected as poor value. Instead the single point of
  failure is guarded **directly**: a test asserts `mustChangePassword` is present
  in the `SessionUser` projection, so the field cannot be silently dropped (see
  Testing #8). Guard the real failure, do not manufacture fake redundancy.

### Shared rule — `services/auth/access.ts`

```ts
/** Only a `user` can be mid-reset; tokens never carry the flag. */
export function requiresPasswordChange(access: Access): boolean;

/**
 * Routes reachable while a password change is pending. EXPLICIT PATHS, never a
 * `/api/v1/auth` prefix — plan 041's SELF_GATED carries the same warning: a
 * prefix silently exempts every future auth route. Adding one here must be a
 * deliberate, reviewed edit.
 */
export const PASSWORD_CHANGE_ALLOWLIST: readonly string[];
```

Allowlist contents — the AWS lesson, allow what completes the remedy:

| Path | Why |
|---|---|
| `POST /api/v1/auth/change-password` | the remedy itself |
| `GET /api/v1/auth/me` | the dashboard cannot render the change-password page without it |
| `POST /api/v1/auth/logout` | never trap a user in a session they cannot leave |
| `POST /api/v1/auth/login` | re-authenticating must not be blocked by a pending reset |

### Layer 1 — authorization (AWS shape)

`Access` gains `mustChangePassword: boolean`. `anonymousAccess()` sets it
`false`, and because every token-kind `Access` is built by spreading
`anonymousAccess()` (`middleware/access.ts:73-92`), `admin-token`, `read-token`
and `project-token` can never carry the flag.

`resolveAccessValue`'s user branch populates it from `sessionUser`.

`canReadProject`, `canWriteProject` and `canEnterAdminApi` each short-circuit on
`requiresPasswordChange(access)`.

`/api/v1/auth/*` never consults the decision table, so this layer exempts the
allowlist **structurally** — no path matching involved.

**Separate the two jobs: the predicates give the authorization *guarantee*, the
middleware emit the *contract*.** Conflating them is what produced the next two
defects, both found by reading the call sites rather than trusting the earlier
draft's summary of them:

- A `canReadProject === false` falls into plan 058's existence-hiding path and
  returns **404** (`middleware/access.ts:125,148,150`).
- An earlier draft claimed "writes and admin entry already 403, so only the read
  path needs this." **Both halves are wrong.** Writes: `PATCH /tests/flaky/:id`
  checks `canReadProject` *first* and 404s (`routes/tests.ts:411`), and
  `scopedAdminProject` returns `null` when **either** predicate fails
  (`routes/admin.ts:46`), which its callers render as 404. Admin entry: it does
  403, but as `HTTPException(403, 'Admin access required')`
  (`middleware/auth.ts:134`) — **no `code` field at all**, and a misleading
  message. So under layer 1 alone, all three surfaces violate the contract this
  spec calls non-negotiable.

**Fix: layer 2 alone emits the contract, on every surface.** An earlier draft
patched the contract into `resolveAccess()` *and* `adminOrGlobalAdminAuth()` —
two more edits to security-critical middleware. Unnecessary. Because
`passwordChangeGate()` is mounted `use('*')` on each router, and Hono runs
router-level middleware before both per-route middleware and any later
`use('*')`, the gate already precedes every one of these code paths:

| Surface | Gate runs before |
|---|---|
| reads | `resolveAccess()`, which is mounted **per route** (`routes/tests.ts:299,336`) |
| project writes | `tests.ts:411`'s read-first check, and `scopedAdminProject` (`admin.ts:46`) |
| admin API | `adminOrGlobalAdminAuth()` at `admin.ts:28`, `admin-users.ts:23`, `admin-teams.ts:19` |

So `resolveAccess`, `assertProjectReadable` and `adminOrGlobalAdminAuth` are
**not modified at all**. Smaller diff, one contract emitter, nothing to drift.

The predicate short-circuits stay regardless. They are the backstop for a router
that never mounts the gate, and a test asserts they refuse independent of what
any middleware emits.

**What layer 1 alone emits is deliberately NOT uniform** — corrected during
implementation, where the earlier draft's blanket "404 via existence-hiding" was
found to be true of only half the surfaces. Layer 1 sets no contract of its own;
it falls through to whatever each route already does on denial: 404 on reads and
project writes (plan 058's existence-hiding), but a code-less **403** on the
admin surface (`middleware/auth.ts:134` "Admin access required",
`routes/admin-teams.ts:30` "Global admin required"). Acceptable for a backstop,
since every branch still refuses — and precisely why the contract belongs to
layer 2 rather than being spread across three unrelated call sites.

**Implementation constraint discovered while planning:** the gate must
`return c.json(..., 403)` directly. It cannot `throw new HTTPException(403, ...)`
— the global error handler renders exceptions as `c.json({ error: err.message },
err.status)` (`index.ts:44-52`), which **drops any `code` field**. Throwing here
would silently produce exactly the opaque refusal the Keycloak lesson forbids.

### Layer 2 — choke point (Keycloak shape)

`passwordChangeGate()` middleware, reading `getSessionUser(c)`.

**Mount point: inside each router, immediately AFTER that router's rate
limiter** — NOT `app.use('*')` after `sessionAuth()`. A global mount ahead of
the routers runs before every per-router limiter, and because a denial returns
without calling `next()`, the limiter never counts the request. Measured
consequence: a must-change session can send unlimited requests to a
non-allowlisted path, each still paying the session DB lookup
(`middleware/session.ts:45,49`), and **none ever return 429** — reintroducing
precisely the unthrottled-cookie path that plan 056's rate-limiter ruling and
its regression test (`middleware/rate-limit.test.ts:341-361`) exist to prevent.
A short-circuit is not neutral: everything downstream stops running, including
the defences.

Mounts required — the complete set of `app.route('/api/v1/...')` calls at
`index.ts:143-152`: `reports`, `projects`, `tests`, `admin/users`,
`admin/teams`, `admin`, `auth`. Because this is now seven mounts rather than
one, a static coverage guard asserts every one carries it (Testing #6).

The guard is mechanically feasible — **verified, not assumed**: a router's
`use('*', mw)` registrations surface in `app.routes` as `ALL /api/v1/<mount>/*`
entries (probed against the live route table, 102 entries, all seven mounts
present). So the guard reuses the tagged-middleware pattern `readAuth` and
`resolveAccess` already use (`isReadAuth`, `isResolveAccess` in
`routes-auth-coverage.test.ts:62-77`): tag the gate, then assert the tagged
`ALL .../*` paths equal the expected seven.

`/health` and `/metrics` are registered before `sessionAuth()` (`index.ts:58,69,81`)
and return directly, so they are unaffected either way.

### Error contract

```
403 { "error": "Password change required", "code": "password_change_required" }
```

**403, not 404.** Deliberately unlike plan 058's cross-team reads: that 404
hides existence from a caller who should not know. Here the caller is
authenticated, known, and the state is actionable — hiding it would be wrong.
Concealment is not weakened: a nonexistent project and a forbidden one both
still 404 when the caller is *not* mid-reset.

**The `code` field is non-negotiable.** It is the direct lesson from Keycloak's
opaque `invalid_grant`: the dashboard keys its redirect off `code`, never off
message text.

### Mixed credentials — a narrowed claim

`resolveAccessValue` checks the session **before** the bearer
(`middleware/access.ts:51-70`), a deliberate plan-058 decision this spec does
not reverse. Consequence: a request carrying **both** a must-change session
cookie **and** a valid `ADMIN_TOKEN`/project token classifies as `kind: 'user'`
and is refused.

So the accurate claim is: **machine credentials presenting no session cookie are
unaffected.** CI ingest sends a bearer only and is unaffected. The dashboard is
the case to watch — it holds `ADMIN_TOKEN` server-side today (plan 053) and
gains a session cookie in plan 059; a server-side call that forwards a
must-change cookie alongside the token will be refused, which is correct but
must not surprise 059.

`ADMIN_TOKEN`-only break-glass is verified intact: no cookie ⇒ `sessionAuth`
continues anonymously (`session.ts:43,45`) ⇒ the gate continues ⇒
`resolveAccessValue` classifies `admin-token` with global-admin standing
(`access.ts:90,103`).

## Testing

Each layer must be **proven to bite alone**. Redundancy otherwise masks
breakage: if layer 2 always fires first, layer 1 could be entirely broken and
every test would still pass.

1. **Layer 1 in isolation** — pure unit tests on the three predicates plus
   `requiresPasswordChange`, every assertion mutation-provable. `access.ts` is
   already in the Stryker gate at floor 90.
2. **Layer 2 in isolation** — middleware tests over the allowlist and a
   non-allowlisted path.
3. **Each layer with the other disabled** — one HTTP test per layer, so neither
   can hide behind the other. The procedure is recorded in the plan so a future
   reader can re-run it.
4. **The lockout test — the most important test in this feature.** With the flag
   set, every allowlisted route must still work. Getting this wrong bricks every
   account with no recovery short of hand-written SQL.
5. **Contract uniformity across all three surfaces** — table-driven: one read,
   one write, one admin-API request, each asserted to return exactly `403` with
   `code: 'password_change_required'`. This is the regression test for the defect
   above; it fails on today's code three different ways (404, 404, and a
   `code`-less 403), which is what makes it worth writing.
6. **Coverage guards, two of them** — (a) `PASSWORD_CHANGE_ALLOWLIST` matches the
   auth router's real route table, so a new `/api/v1/auth/*` route forces a
   deliberate decision; (b) every `/api/v1` router mounts
   `passwordChangeGate()`, since it is now N mounts rather than one global one.
   Both mirror `EXPECTED_READ_ROUTE_COUNT` in `routes-auth-coverage.test.ts`.
   Note the plan-058 lesson: a source-text scan must tolerate Stryker
   instrumentation (`stryMutAct_`), and any `it.each` guard needs its own
   anti-vacuity assertion — `it.each([])` runs zero assertions and passes.
7. **Machine credentials with no session cookie unchanged** —
   `POST /api/v1/reports` with a project token, and `ADMIN_TOKEN`/`READ_TOKEN`
   routes, behave exactly as before. Plus the mixed-credential case asserted
   explicitly: cookie + bearer together is refused, and that is intended.
8. **The `SessionUser` projection guard** — assert `mustChangePassword` is
   present on the object `sessionAuth()` sets (`session.ts:100-107`). This is the
   single point of failure both layers share; dropping the field would fail both
   open at once, and nothing else would notice.
9. **Rate limiting still applies to a refused caller** — a must-change session
   hammering a non-allowlisted path must still receive `429`. This is the
   regression test for the mount-order defect above, and it fails against the
   naive global mount.

## Out of scope

- Session invalidation. **Already solved, verified, no work needed here** — an
  earlier draft listed this as an open question, which was wrong.
  `POST /auth/change-password` revokes every session and re-issues one for the
  caller in the same response (`routes/auth.ts:255-260`), and
  `POST /admin/users/:id/reset-password` revokes every session too
  (`routes/admin-users.ts:311`). So there is no re-login trap on the remedy path,
  and no stale session survives a reset.
- **The reset-delivery atomicity hole — pre-existing, unfixed, deliberately not
  fixed here.** `reset-password` writes the new hash, revokes the sessions, and
  then hands the temp password to the admin *only in the HTTP response body*
  (`routes/admin-users.ts:306-317`). Lose that response — dropped connection,
  proxy timeout, closed tab — and the password is unrecoverable: nobody has it.
  Normally another global admin resets again. But a **sole** global admin
  resetting their own account locks the whole install out, and the
  `GLOBAL_ADMIN_MUTEX` last-admin guard does not cover this route (it guards
  demote at `:244,268` and delete at `:346,358` only). Out of scope because it is
  orthogonal to enforcement and predates it — but enforcement makes the blast
  radius larger, so it gets a follow-up in `plans/README.md`, not silence.
- Password strength/expiry policy. NIST Rev 4 argues against periodic rotation;
  nothing here introduces it.
- Dashboard behaviour — plan 059 owns the redirect and consumes `code`.
- Any change to `POST /api/v1/reports` or token semantics.

## Definition of done

- A `user` session with `mustChangePassword` gets `403 password_change_required`
  on reads, writes and the admin API — the same status **and the same `code`** on
  all three, not merely "refused" on all three.
- All four allowlisted auth routes work with the flag set.
- Machine credentials byte-identical in behaviour; existing suites green
  untouched.
- Both layers independently proven to bite.
- `docs/API.md` documents the 403 and its `code`.
- Mutation gate holds, `access.ts` above floor 90.
