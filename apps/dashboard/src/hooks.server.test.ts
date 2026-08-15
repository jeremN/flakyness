import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isRedirect, type Handle, type Redirect } from '@sveltejs/kit';
import { SESSION_COOKIE, SESSION_COOKIE_PATH } from '$lib/session';
import type { SessionUser, TeamSummary } from './app.d';

vi.mock('$lib/server/session', () => ({
  fetchMe: vi.fn(),
}));

import { fetchMe } from '$lib/server/session';
import { handle } from './hooks.server';

const user: SessionUser = {
  id: 'u1',
  email: 'a@b.c',
  displayName: null,
  isGlobalAdmin: false,
  mustChangePassword: false,
};

const teams: TeamSummary[] = [{ id: 't1', name: 'Team A', role: 'member' }];

function makeEvent(pathname: string, cookie: string | null, clientIp = '203.0.113.7') {
  const store = new Map<string, string>();
  if (cookie) store.set(SESSION_COOKIE, cookie);

  const cookies = {
    get: vi.fn((name: string) => store.get(name)),
    delete: vi.fn((name: string) => store.delete(name)),
  };

  return {
    event: {
      cookies,
      getClientAddress: vi.fn(() => clientIp),
      url: new URL(`http://localhost${pathname}`),
      locals: {} as App.Locals,
    } as unknown as Parameters<Handle>[0]['event'],
    cookies,
  };
}

beforeEach(() => {
  vi.mocked(fetchMe).mockReset();
});

describe('hooks.server handle (session gate)', () => {
  it('redirects an anonymous request to /login', async () => {
    const { event, cookies } = makeEvent('/flaky', null);
    const resolve = vi.fn();

    let caught: unknown;
    try {
      await handle({ event, resolve });
    } catch (e) {
      caught = e;
    }

    expect(isRedirect(caught)).toBe(true);
    expect((caught as Redirect).status).toBe(303);
    expect((caught as Redirect).location).toBe('/login');
    expect(resolve).not.toHaveBeenCalled();
    // The delete is for clearing a token the API rejected — an anonymous
    // caller never presented one, so there is nothing to clear. Firing it
    // anyway would put a spurious Set-Cookie on every anonymous response,
    // including the /login page itself.
    expect(cookies.delete).not.toHaveBeenCalled();
  });

  it('does not redirect the /login page itself (no loop)', async () => {
    const { event } = makeEvent('/login', null);
    const resolve = vi.fn().mockResolvedValue(new Response('login page'));

    const response = await handle({ event, resolve });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('clears a cookie the API rejects (401/403), so a stale session does not retry forever', async () => {
    vi.mocked(fetchMe).mockResolvedValue({ ok: false, rejected: true });
    const { event, cookies } = makeEvent('/flaky', 'stale-token');
    const resolve = vi.fn();

    try {
      await handle({ event, resolve });
    } catch {
      // Expected: a token the API rejects redirects to /login (asserted
      // separately). This test only cares that the stale cookie was cleared.
    }

    expect(cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
    // A rejected token must not survive into locals — a downstream client
    // built from a stale sessionToken would hand the API a token it just
    // refused, turning a clean re-login into a 401 on every request.
    expect(event.locals.sessionToken).toBeNull();
  });

  // Task 8 fix round 1 (CRITICAL #1): a transient failure must NOT destroy a
  // live session's cookie. fetchMe (unit-tested separately in
  // lib/server/session.test.ts) is what maps a 401/403 to `rejected: true`
  // and a 429/5xx/network-error/timeout to `rejected: false` — these three
  // tests prove hooks.server.ts's OWN half of the contract: given each of
  // those "no answer" shapes, it must fail closed for this one request
  // (still redirect to /login, locals.user stays null) WITHOUT deleting the
  // cookie, so the same browser is signed back in the moment the API
  // recovers. Before this fix all three collapsed into a bare `null` and the
  // cookie was deleted just like the 401/403 case above — proved by
  // reverting `fetchMe` to `if (!res.ok) return null` (which flows through
  // as a plain falsy value here): all three of these tests then fail while
  // the 401/403 test above keeps passing.
  it.each([
    ['429 rate-limited', { ok: false, rejected: false }],
    ['503 the API is erroring', { ok: false, rejected: false }],
    ['a network error/timeout reaching the API', { ok: false, rejected: false }],
  ] as const)('does NOT clear the cookie on %s — redirects, but the session survives', async (_label, meResult) => {
    vi.mocked(fetchMe).mockResolvedValue(meResult);
    const { event, cookies } = makeEvent('/flaky', 'still-good-token');
    const resolve = vi.fn();

    let caught: unknown;
    try {
      await handle({ event, resolve });
    } catch (e) {
      caught = e;
    }

    // Fail-closed rendering is unchanged: this request still redirects and
    // never resolves the protected route.
    expect(isRedirect(caught)).toBe(true);
    expect((caught as Redirect).location).toBe('/login');
    expect(resolve).not.toHaveBeenCalled();
    expect(event.locals.user).toBeNull();
    // The only thing that changes from the 401/403 case: the cookie stays.
    expect(cookies.delete).not.toHaveBeenCalled();
  });

  it('populates locals.user for a valid session', async () => {
    vi.mocked(fetchMe).mockResolvedValue({ ok: true, user, teams });
    // Deliberately distinct from every other test's default fixture IP
    // (203.0.113.7): if the hook ever hardcoded a literal instead of
    // threading event.getClientAddress() through, a fixture-matching literal
    // would pass this assertion by coincidence. A value unique to this test
    // can only match if the real wiring is exercised.
    const clientIp = '198.51.100.9';
    const { event } = makeEvent('/flaky', 'good-token', clientIp);
    const resolve = vi.fn().mockResolvedValue(new Response('ok'));

    await handle({ event, resolve });

    expect(event.locals.user).toEqual(user);
    expect(event.locals.teams).toEqual(teams);
    expect(event.locals.sessionToken).toBe('good-token');
    expect(event.locals.clientIp).toBe(clientIp);
    // Task 0 exists to stop every /auth/me call from keying to the dashboard
    // container's own socket address — that guarantee only holds if the real
    // browser IP is what's actually handed to fetchMe, not just stored on
    // locals for someone else to forward later.
    expect(fetchMe).toHaveBeenCalledWith('good-token', clientIp);
  });

  it('redirects a must_change_password user to /change-password', async () => {
    const forced = { ...user, mustChangePassword: true };
    vi.mocked(fetchMe).mockResolvedValue({ ok: true, user: forced, teams });
    const { event } = makeEvent('/flaky', 'good-token');
    const resolve = vi.fn();

    let caught: unknown;
    try {
      await handle({ event, resolve });
    } catch (e) {
      caught = e;
    }

    expect(isRedirect(caught)).toBe(true);
    expect((caught as Redirect).status).toBe(303);
    expect((caught as Redirect).location).toBe('/change-password');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lets that user reach /change-password and /logout', async () => {
    const forced = { ...user, mustChangePassword: true };
    vi.mocked(fetchMe).mockResolvedValue({ ok: true, user: forced, teams });

    for (const pathname of ['/change-password', '/logout']) {
      const { event } = makeEvent(pathname, 'good-token');
      const resolve = vi.fn().mockResolvedValue(new Response('ok'));

      const response = await handle({ event, resolve });

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
    }
  });

  it('fails CLOSED when the API is unreachable (redirects to /login, never renders)', async () => {
    vi.mocked(fetchMe).mockResolvedValue({ ok: false, rejected: false });
    const { event } = makeEvent('/flaky', 'good-token');
    const resolve = vi.fn().mockResolvedValue(new Response('secret page'));

    let caught: unknown;
    try {
      await handle({ event, resolve });
    } catch (e) {
      caught = e;
    }

    expect(isRedirect(caught)).toBe(true);
    expect((caught as Redirect).status).toBe(303);
    expect((caught as Redirect).location).toBe('/login');
    expect(resolve).not.toHaveBeenCalled();
  });

  // Task 8 fix round 1 (IMPORTANT #3): without a Cache-Control: no-store on
  // document responses, Chromium's bfcache can restore an authenticated page
  // verbatim after sign-out on a back navigation — see auth.spec.ts's
  // back-button test, which exercises this end to end in a real browser.
  it('marks an HTML document response no-store, so bfcache cannot resurrect it after sign-out', async () => {
    vi.mocked(fetchMe).mockResolvedValue({ ok: true, user, teams });
    const { event } = makeEvent('/flaky', 'good-token');
    const resolve = vi
      .fn()
      .mockResolvedValue(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));

    const response = await handle({ event, resolve });

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('leaves a non-HTML response (a static asset) alone — those must stay cacheable', async () => {
    vi.mocked(fetchMe).mockResolvedValue({ ok: true, user, teams });
    const { event } = makeEvent('/flaky', 'good-token');
    const resolve = vi
      .fn()
      .mockResolvedValue(
        new Response('body{color:red}', { headers: { 'content-type': 'text/css', 'cache-control': 'immutable' } })
      );

    const response = await handle({ event, resolve });

    expect(response.headers.get('Cache-Control')).toBe('immutable');
  });
});
