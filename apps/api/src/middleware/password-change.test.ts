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
    '/api/v1/auth/change-password',
    '/api/v1/auth/me',
    '/api/v1/auth/logout',
    '/api/v1/auth/login',
  ])('lets a mid-reset session through on the allowlisted path %s', async (path) => {
    const res = await appWith(sessionUser(true)).request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
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
