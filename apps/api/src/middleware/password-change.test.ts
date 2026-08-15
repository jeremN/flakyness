import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { passwordChangeGate } from './password-change';
import type { SessionUser } from './session';

/**
 * Layer 2 in isolation — no database, no real session lookup. A fake
 * sessionAuth writes the context variable that the real one would, so this
 * file proves the GATE, not the session plumbing.
 */
function appWith(sessionUser: SessionUser | null) {
  const app = new Hono<{ Variables: { sessionUser: SessionUser } }>();
  app.use('*', async (c, next) => {
    if (sessionUser) c.set('sessionUser', sessionUser);
    await next();
  });
  app.use('*', passwordChangeGate());
  app.all('*', (c) => c.json({ reached: true }, 200));
  return app;
}

function sessionUser(mustChangePassword: boolean): SessionUser {
  return {
    id: 'u1',
    email: 'u@example.com',
    displayName: null,
    isGlobalAdmin: true,
    mustChangePassword,
    sessionId: 's1',
  };
}

describe('passwordChangeGate', () => {
  it('refuses a mid-reset session on a non-allowlisted path with 403 and a code', async () => {
    const res = await appWith(sessionUser(true)).request('/api/v1/projects');
    expect(res.status).toBe(403);
    // The code is the contract plan 059 keys its redirect off. Asserting the
    // status alone would pass against a bare HTTPException, which the global
    // error handler renders WITHOUT a code field.
    expect(await res.json()).toEqual({
      error: 'Password change required',
      code: 'password_change_required',
    });
  });

  it.each([
    ['POST', '/api/v1/auth/change-password'],
    ['GET', '/api/v1/auth/me'],
    ['HEAD', '/api/v1/auth/me'],
    ['POST', '/api/v1/auth/logout'],
    ['POST', '/api/v1/auth/login'],
  ])('lets a mid-reset session through on the allowlisted %s %s', async (method, path) => {
    const res = await appWith(sessionUser(true)).request(path, { method });
    expect(res.status).toBe(200);
    // HEAD responses carry no body by protocol, so only the four with one get
    // the body assertion. Dropping it for all five would weaken the other four.
    if (method !== 'HEAD') expect(await res.json()).toEqual({ reached: true });
  });

  /**
   * The exemption is a METHOD+PATH pair, not a path.
   *
   * Under the old path-only match, ANY method on an allowlisted path was
   * exempt — so a future `DELETE /api/v1/auth/me` ("close my account") would
   * have been reachable mid-reset without anyone deciding it should be, and
   * the coverage guard, which deduped paths into a Set, could not have seen
   * the new method at all.
   */
  it.each([
    ['DELETE', '/api/v1/auth/me'],
    ['PATCH', '/api/v1/auth/me'],
    ['POST', '/api/v1/auth/me'],
    ['GET', '/api/v1/auth/change-password'],
    ['GET', '/api/v1/auth/logout'],
    ['GET', '/api/v1/auth/login'],
  ])('refuses %s %s — the path is allowlisted, this method is not', async (method, path) => {
    const res = await appWith(sessionUser(true)).request(path, { method });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Password change required',
      code: 'password_change_required',
    });
  });

  it('HEAD on an allowlisted GET path is exempt — removing it 403s every HEAD probe of /me', async () => {
    // Not defensive padding: measured on Hono 4.12.33, HEAD against a GET
    // route returns 200 and the middleware observes `method === 'HEAD'`, so
    // the pair really is reachable in production. This assertion is the one
    // that catches the lockout this fix could otherwise have created.
    const res = await appWith(sessionUser(true)).request('/api/v1/auth/me', { method: 'HEAD' });
    expect(res.status).toBe(200);
    // And the paired negative: HEAD is NOT blanket-exempt, only on /me.
    const other = await appWith(sessionUser(true)).request('/api/v1/auth/login', { method: 'HEAD' });
    expect(other.status).toBe(403);
  });

  it('OPTIONS never reaches the gate — cors() answers preflight globally, ahead of every router', async () => {
    // Documented as measured behaviour, and pinned so a future move of
    // `app.use('*', cors())` below the routers shows up here rather than as
    // silently 403-ing preflight. This builds the real ordering from index.ts.
    const { cors } = await import('hono/cors');
    const seen: string[] = [];
    const app = new Hono<{ Variables: { sessionUser: SessionUser } }>();
    app.use('*', cors({ origin: 'http://localhost:5173', credentials: true }));
    app.use('*', async (c, next) => {
      c.set('sessionUser', sessionUser(true));
      await next();
    });
    app.use('*', async (c, next) => {
      seen.push(`${c.req.method} ${c.req.path}`);
      await next();
    });
    app.use('*', passwordChangeGate());
    app.all('*', (c) => c.json({ reached: true }, 200));

    const res = await app.request('/api/v1/projects', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.status).toBe(204);
    // The real assertion: nothing downstream of cors() ran at all, so the gate
    // never had an opinion and OPTIONS needs no allowlist entry.
    expect(seen, 'preflight must be answered before the gate is reached').toEqual([]);
  });

  it('reads the POST-NORMALISATION path, so no encoding or traversal trick desynchronises it', async () => {
    // Hono percent-decodes and resolves `..` before BOTH dispatch and
    // c.req.path, so the gate and the router can never read different
    // strings. These three spellings all dispatch to /api/v1/auth/me — under
    // a hand-rolled normalisation they might not, which is exactly why the
    // gate must not add one.
    for (const spelling of [
      '/api/v1/auth/me',
      '/api/v1/projects/../auth/me',
      '/api/v1/auth/%6de',
    ]) {
      const res = await appWith(sessionUser(true)).request(`http://localhost${spelling}`);
      expect(res.status, `${spelling} must resolve to the exempt /api/v1/auth/me`).toBe(200);
    }
  });

  it('does not refuse a session without the flag', async () => {
    const res = await appWith(sessionUser(false)).request('/api/v1/projects');
    expect(res.status).toBe(200);
  });

  it('does not refuse an anonymous request — no cookie, no gate', async () => {
    // The break-glass property: an ADMIN_TOKEN-only caller presents no session
    // cookie, so sessionAuth sets nothing and this branch is what carries them.
    const res = await appWith(null).request('/api/v1/projects');
    expect(res.status).toBe(200);
  });

  it('matches the allowlist on the FULL request path, not a suffix', async () => {
    // Hono reports c.req.path as the whole path even inside a sub-router. A
    // suffix or `endsWith` match would wrongly exempt this decoy.
    const res = await appWith(sessionUser(true)).request('/api/v1/projects/auth/me');
    expect(res.status).toBe(403);
  });

  it('is tagged so the static coverage guard can find it', () => {
    // Every call returns a fresh closure, so the guard cannot identify mounts
    // by reference. Same reason readAuth and resolveAccess are tagged.
    expect(passwordChangeGate().isPasswordChangeGate).toBe(true);
  });
});
