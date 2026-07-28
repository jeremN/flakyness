import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('takes the first hop of a multi-value X-Forwarded-For and trims it', () => {
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4';
    // Whitespaced, multi-hop XFF — proves `.split(',')[0].trim()`, not the
    // whole header and not the second hop.
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '  9.9.9.9 , 10.0.0.1' }))).toBe('9.9.9.9');
  });

  it('trims each entry of TRUSTED_PROXY_IPS when matching the socket IP', () => {
    // '5.5.5.5' is the SECOND, space-prefixed entry — matching it requires the
    // per-entry .trim() in the map (the existing test only hits the first,
    // already-trimmed entry).
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4, 5.5.5.5';
    expect(getClientIp(fakeCtx({ socketIp: '5.5.5.5', xff: '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('falls back to the socket IP when a trusted proxy sends an empty X-Forwarded-For', () => {
    // Task-1 finding: `if (forwarded)` (rate-limit.ts:41) had no present-but-blank
    // XFF test. An empty header must be treated as absent → return the socket IP,
    // not ''. Mutating the guard to `if (true)` would return '' here.
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4';
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '' }))).toBe('1.2.3.4');
  });
});

describe('rate limiter enforcement', () => {
  // The documented "very restrictive" admin policy. Pinned so a loosening
  // (e.g. limit: 5 -> 500) reds here, not silently in production.
  it('ADMIN_RATE_LIMIT is 5 requests per 60s', async () => {
    const { ADMIN_RATE_LIMIT } = await import('./rate-limit');
    expect(ADMIN_RATE_LIMIT).toEqual({ windowMs: 60_000, limit: 5 });
  });

  it('REPORT_RATE_LIMIT and API_RATE_LIMIT are the documented values', async () => {
    const { REPORT_RATE_LIMIT, API_RATE_LIMIT } = await import('./rate-limit');
    expect(REPORT_RATE_LIMIT).toEqual({ windowMs: 60_000, limit: 60 });
    expect(API_RATE_LIMIT).toEqual({ windowMs: 60_000, limit: 100 });
  });

  // Pins the exact constant: relative-ordering assertions alone (below) don't
  // catch a mutant like 10 -> 50, since 50 is still between 5 and 100.
  it('AUTH_RATE_LIMIT is exactly 10 requests per 60s', async () => {
    const { AUTH_RATE_LIMIT } = await import('./rate-limit');
    expect(AUTH_RATE_LIMIT).toEqual({ windowMs: 60 * 1000, limit: 10 });
  });

  it('exposes an auth limiter that is stricter than the API limiter but looser than admin', async () => {
    const { AUTH_RATE_LIMIT, API_RATE_LIMIT, ADMIN_RATE_LIMIT } = await import('./rate-limit');
    expect(AUTH_RATE_LIMIT.limit).toBeLessThan(API_RATE_LIMIT.limit);
    expect(AUTH_RATE_LIMIT.limit).toBeGreaterThan(ADMIN_RATE_LIMIT.limit);
    expect(AUTH_RATE_LIMIT.windowMs).toBe(60 * 1000);
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

  it('the 429 response body carries the message and retryAfter: 60', async () => {
    const { Hono } = await import('hono');
    const { createRateLimit, ADMIN_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.use('*', createRateLimit(ADMIN_RATE_LIMIT, () => 'shared', 'slow down please'));
      app.get('/x', (c) => c.json({ ok: true }));

      let last: Response | undefined;
      for (let i = 0; i < ADMIN_RATE_LIMIT.limit + 1; i++) last = await app.request('/x');

      expect(last!.status).toBe(429);
      expect(await last!.json()).toEqual({ error: 'slow down please', retryAfter: 60 });
    } finally {
      __setRateLimitEnabled(false);
    }
  });

  it('authRateLimit allows the first 10 requests and 429s the 11th', async () => {
    const { Hono } = await import('hono');
    const { authRateLimit, AUTH_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.use('*', authRateLimit);
      app.get('/x', (c) => c.json({ ok: true }));

      const codes: number[] = [];
      for (let i = 0; i < AUTH_RATE_LIMIT.limit + 2; i++) {
        codes.push((await app.request('/x')).status);
      }
      const allowed = codes.filter((s) => s === 200).length;
      const blocked = codes.filter((s) => s === 429).length;
      expect(allowed).toBe(AUTH_RATE_LIMIT.limit);
      expect(blocked).toBe(2);
      // Pin the boundary literally: the 11th request (index 10) is the first
      // to be throttled, and the 10th (index 9) still passes.
      expect(codes[9]).toBe(200);
      expect(codes[10]).toBe(429);
    } finally {
      __setRateLimitEnabled(false);
    }
  });

  it('reportRateLimit keys by the project id (separate buckets) and 429s with its own message', async () => {
    const { Hono } = await import('hono');
    const { reportRateLimit, REPORT_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      // Per-request project id (from a header) so two ids get two buckets. This
      // proves the key generator actually reads `c.get('project')?.id`: if it
      // were mutated to always return 'anonymous', project B below would share
      // A's exhausted bucket and 429 instead of 200. Unique ids ('rl-a'/'rl-b')
      // keep reportRateLimit's module-level store isolated from other tests.
      app.use('*', async (c: Context, next) => { c.set('project', { id: c.req.header('x-proj') }); await next(); });
      app.use('*', reportRateLimit);
      app.get('/x', (c) => c.json({ ok: true }));

      let last: Response | undefined;
      for (let i = 0; i < REPORT_RATE_LIMIT.limit + 1; i++) {
        last = await app.request('/x', { headers: { 'x-proj': 'rl-a' } });
      }
      expect(last!.status).toBe(429);
      expect(await last!.json()).toEqual({
        error: 'Too many report uploads. Please wait before retrying.',
        retryAfter: 60,
      });

      // A different project id is a different bucket → still allowed.
      const other = await app.request('/x', { headers: { 'x-proj': 'rl-b' } });
      expect(other.status).toBe(200);
    } finally {
      __setRateLimitEnabled(false);
    }
  });
});

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

describe('auth router: authRateLimit is scoped to /login + /change-password only (Important-1 regression guard)', () => {
  // Prior revision mounted `authRateLimit` on authRouter.use('*', ...), which
  // also capped GET /me at 10/min per IP. Since plan 059's dashboard
  // hooks.server.ts calls /me on every server-rendered page view, all users
  // behind the dashboard container's single IP shared that bucket: the 11th
  // page view in any minute 429d, and the dashboard's fetchMe reads a
  // non-2xx response as "not signed in" — a random logout under completely
  // ordinary load. These two tests mount the REAL authRouter (not a
  // synthetic app.get('/x')) so they actually exercise the production
  // mount, not just the limiter object in isolation.
  it('a flood of malformed-body attempts on POST /api/v1/auth/login gets 429d', async () => {
    // Fresh module instance: authRateLimit's 'unknown'-keyed bucket is
    // shared by every test in this file that exercises it directly.
    vi.resetModules();
    const { Hono } = await import('hono');
    const { default: authRouter } = await import('../routes/auth');
    const { AUTH_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.route('/api/v1/auth', authRouter);

      // A syntactically-invalid email 400s at zValidator without ever
      // reaching the DB — this file has no DATABASE_URL dependency anywhere
      // else, and keeping this test DB-free lets it always run, not just
      // when Postgres happens to be up. The point under test is the
      // limiter's mount on the real route, not the login business logic
      // (already covered by auth.test.ts's real-credential suite).
      const codes: number[] = [];
      for (let i = 0; i < AUTH_RATE_LIMIT.limit + 3; i++) {
        const res = await app.request('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'not-an-email', password: 'x' }),
        });
        codes.push(res.status);
      }
      expect(codes).toContain(429);
      // Sanity: the early ones actually reached the route (400 from
      // zValidator), proving the limiter let them through rather than
      // something else rejecting every request outright.
      expect(codes[0]).toBe(400);
    } finally {
      __setRateLimitEnabled(false);
      vi.resetModules();
    }
  });

  it('an unmatched path under /api/v1/auth is still rate-limited, not an open DB path', async () => {
    // Regression guard for a gap the final whole-branch review found. Scoping
    // authRateLimit to /login + /change-password removed the wildcard that had
    // been the ONLY cover for paths matching no handler — while sessionAuth()
    // stayed on '*'. So /api/v1/auth/nope with a cookie ran a SHA-256 plus an
    // indexed sessions↔users SELECT and 404'd, unthrottled, forever.
    // Deleting `authRouter.use('*', apiRateLimit)` must red this test.
    vi.resetModules();
    const { Hono } = await import('hono');
    const { default: authRouter } = await import('../routes/auth');
    const { API_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.route('/api/v1/auth', authRouter);

      // No cookie, so sessionAuth() short-circuits before touching the DB and
      // this stays DB-free — the limiter is what we are proving, not the query.
      const codes: number[] = [];
      for (let i = 0; i < API_RATE_LIMIT.limit + 3; i++) {
        codes.push((await app.request('/api/v1/auth/definitely-not-a-route')).status);
      }
      expect(codes).toContain(429);
      // Sanity: the early ones really did fall through to a 404, proving the
      // limiter passed them on rather than something else refusing everything.
      expect(codes[0]).toBe(404);
    } finally {
      __setRateLimitEnabled(false);
      vi.resetModules();
    }
  });

  it('a flood of malformed-body attempts on POST /api/v1/auth/change-password gets 429d', async () => {
    // The sibling of the /login test above. Without this, removing
    // `authRouter.use('/change-password', authRateLimit)` — or typo-ing its
    // path — leaves the entire suite green, because the /login test only
    // proves /login's own mount. change-password takes a password on the
    // wire just as login does, so it needs the same brute-force ceiling and
    // the same regression guard.
    vi.resetModules();
    const { Hono } = await import('hono');
    const { default: authRouter } = await import('../routes/auth');
    const { AUTH_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.route('/api/v1/auth', authRouter);

      // DB-free for the same reason as the /login test: a malformed body
      // 400s at zValidator, and sessionAuth() short-circuits before any
      // query when the request carries no cookie.
      const codes: number[] = [];
      for (let i = 0; i < AUTH_RATE_LIMIT.limit + 3; i++) {
        const res = await app.request('/api/v1/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: '' }),
        });
        codes.push(res.status);
      }
      expect(codes).toContain(429);
      // Sanity: early requests reached the route rather than being refused
      // by something upstream of the limiter.
      expect(codes[0]).toBe(400);
    } finally {
      __setRateLimitEnabled(false);
      vi.resetModules();
    }
  });

  it('GET /api/v1/auth/me is NOT throttled at the 10/min auth limit', async () => {
    vi.resetModules();
    const { Hono } = await import('hono');
    const { default: authRouter } = await import('../routes/auth');
    const { AUTH_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.route('/api/v1/auth', authRouter);

      // No session cookie -> every request 401s regardless of throttling.
      // The assertion under test is that NONE of them are 429: if
      // `authRateLimit` were (re)mounted on '*' — the bug Important 1
      // fixes — the 11th of these would 429, exactly like the flood test
      // above does for /login.
      const codes: number[] = [];
      for (let i = 0; i < AUTH_RATE_LIMIT.limit + 5; i++) {
        codes.push((await app.request('/api/v1/auth/me')).status);
      }
      expect(codes).not.toContain(429);
      expect(codes.every((s) => s === 401)).toBe(true);
    } finally {
      __setRateLimitEnabled(false);
      vi.resetModules();
    }
  });
});

describe('authRateLimit has NO bearer exemption (unlike adminRateLimit)', () => {
  it('still rate-limits a flood of login attempts carrying a valid ADMIN_TOKEN bearer', async () => {
    // authRateLimit is a module-level singleton keyed by getClientIp, which
    // resolves to the constant 'unknown' bucket under app.request (no
    // socket). A fresh module instance (fresh in-memory store) is required
    // so this test's counts aren't polluted by the 'authRateLimit allows the
    // first 10...' test above sharing the same bucket.
    vi.resetModules();
    const { Hono } = await import('hono');
    const { authRateLimit, AUTH_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'valid-admin-token';
    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.use('*', authRateLimit);
      app.get('/x', (c) => c.json({ ok: true }));

      // authRateLimit is a plain per-IP limiter (unlike adminRateLimit, which
      // exempts a valid ADMIN_TOKEN bearer via hasValidAdminBearer) — a login
      // request never carries a credential that should exempt it, since
      // proving the password IS the point of the request. A copy-paste of
      // adminRateLimit's skip onto this limiter would let an attacker holding
      // an admin token brute-force passwords unthrottled; this reds that.
      const codes: number[] = [];
      for (let i = 0; i < AUTH_RATE_LIMIT.limit + 2; i++) {
        const res = await app.request('/x', {
          headers: { Authorization: 'Bearer valid-admin-token' },
        });
        codes.push(res.status);
      }
      expect(codes).toContain(429);
      expect(codes[9]).toBe(200);
      expect(codes[10]).toBe(429);
    } finally {
      __setRateLimitEnabled(false);
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
      vi.resetModules();
    }
  });
});

describe('hasValidAdminBearer (admin limiter exemption predicate)', () => {
  // The predicate reads only c.req.header('Authorization'); fake exactly that.
  function authCtx(authHeader?: string): Context {
    return {
      req: { header: (n: string) => (n === 'Authorization' ? authHeader : undefined) },
    } as unknown as Context;
  }

  const prevToken = process.env.ADMIN_TOKEN;
  afterEach(() => {
    if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prevToken;
  });

  it('is true for a Bearer that matches ADMIN_TOKEN', async () => {
    const { hasValidAdminBearer } = await import('./rate-limit');
    process.env.ADMIN_TOKEN = 'the-admin-token';
    expect(hasValidAdminBearer(authCtx('Bearer the-admin-token'))).toBe(true);
  });

  it('is false for a Bearer that does NOT match ADMIN_TOKEN', async () => {
    // Mutating tokensMatch (or the predicate) to always-true would wrongly
    // exempt every attacker guess from the brute-force limiter; this reds that.
    const { hasValidAdminBearer } = await import('./rate-limit');
    process.env.ADMIN_TOKEN = 'the-admin-token';
    expect(hasValidAdminBearer(authCtx('Bearer wrong-token'))).toBe(false);
  });

  it('is false (never throws) when there is no Authorization header', async () => {
    // Guards the `token !== null` short-circuit: without it, tokensMatch(null,…)
    // throws on a header-less request, so the limiter would 500 instead of
    // throttling. This asserts the header-less case is classified, not crashed.
    const { hasValidAdminBearer } = await import('./rate-limit');
    process.env.ADMIN_TOKEN = 'the-admin-token';
    expect(hasValidAdminBearer(authCtx(undefined))).toBe(false);
  });

  it('is false when ADMIN_TOKEN is not configured', async () => {
    // Guards the `!adminToken` branch: an unconfigured admin must NOT be treated
    // as "everyone is a valid admin" (which would disable the limiter wholesale).
    const { hasValidAdminBearer } = await import('./rate-limit');
    delete process.env.ADMIN_TOKEN;
    expect(hasValidAdminBearer(authCtx('Bearer anything'))).toBe(false);
  });
});

describe('admin limiter exempts a valid admin token (not just throttles bad ones)', () => {
  it('lets a valid-ADMIN_TOKEN flood through well past the 5/min limit', async () => {
    const { Hono } = await import('hono');
    const { adminRateLimit, ADMIN_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');
    const { adminAuth } = await import('./auth');

    const prevToken = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'valid-admin-token';
    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      // Same order production uses: limiter first, then auth.
      app.use('*', adminRateLimit);
      app.use('*', adminAuth());
      app.get('/x', (c) => c.json({ ok: true }));

      // Valid requests are SKIPPED, so they never touch the (module-shared)
      // store — deterministic regardless of test order. limit + 2 requests with
      // a wrong/absent token would 429; with the valid token, none may. Removing
      // the `if (skip?.(c))` bypass — or forcing hasValidAdminBearer false —
      // reds this (the flood starts 429-ing once past the limit).
      const codes: number[] = [];
      for (let i = 0; i < ADMIN_RATE_LIMIT.limit + 2; i++) {
        const res = await app.request('/x', {
          headers: { Authorization: 'Bearer valid-admin-token' },
        });
        codes.push(res.status);
      }
      expect(codes).not.toContain(429);
      expect(codes.every((s) => s === 200)).toBe(true);
    } finally {
      __setRateLimitEnabled(false);
      if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevToken;
    }
  });
});
