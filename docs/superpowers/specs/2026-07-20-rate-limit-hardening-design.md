# Rate-limit testability + admin brute-force fix (A2a) — design

**Status:** proposed
**Date:** 2026-07-20
**Sub-project:** A2a of the mutation-testing effort (A1 done → **A2a** → A2b → A3 → B)

## Context

A2 set out to add tests for `rate-limit.ts` and `logger.ts` — the two API
middleware modules with no test file. Reading `rate-limit.ts` first turned up
something bigger than a coverage gap: a security control that is **inert**, and
inert precisely because the module is untestable by construction.

This spec (A2a) is the security slice, carved out ahead of the rest of A2 at
the maintainer's direction — a security fix should not queue behind a testing
chore. A2b will follow with `logger.ts`, the broader `getClientIp` edge cases,
and the two coverage gaps A1 recorded.

`logger.ts` was audited and is **out of scope**: its call sites pass no secrets,
and its one unconditional `err.message` log is server-side only, which on a
self-hosted single-operator product is the operator's own log. No finding.

## The finding

`adminRateLimit` documents itself as *"Very restrictive to prevent brute force
attacks"* — 5 requests/min per IP. It is mounted **after** the authentication
it is meant to protect:

```js
// routes/admin.ts:16-17
adminRouter.use('*', adminAuth());      // throws 401 on a bad token…
adminRouter.use('*', adminRateLimit);   // …so this never runs
```

A bad admin token throws inside `adminAuth()`, and the limiter downstream is
never reached. **Measured, not inferred** — 20 requests with an invalid token:

| Mount order | Result over 20 bad tokens |
|---|---|
| auth → limiter (current `admin.ts`) | 20× 401, **0× 429** |
| limiter → auth (fixed) | 5× 401, **15× 429** |

The advertised protection does not exist. That is worse than no protection,
because the operator believes it is there.

*A note on what the limiter actually buys.* `ADMIN_TOKEN` is 256-bit
(`openssl rand -hex 32`), so credential brute-force is infeasible with or
without a limiter — see D4. The real value of the fix is **flood/DoS
protection**: without it, an unauthenticated client can fire unbounded requests
at the admin endpoint (each a cheap constant-time hash compare, but unbounded),
and the control that was meant to cap that never runs. "Brute force" is the
control's own wording (kept in the commit subject for continuity); read it as
"unauthenticated request flood", which is the threat this actually closes.

### Root cause: untestable by construction

`rate-limit.ts:5` disables all three limiters under the test runner:

```js
const isTest = !!process.env.VITEST;
export const adminRateLimit = isTest ? noopMiddleware : rateLimiter({ … });
```

No test that runs under Vitest can observe a real limiter, so no test could
ever have caught the ordering defect. `getClientIp` — the spoofing-sensitive
function — is not exported either. The absence of tests here did not merely
leave a gap; it **hid a live security defect**. That is A2's thesis in one
example.

### What is NOT broken (verified, to avoid over-fixing)

Two things I initially suspected and then disproved firsthand:

- **The mute route `PATCH /api/v1/tests/flaky/:id` is already protected.** It
  sits on `testsRouter`, which mounts `apiRateLimit` at `use('*')`
  (`tests.ts:13`); the per-route `adminAuth()` is registered afterward
  (`tests.ts:316`). Hono runs `use('*')` middleware before per-route
  middleware — **proven** by tracing execution order. So a bad token on the
  mute route is capped at 100/min per IP, not unlimited. `adminRouter` is the
  wider hole, not this route.

- **`getClientIp` works against a real server.** The untyped
  `c.env.incoming.socket.remoteAddress` casts resolve to `::ffff:127.0.0.1`
  under a real `@hono/node-server` — probed directly. So reordering
  `adminRouter` will not fall back to a shared `'unknown'` bucket in
  production.

## Decisions

**D1 — Replace the build-time `isTest` no-op with a runtime flag.**
`const isTest = !!process.env.VITEST` at module load makes the no-op branch
permanent for the whole test process. Instead, a module-level boolean
(`rateLimitEnabled`, default `!process.env.VITEST`) checked *inside* each
limiter at request time, plus a test-only setter. Production behaviour is
unchanged (`!VITEST` → enabled → real limiter runs; identical to today). The
gain: a dedicated test can flip the flag on and exercise the **real app's real
mounting** — the actual thing that regressed — instead of a reconstruction.
The build-time branch is itself the untestable smell that hid the bug; removing
it is the point.

**D2 — Export `getClientIp`, the limiter config constants, and a factory.**
`getClientIp` is the security-critical unit (IP spoofing) and must be unit
testable in isolation. The three limiters' `{ windowMs, limit }` become named
exported constants so a test asserts against the same values production uses
(no drift). A `createRateLimit(config, keyGenerator, handler)` factory is the
single builder; the three exports and the tests both go through it.

**D3 — The fix: reorder `adminRouter` so the limiter precedes `adminAuth()`.**
Move `adminRouter.use('*', adminRateLimit)` above `adminRouter.use('*',
adminAuth())`. One line. The dashboard never calls `adminRouter` (it spends
`ADMIN_TOKEN` only on `PATCH /tests/flaky/:id` — verified), so no legitimate
client is affected; admin routes are hit directly by an operator's `curl` from
their own IP, exactly what per-IP limiting is for.

**D4 — Do NOT tighten the mute route to 5/min.** It already has 100/min
pre-auth (D-finding above). The dashboard reaches it via SSR, so every mute
from every user arrives from the single dashboard-container IP; a 5/min per-IP
limit would throttle the whole team collectively while an attacker spread
across IPs keeps 5/min each. `ADMIN_TOKEN` is 256-bit (`openssl rand -hex 32`),
brute-force-infeasible regardless, so the limiter is flood-protection, not the
primary defense, and 100/min suffices. The mute route gets a **regression
assertion** locking the pre-auth ordering and a comment explaining why the
number stays 100, not a tightening.

**D5 — Test store isolation: fresh `MemoryStore` per test + a header
`keyGenerator` for factory-built limiters.** Proven: a fresh `MemoryStore()`
gives each test app an independent counter, and a per-request key header
isolates cases within one app (`keyA:[200,200,200,429,429]`,
`keyB:[200,200]`, `keyC:[200,200]`). The isolated behavioural cases use this.
The one real-app regression test (D3's guard) runs under the runtime flag; under
`app.request()` there is no socket so `getClientIp` returns `'unknown'` for
every request — a single shared bucket, which is fine for one hammer-to-429
assertion. If a second real-app counting case is ever needed, the factory
exposes the store for `resetAll()`.

**D6 — Every assertion ships with a mutation proof** (A1's standard,
[[flackyness-test-assertion-standard]]): break the covered code, watch the
specific test go red, revert. Nothing mutated is committed.

## Fixes and tests

### rate-limit.ts refactor (D1, D2)

- `getClientIp` → exported.
- `ADMIN_RATE_LIMIT`, `API_RATE_LIMIT`, `REPORT_RATE_LIMIT` → exported
  `{ windowMs, limit }` constants; the limiters read them.
- `createRateLimit(config, keyGenerator, handler)` → exported factory.
- `rateLimitEnabled` boolean (default `!process.env.VITEST`) +
  `__setRateLimitEnabled(v: boolean)` test-only setter. Each exported limiter
  wraps its real limiter and short-circuits to `next()` when disabled.
- Behaviour parity: production (`!VITEST`) is byte-for-byte equivalent to the
  old `isTest ? noop : real`.

### Security fix (D3)

`routes/admin.ts`: swap the two `use('*')` lines so the limiter is first.

### Tests — `middleware/rate-limit.test.ts` (new)

1. **`getClientIp` — the spoofing logic.** With no `TRUSTED_PROXY_IPS`: returns
   the socket IP, ignores `X-Forwarded-For`. With `TRUSTED_PROXY_IPS` set and
   the socket IP trusted: honours the first `X-Forwarded-For` hop. With the
   socket IP *not* trusted: ignores `X-Forwarded-For` (the spoofing guard).
   No socket at all: `'unknown'`.
   *Mutation proof:* remove the `trustedProxies.includes(socketIp)` guard so
   `X-Forwarded-For` is always trusted → the "not trusted" case reddens. This
   is the security-critical proof — it is what stops a client spoofing its IP
   to dodge per-IP limits.

2. **Factory behaviour.** A limiter built via `createRateLimit(ADMIN_RATE_LIMIT,
   byHeaderKey, handler)` with a fresh `MemoryStore`: the (n+1)th request over
   `ADMIN_RATE_LIMIT.limit` returns 429 with the documented body shape; a
   different key is unaffected.
   *Mutation proof:* change `ADMIN_RATE_LIMIT.limit` and confirm the boundary
   test tracks it (asserting the constant is load-bearing, not a copy).

3. **Order matters — behavioural.** A router with the real limiter + a real
   `adminAuth()` in **fixed** order: bad tokens hit 429 after the limit. Same
   two in **broken** order: bad tokens return 401 forever, never 429.
   *This encodes exactly the defect and the fix.*

4. **Real-router regression guard (D3).** Import the real `adminRouter` from
   `routes/admin.ts` (not the whole `index.ts`) and mount it on a bare Hono
   app — this preserves `admin.ts`'s real `use('*')` ordering. Set
   `ADMIN_TOKEN`, flip `__setRateLimitEnabled(true)`, hammer with a bad client
   token, assert a 429 appears within `ADMIN_RATE_LIMIT.limit + few` requests.
   `afterEach` flips it back off.
   *Mutation proof:* revert the `admin.ts` reorder → the 429 never appears, the
   test reds. This guard fails the day someone moves the limiter back after
   auth — the exact regression that shipped.
   *Why the real router, not the full app:* `adminAuth()` rejects a bad token
   via `tokensMatch` (an env compare) with **no DB call** — verified — so this
   test needs neither `DATABASE_URL` nor the full app boot. It therefore does
   **not** self-skip, and runs in every CI job, not only the DB-backed one.
   That is the strongest place for a security regression guard to live.

5. **Mute route ordering (D4).** Assert that on the real mute route
   `PATCH /tests/flaky/:id`, an unauthenticated flood is rate-limited *before*
   auth would reject it — i.e. `apiRateLimit` precedes `adminAuth`. Carry a
   comment stating the number stays 100/min by design (dashboard SSR single IP).
   *Mutation proof:* move `apiRateLimit` after the mute route's `adminAuth` →
   the pre-auth limiting disappears and the test reds.

## Scope

**In:** `rate-limit.ts` (refactor for testability + no behaviour change in
prod), `routes/admin.ts` (one-line reorder), a new `rate-limit.test.ts`.

**Out:** `logger.ts` tests (A2b — audited, no finding); the mute-route *number*
(D4 keeps 100/min); a global pre-auth limiter in `index.ts` (rejected: highest
regression risk to legitimate CI ingest, and the two real holes are closed
without it); Redis/shared store (documented follow-up in `.agent/CONTEXT.md`,
unrelated to this defect); the `/reports`-before-auth amplification (real but
low — indexed SHA-256 lookup, `timingSafeEqual` — noted, not fixed here).

## Testing strategy

Every assertion above names its mutation. The controller re-verifies findings
1 and 4 firsthand before accepting the task (A1 discipline). The runtime flag
is confirmed to leave existing route suites untouched: they run with
`rateLimitEnabled = false`, identical to today's `isTest` no-op.

## Risks

- **The runtime flag is a test seam in production code.** Mitigated: it
  defaults to production-on (`!VITEST`), the setter is named `__`-prefixed and
  test-only, and toggling it requires code execution in-process (moot as a
  threat). It replaces an existing VITEST branch of equivalent risk.
- **Reordering `adminRouter` changes admin behaviour under load.** Mitigated:
  the dashboard does not use `adminRouter`; operators hit it directly per-IP;
  the new order is what the code already claimed to do.
- **A mutation proof reveals a second real bug.** Reported, not fixed here
  (A1 rule).
- **Store state leaks between the real-app test cases.** Mitigated by D5:
  isolated cases use fresh stores; the one shared-bucket case is a single
  assertion.

## Success criteria

- `admin.ts` rate-limits a bad-token flood before auth, proven by a test that
  reds when the reorder is reverted.
- `getClientIp` is exported and its spoofing guard is proven by a mutation.
- No production behaviour change outside the intended reorder (route suites
  green, unchanged).
- `pnpm --filter api test` green; lint and typecheck clean; every changed/added
  assertion has a recorded mutation.
