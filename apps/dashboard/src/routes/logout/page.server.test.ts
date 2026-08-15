import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SESSION_COOKIE, SESSION_COOKIE_PATH } from '$lib/session';
import { actions } from './+page.server';

const fetchMock = vi.fn();

// sessionToken and clientIp default to fixed, non-null, DISTINCT-from-each-
// other values so every test but the dedicated ones exercises the
// header-present / API-called path without having to say so explicitly —
// same fixture-design precedent as change-password/page.server.test.ts's
// formEvent.
function event(opts: { sessionToken?: string | null; clientIp?: string | null } = {}) {
  const cookies = { delete: vi.fn() };
  const sessionToken = opts.sessionToken === undefined ? 'sess-abc' : opts.sessionToken;
  const clientIp = opts.clientIp === undefined ? '203.0.113.7' : opts.clientIp;
  return { cookies, locals: { sessionToken, clientIp } };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('logout action', () => {
  it(
    "calls the API's logout endpoint with the session cookie and " +
      'X-Forwarded-For, clears the local cookie, and redirects to /login',
    async () => {
      // Deliberately distinct from every other fixture IP in this file (and
      // from change-password's 198.51.100.9): if the action ever hardcoded a
      // literal instead of threading locals.clientIp through, a
      // fixture-matching literal would pass this assertion by coincidence.
      const clientIp = '192.0.2.55';
      const ev = event({ sessionToken: 'sess-abc', clientIp });

      await expect(actions.default(ev as any)).rejects.toMatchObject({ status: 303, location: '/login' });

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/api/v1/auth/logout', {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=sess-abc`, 'X-Forwarded-For': clientIp },
      });
      expect(ev.cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
    }
  );

  it('omits X-Forwarded-For entirely when there is no client IP', async () => {
    const ev = event({ clientIp: null });

    await expect(actions.default(ev as any)).rejects.toMatchObject({ status: 303 });

    const [, init] = fetchMock.mock.calls[0];
    expect('X-Forwarded-For' in init.headers).toBe(false);
  });

  it('skips the API call entirely when there is no session token, but still clears the cookie and redirects', async () => {
    const ev = event({ sessionToken: null });

    await expect(actions.default(ev as any)).rejects.toMatchObject({ status: 303, location: '/login' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ev.cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
  });

  it(
    'still clears the cookie and redirects to /login when the API call fails — a user clicking ' +
      '"sign out" on an unreachable API must not stay signed in with a working session cookie',
    async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const ev = event();

      await expect(actions.default(ev as any)).rejects.toMatchObject({ status: 303, location: '/login' });

      expect(ev.cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
    }
  );
});
