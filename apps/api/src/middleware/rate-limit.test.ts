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
