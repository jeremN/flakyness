# Rate-limit testability + admin brute-force fix (A2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rate-limit.ts` testable, fix the inert admin brute-force limiter (it is mounted after the auth it protects), and lock both with mutation-proven tests.

**Architecture:** One security-relevant production change (reorder two `use('*')` lines in `admin.ts`) plus a behaviour-preserving refactor of `rate-limit.ts` that swaps a build-time `VITEST` no-op for a runtime flag and exports the previously-private `getClientIp`, config constants, and a factory. A new `rate-limit.test.ts` carries the proofs.

**Tech Stack:** Hono 4.12, `hono-rate-limiter` 0.5.3 (`rateLimiter`, `MemoryStore`), Vitest 4.1.10.

**Spec:** `docs/superpowers/specs/2026-07-20-rate-limit-hardening-design.md`

## Global Constraints

- **Production behaviour outside the intended `admin.ts` reorder must not
  change.** The `rate-limit.ts` refactor is a pure seam: under `!VITEST` the
  limiters behave byte-for-byte as before. Any route suite that changes
  behaviour means the refactor broke parity — stop and fix.
- **Every mutation is reverted with `git checkout -- <file>` in the same task
  that applied it.** Never commit a mutated source file. Before each commit,
  `git status --short` must show only the file(s) the task owns.
- **A mutation that leaves the suite green means the fix failed.** Revise the
  assertion; do not weaken or skip the proof. If a proof cannot be obtained,
  say so — do not claim one that did not happen.
- **If a mutation reveals a second real bug, report it — do not fix it here.**
- Commits: single-line conventional-commit subject. **NO `Co-Authored-By`
  trailer.** No multi-paragraph body. Never `--no-verify`.
- The new `rate-limit.test.ts` must **not** be DB-gated: nothing it tests needs
  Postgres (`adminAuth` rejects a bad token via an env compare, no DB call —
  verified). It must run in every CI job, and **must not self-skip**. Confirm
  the Vitest summary shows these tests running, with no `skipped` count.

## File Structure

| File | Responsibility | Tasks |
|------|---------------|-------|
| `apps/api/src/middleware/rate-limit.ts` | Limiters + the testability seam | 1 |
| `apps/api/src/routes/admin.ts` | The one-line security reorder | 4 |
| `apps/api/src/middleware/rate-limit.test.ts` | All proofs (new file) | 2, 3, 4, 5 |

---

### Task 1: Refactor `rate-limit.ts` for testability (no behaviour change)

Replace the build-time `isTest` no-op with a runtime flag, export `getClientIp`,
the config constants, and a `createRateLimit` factory. Production behaviour is
identical; the seam lets later tasks exercise real limiters.

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.ts` (whole file)

**Interfaces:**
- Produces (later tasks consume): `getClientIp(c: Context): string`;
  `ADMIN_RATE_LIMIT` / `API_RATE_LIMIT` / `REPORT_RATE_LIMIT`
  as `{ windowMs: number; limit: number }`;
  `createRateLimit(config, keyGenerator, message): MiddlewareHandler`;
  `__setRateLimitEnabled(v: boolean): void`.
  Unchanged public exports: `reportRateLimit`, `apiRateLimit`, `adminRateLimit`.

- [ ] **Step 1: Replace the entire contents of `rate-limit.ts`**

```ts
import { rateLimiter } from 'hono-rate-limiter';
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';

// Rate limiting is disabled under the test runner by default (hammering
// endpoints in tests would otherwise trip the limits). Unlike the previous
// build-time `const isTest` branch — which made the no-op permanent and hid a
// mounting bug from every test — this is a runtime flag a dedicated test can
// flip on to exercise the real limiters. Production (`!VITEST`) is unchanged.
let rateLimitEnabled = !process.env.VITEST;

/** Test-only: enable/disable the real limiters at runtime. Do not call in prod. */
export function __setRateLimitEnabled(value: boolean): void {
  rateLimitEnabled = value;
}

// Single source of truth for the limits. Tests assert against these so a copy
// can't drift from what production uses.
export const REPORT_RATE_LIMIT = { windowMs: 60 * 1000, limit: 60 };
export const API_RATE_LIMIT = { windowMs: 60 * 1000, limit: 100 };
export const ADMIN_RATE_LIMIT = { windowMs: 60 * 1000, limit: 5 };

/**
 * Extract the client IP using a reliable strategy:
 * 1. If TRUSTED_PROXY_IPS is set, trust x-forwarded-for only when the
 *    connecting socket IP is itself trusted.
 * 2. Otherwise use the socket remote address (not spoofable).
 * 3. Last resort: 'unknown' (all unknown clients share one bucket).
 */
export function getClientIp(c: Context): string {
  const trustedProxies = process.env.TRUSTED_PROXY_IPS?.split(',').map((s) => s.trim());

  const socketIp = (c.env as Record<string, unknown>)?.incoming
    ? ((c.env as Record<string, unknown>).incoming as Record<string, unknown>)?.socket
      ? (((c.env as Record<string, unknown>).incoming as Record<string, unknown>).socket as Record<string, unknown>)?.remoteAddress as string | undefined
      : undefined
    : undefined;

  if (trustedProxies && socketIp && trustedProxies.includes(socketIp)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0].trim();
    if (forwarded) return forwarded;
  }

  return socketIp || 'unknown';
}

/**
 * The single limiter builder. Wraps a real `rateLimiter` behind the runtime
 * flag: when disabled (default under VITEST) it is a pass-through; when enabled
 * it enforces `config`. Each call owns a fresh in-memory store.
 */
export function createRateLimit(
  config: { windowMs: number; limit: number },
  keyGenerator: (c: Context) => string,
  message: string
): MiddlewareHandler {
  const real = rateLimiter({
    windowMs: config.windowMs,
    limit: config.limit,
    standardHeaders: 'draft-7',
    keyGenerator,
    handler: (c: Context) => c.json({ error: message, retryAfter: 60 }, 429),
  });
  return createMiddleware(async (c, next) => {
    if (!rateLimitEnabled) return next();
    return real(c, next);
  });
}

/**
 * Rate limiter for report ingestion. Limit: 60/min per project token.
 */
export const reportRateLimit = createRateLimit(
  REPORT_RATE_LIMIT,
  (c: Context) => {
    const project = c.get('project');
    return project?.id || 'anonymous';
  },
  'Too many report uploads. Please wait before retrying.'
);

/**
 * Rate limiter for general read endpoints. Limit: 100/min per IP.
 */
export const apiRateLimit = createRateLimit(
  API_RATE_LIMIT,
  getClientIp,
  'Rate limit exceeded. Please slow down.'
);

/**
 * Rate limiter for admin endpoints. Very restrictive to slow brute force.
 * Limit: 5/min per IP. MUST be mounted BEFORE adminAuth (see admin.ts) or it
 * never runs.
 */
export const adminRateLimit = createRateLimit(
  ADMIN_RATE_LIMIT,
  getClientIp,
  'Admin rate limit exceeded.'
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: clean. (`MiddlewareHandler` is imported; the `c.get('project')` call
matches the existing typing — it compiled before.)

- [ ] **Step 3: Run the full API suite — parity check**

Run: `pnpm --filter api exec vitest run`
(export `DATABASE_URL`/`ADMIN_TOKEN` first — see the dispatch notes.)
Expected: the same pass count as before this task (328). The limiters are
disabled under VITEST exactly as the old `isTest` no-op did, so no route suite
should change. **A changed count means parity broke — stop.**

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/rate-limit.ts
git commit -m "refactor(api): make rate limiters testable via a runtime flag"
```

---

### Task 2: Unit-test `getClientIp` — the IP-spoofing guard

`getClientIp` decides whether to trust `X-Forwarded-For`. Trusting it from an
untrusted socket would let any client spoof its IP and dodge per-IP limits.
This is the security-critical unit.

**Files:**
- Create: `apps/api/src/middleware/rate-limit.test.ts`

**Interfaces:**
- Consumes: `getClientIp` from Task 1.

- [ ] **Step 1: Create the test file with the `getClientIp` suite**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { getClientIp } from './rate-limit';

// Build the minimal shape getClientIp reads: c.env.incoming.socket.remoteAddress
// and c.req.header('x-forwarded-for').
function fakeCtx(opts: { socketIp?: string; xff?: string }): Context {
  return {
    env: opts.socketIp
      ? { incoming: { socket: { remoteAddress: opts.socketIp } } }
      : {},
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'x-forwarded-for' ? opts.xff : undefined,
    },
  } as unknown as Context;
}

describe('getClientIp', () => {
  const original = process.env.TRUSTED_PROXY_IPS;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY_IPS;
    else process.env.TRUSTED_PROXY_IPS = original;
  });

  it('uses the socket IP and ignores X-Forwarded-For when no proxy is trusted', () => {
    delete process.env.TRUSTED_PROXY_IPS;
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '9.9.9.9' }))).toBe('1.2.3.4');
  });

  it('returns "unknown" when there is no socket IP', () => {
    delete process.env.TRUSTED_PROXY_IPS;
    expect(getClientIp(fakeCtx({ xff: '9.9.9.9' }))).toBe('unknown');
  });

  it('honours X-Forwarded-For when the socket IP is a trusted proxy', () => {
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4, 5.5.5.5';
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('ignores X-Forwarded-For when the socket IP is NOT trusted (spoofing guard)', () => {
    process.env.TRUSTED_PROXY_IPS = '5.5.5.5';
    // Socket 1.2.3.4 is not in the trusted list, so the client's spoofed
    // X-Forwarded-For must be ignored and the real socket IP used.
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '9.9.9.9' }))).toBe('1.2.3.4');
  });
});
```

- [ ] **Step 2: Run and confirm it passes without skipping**

Run: `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
Expected: 4 passed, 0 skipped.

- [ ] **Step 3: Mutation proof — remove the trusted-proxy guard**

In `rate-limit.ts`, change the condition inside `getClientIp` from
`if (trustedProxies && socketIp && trustedProxies.includes(socketIp))`
to `if (trustedProxies && socketIp)` (drop the `.includes` check).

Run: `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
Expected: **`ignores X-Forwarded-For when the socket IP is NOT trusted` FAILS**
(receives `9.9.9.9`). Record the failure line.

Revert: `git checkout -- apps/api/src/middleware/rate-limit.ts`

- [ ] **Step 4: Confirm tree clean, then commit**

Run: `git status --short` → only `rate-limit.test.ts` (untracked/new).

```bash
git add apps/api/src/middleware/rate-limit.test.ts
git commit -m "test(api): cover the getClientIp IP-spoofing guard"
```

---

### Task 3: Test the factory limit and pin the admin limit value

Prove the factory enforces its configured limit, and pin the documented
`ADMIN_RATE_LIMIT` values so a silent loosening reds a test.

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `createRateLimit`, `ADMIN_RATE_LIMIT`, `__setRateLimitEnabled`.

- [ ] **Step 1: Append this describe block at the end of the file**

```ts
describe('rate limiter enforcement', () => {
  // The documented "very restrictive" admin policy. Pinned so a loosening
  // (e.g. limit: 5 -> 500) reds here, not silently in production.
  it('ADMIN_RATE_LIMIT is 5 requests per 60s', async () => {
    const { ADMIN_RATE_LIMIT } = await import('./rate-limit');
    expect(ADMIN_RATE_LIMIT).toEqual({ windowMs: 60_000, limit: 5 });
  });

  it('a factory-built limiter 429s once its limit is exceeded', async () => {
    const { Hono } = await import('hono');
    const { createRateLimit, ADMIN_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      // Fresh limiter -> fresh in-memory store; key by header for isolation.
      app.use('*', createRateLimit(ADMIN_RATE_LIMIT, (c) => c.req.header('x-key') ?? 'k', 'nope'));
      app.get('/x', (c) => c.json({ ok: true }));

      const codes: number[] = [];
      for (let i = 0; i < ADMIN_RATE_LIMIT.limit + 2; i++) {
        codes.push((await app.request('/x', { headers: { 'x-key': 'a' } })).status);
      }
      const allowed = codes.filter((s) => s === 200).length;
      const blocked = codes.filter((s) => s === 429).length;
      expect(allowed).toBe(ADMIN_RATE_LIMIT.limit);
      expect(blocked).toBe(2);

      // A different key is unaffected by the first key's exhaustion.
      const other = await app.request('/x', { headers: { 'x-key': 'b' } });
      expect(other.status).toBe(200);
    } finally {
      __setRateLimitEnabled(false);
    }
  });
});
```

- [ ] **Step 2: Run and confirm pass, no skip**

Run: `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
Expected: 6 passed, 0 skipped.

- [ ] **Step 3: Mutation proof — loosen the admin limit**

In `rate-limit.ts`, change `ADMIN_RATE_LIMIT` to `{ windowMs: 60 * 1000, limit: 500 }`.

Run: `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
Expected: **`ADMIN_RATE_LIMIT is 5 requests per 60s` FAILS**, and the
enforcement test fails too (only `limit+2` = 502 requests sent, `allowed`
would be 502 not 500... it sends `limit+2`, so with limit 500 it sends 502,
allowed=500? no — it sends `ADMIN_RATE_LIMIT.limit + 2`, which now reads 502,
so both sides move together and the enforcement test may still pass). Record
which assertions fired. The **value-pin** test is the guaranteed catch here;
that is why it exists separately from the enforcement test.

Revert: `git checkout -- apps/api/src/middleware/rate-limit.ts`

- [ ] **Step 4: Commit**

Run `git status --short` → only `rate-limit.test.ts`.

```bash
git add apps/api/src/middleware/rate-limit.test.ts
git commit -m "test(api): pin the admin limit value and prove factory enforcement"
```

---

### Task 4: Fix the admin mount order and guard it on the real router

The security fix: mount `adminRateLimit` before `adminAuth()` so a brute-force
flood is throttled before auth rejects it. Guard it by exercising the **real**
`adminRouter`.

**Files:**
- Modify: `apps/api/src/routes/admin.ts:15-17`
- Modify: `apps/api/src/middleware/rate-limit.test.ts` (append a describe block)

**Interfaces:**
- Consumes: the real `adminRouter` (**`export default` — verified**, so import
  the default, not a named binding), `ADMIN_RATE_LIMIT`, `__setRateLimitEnabled`.

- [ ] **Step 1: Reorder the two `use('*')` lines in `admin.ts`**

Replace:

```ts
// Apply admin auth and rate limiting to all routes
adminRouter.use('*', adminAuth());
adminRouter.use('*', adminRateLimit);
```

with:

```ts
// Rate limiting MUST come before auth: a brute-force flood of bad tokens has to
// be throttled here, not waved through to adminAuth (which would 401 each
// attempt and never reach the limiter). Guarded by rate-limit.test.ts.
adminRouter.use('*', adminRateLimit);
adminRouter.use('*', adminAuth());
```

- [ ] **Step 2: (context) `admin.ts` ends with `export default adminRouter`**

Already verified while writing this plan. The Step 3 code imports the default
(`const { default: adminRouter } = await import('../routes/admin')`) — no
action needed beyond reading this.

- [ ] **Step 3: Append this describe block to `rate-limit.test.ts`**

```ts
describe('admin router mounts the limiter before auth (regression guard)', () => {
  it('rate-limits a bad-token flood instead of only 401-ing it', async () => {
    const { Hono } = await import('hono');
    const { HTTPException } = await import('hono/http-exception');
    const { default: adminRouter } = await import('../routes/admin'); // export default
    const { ADMIN_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'correct-admin-token';
    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.onError((err, c) =>
        err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({}, 500)
      );
      app.route('/api/v1/admin', adminRouter);

      const codes: number[] = [];
      // No socket under app.request -> getClientIp returns 'unknown' for all,
      // one shared bucket. With the limiter FIRST, requests past the limit are
      // 429; with the limiter after auth, every bad token is 401 and 429 never
      // appears.
      for (let i = 0; i < ADMIN_RATE_LIMIT.limit + 3; i++) {
        const res = await app.request('/api/v1/admin/projects', {
          method: 'GET',
          headers: { Authorization: 'Bearer WRONG' },
        });
        codes.push(res.status);
      }
      expect(codes).toContain(429);
      // Sanity: the early ones are auth rejections, proving the limiter let
      // them reach auth rather than the endpoint doing something else.
      expect(codes[0]).toBe(401);
    } finally {
      __setRateLimitEnabled(false);
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });
});
```

- [ ] **Step 4: Run — expect green with the fix in place**

Run: `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
Expected: 7 passed, 0 skipped. In particular the new test passes because the
reorder is applied.

- [ ] **Step 5: Mutation proof — revert the reorder**

Temporarily swap the two `use('*')` lines back (auth first). Run the file.
Expected: **the guard test FAILS** — `codes` is all `401`, never `429`, so
`toContain(429)` fails. This is the exact regression that shipped. Record it.

Restore the fixed order: re-apply Step 1 (or `git checkout -- apps/api/src/routes/admin.ts`
then re-do Step 1 — the fix must remain).

- [ ] **Step 6: Full API suite — confirm the reorder broke nothing**

Run: `pnpm --filter api exec vitest run`
Expected: 328 + the new tests, all green, no unexpected skips. Admin route
suites are unaffected (limiter disabled under VITEST for them; the reorder only
changes order, not the disabled state).

- [ ] **Step 7: Commit (both files together — the fix and its guard)**

Run `git status --short` → `admin.ts` and `rate-limit.test.ts` only.

```bash
git add apps/api/src/routes/admin.ts apps/api/src/middleware/rate-limit.test.ts
git commit -m "fix(api): rate-limit admin routes before auth to slow brute force"
```

---

### Task 5: Guard the mute route's pre-auth ordering

`PATCH /tests/flaky/:id` (the `ADMIN_TOKEN` path the dashboard uses) is already
correctly ordered — `apiRateLimit` at `use('*')` runs before the per-route
`adminAuth()`. We are **not** tightening its 100/min (dashboard SSR sends every
mute from one IP; see the spec's D4). Add a guard so a future reorder can't
silently kill that pre-auth limiting.

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.test.ts` (append a describe block)

**Interfaces:**
- Consumes: the real `testsRouter` (**`export default` — verified**, import the
  default), `API_RATE_LIMIT`, `__setRateLimitEnabled`.

- [ ] **Step 1: (context) the export is `export default testsRouter`**

Already verified while writing this plan (`tests.ts:` bottom). The Step 2 code
imports the default accordingly — no action needed beyond reading this.

- [ ] **Step 2: Append this describe block**

```ts
describe('mute route rate-limits before auth (regression guard)', () => {
  it('a bad-token flood on PATCH /tests/flaky/:id is rate-limited, not only 401-ed', async () => {
    const { Hono } = await import('hono');
    const { HTTPException } = await import('hono/http-exception');
    const { default: testsRouter } = await import('../routes/tests'); // export default
    const { API_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'correct-admin-token';
    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.onError((err, c) =>
        err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({}, 500)
      );
      app.route('/api/v1/tests', testsRouter);

      let saw429 = false;
      let saw401 = false;
      // apiRateLimit is 100/min; send enough to cross it. All share the
      // 'unknown' bucket (no socket under app.request). If apiRateLimit ran
      // AFTER adminAuth, every bad token would 401 and 429 would never appear.
      for (let i = 0; i < API_RATE_LIMIT.limit + 3; i++) {
        const res = await app.request('/api/v1/tests/flaky/00000000-0000-0000-0000-000000000000', {
          method: 'PATCH',
          headers: { Authorization: 'Bearer WRONG', 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ignored' }),
        });
        if (res.status === 429) saw429 = true;
        if (res.status === 401) saw401 = true;
      }
      expect(saw401).toBe(true); // early requests reached auth
      expect(saw429).toBe(true); // the limiter is upstream of auth
    } finally {
      __setRateLimitEnabled(false);
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });
});
```

- [ ] **Step 3: Run — expect green (route is already correctly ordered)**

Run: `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
Expected: 8 passed, 0 skipped.

- [ ] **Step 4: Mutation proof — move `apiRateLimit` after the mute route's auth**

This is the fiddly one: `apiRateLimit` is mounted once at `tests.ts:13`
(`testsRouter.use('*', apiRateLimit)`) and covers all routes. To simulate the
regression for the mute route specifically, **comment out line 13** and add
`apiRateLimit` as a per-route middleware *after* `adminAuth()` on the PATCH
route (`testsRouter.patch('/flaky/:id', adminAuth(), apiRateLimit, async (c) => {…}`).

Run: `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
Expected: **the mute guard FAILS** — `saw429` is false, every bad token 401s.
Record it.

Revert: `git checkout -- apps/api/src/routes/tests.ts`

- [ ] **Step 5: Commit**

Run `git status --short` → only `rate-limit.test.ts`.

```bash
git add apps/api/src/middleware/rate-limit.test.ts
git commit -m "test(api): guard the mute route's pre-auth rate limiting"
```

---

### Task 6: Final gate + plan index

- [ ] **Step 1: Full suite, lint, typecheck**

```bash
pnpm --filter api test
pnpm --filter dashboard test
pnpm lint
pnpm --filter api exec tsc --noEmit
```
Expected: all green. Record counts; confirm no unexpected `skipped` and that
`rate-limit.test.ts` ran (8 tests).

- [ ] **Step 2: Confirm the branch diff is only the intended files**

Run: `git diff --name-only main...HEAD`
Expected: `rate-limit.ts`, `admin.ts`, `rate-limit.test.ts`, the spec, this
plan, `plans/README.md`. **Any other production file means a mutation was
committed** — investigate.

- [ ] **Step 3: Confirm no mutated source lingers**

Run: `git status --short`
Expected: clean (or only untracked scratch). `admin.ts` must show the fixed
order (limiter first); `tests.ts` and `rate-limit.ts` must match `main` except
for Task 1's intended refactor.

- [ ] **Step 4: Index the plan**

In `plans/README.md`, add a row after plan 042 (match the column layout
`| Plan | Title | Priority | Effort | Depends on | Status |`):

```
| 043 | Fix the inert admin brute-force limiter (mounted after the auth it protects) and make rate-limit.ts testable; A2a of the mutation-testing effort | P2 | S | A1 (plan 042); security finding | TODO |
```

- [ ] **Step 5: Commit**

```bash
git add plans/README.md
git commit -m "docs: index plan 043"
```

---

## Self-Review Notes

**Spec coverage:** D1 (runtime flag) → Task 1. D2 (exports) → Task 1. D3
(reorder + guard) → Task 4. D4 (mute route not tightened, guarded) → Task 5.
D5 (store isolation) → Tasks 3/4/5 (fresh stores via factory; shared 'unknown'
bucket for the single real-router hammer). D6 (mutation proofs) → every task.
getClientIp spoofing → Task 2.

**Consolidation vs the spec:** the spec listed an isolated both-orders test
(its test 3) *and* a real-app guard (its test 4). This plan ships only the
real-router guard (Task 4) plus the mutation that reverts the reorder — the
mutation already exercises the broken order, so a separate committed
both-orders test would be redundant. The factory enforcement test (Task 3)
independently proves the limiter mechanism. No coverage is lost.

**Known sharp edges, stated not hidden:**
1. Tasks 4 and 5 flip a module-global flag and rely on `finally` to reset it.
   If a test throws before `finally`, the flag could leak to later tests in the
   file. Mitigated: each uses try/finally, and the flag defaults off so a leak
   would only *enable* limiters — which the other tests in this file already
   expect when they enable it themselves. Still, keep the try/finally.
2. The Task 3 mutation (limit 5 → 500) moves both sides of the enforcement
   assertion, so the **value-pin** test is the reliable catch. That is why the
   pin is a separate test; do not merge them.
3. All the new tests are DB-independent by design (no `describeWithDb`), so
   they run in every CI job — the strongest place for a security guard.
