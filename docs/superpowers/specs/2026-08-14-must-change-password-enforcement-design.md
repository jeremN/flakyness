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

Defence in depth: **two enforcement points, one shared rule, two independent
inputs.** The redundancy is deliberate (maintainer decision). The two failure
modes of redundancy are designed out rather than accepted:

- *Drift* — both layers import the same `requiresPasswordChange` predicate;
  there is no second copy of the rule to fall out of sync. Only layer 2 consults
  the allowlist (layer 1 exempts the auth routes structurally, by never being
  invoked on them), so the allowlist likewise has exactly one consumer and one
  definition.
- *Illusory redundancy* — the layers read the fact through **different** code
  paths, so a bug in either resolver is still caught by the other. Two checks of
  one resolver would fail together and buy nothing.

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
`anonymousAccess()` (`middleware/access.ts:73-92`), **machine credentials are
covered in one place by construction** — `admin-token`, `read-token` and
`project-token` can never carry the flag.

`resolveAccessValue`'s user branch populates it from `sessionUser`.

`canReadProject`, `canWriteProject` and `canEnterAdminApi` each short-circuit on
`requiresPasswordChange(access)`.

`/api/v1/auth/*` never consults the decision table, so this layer exempts the
allowlist **structurally** — no path matching involved.

### Layer 2 — choke point (Keycloak shape)

`passwordChangeGate()` middleware, mounted `app.use('*', …)` immediately after
`sessionAuth()` (`index.ts:98`) and before the route mounts (`:143-152`).
`/health` and `/metrics` are registered *before* line 98 and terminate without
calling `next()`, so they are unaffected — the same property plan 058 verified
empirically for `sessionAuth` (ruling F5).

It reads `getSessionUser(c)` **directly** rather than `getAccess(c)` — that is
what makes the two inputs independent.

### Error contract

```
403 { "error": "Password change required", "code": "password_change_required" }
```

**403, not 404.** Deliberately unlike plan 058's cross-team reads: that 404
hides existence from a caller who should not know. Here the caller is
authenticated, known, and the state is actionable — hiding it would be wrong.

**The `code` field is non-negotiable.** It is the direct lesson from Keycloak's
opaque `invalid_grant`: the dashboard keys its redirect off `code`, never off
message text.

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
5. **Allowlist coverage guard** — a static test asserting
   `PASSWORD_CHANGE_ALLOWLIST` matches the auth router's real route table, so a
   new `/api/v1/auth/*` route forces a deliberate decision. Mirrors
   `EXPECTED_READ_ROUTE_COUNT` in `routes-auth-coverage.test.ts`.
6. **Machine credentials unchanged** — `POST /api/v1/reports` with a project
   token, and `ADMIN_TOKEN`/`READ_TOKEN` routes, all behave exactly as before.

## Out of scope

- Session invalidation on password change (other live sessions surviving a reset
  is a real question, but a separate one).
- Password strength/expiry policy. NIST Rev 4 argues against periodic rotation;
  nothing here introduces it.
- Dashboard behaviour — plan 059 owns the redirect and consumes `code`.
- Any change to `POST /api/v1/reports` or token semantics.

## Definition of done

- A `user` session with `mustChangePassword` gets `403 password_change_required`
  on reads, writes and the admin API.
- All four allowlisted auth routes work with the flag set.
- Machine credentials byte-identical in behaviour; existing suites green
  untouched.
- Both layers independently proven to bite.
- `docs/API.md` documents the 403 and its `code`.
- Mutation gate holds, `access.ts` above floor 90.
