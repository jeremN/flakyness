import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isRedirect, type Handle, type Redirect } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/session';
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

function makeEvent(pathname: string, cookie: string | null) {
  const store = new Map<string, string>();
  if (cookie) store.set(SESSION_COOKIE, cookie);

  const cookies = {
    get: vi.fn((name: string) => store.get(name)),
    delete: vi.fn((name: string) => store.delete(name)),
  };

  return {
    event: {
      cookies,
      getClientAddress: vi.fn(() => '203.0.113.7'),
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

  it('clears a cookie the API rejects, so a stale session does not retry forever', async () => {
    vi.mocked(fetchMe).mockResolvedValue(null);
    const { event, cookies } = makeEvent('/flaky', 'stale-token');
    const resolve = vi.fn();

    try {
      await handle({ event, resolve });
    } catch {
      // Expected: a token the API rejects redirects to /login (asserted
      // separately). This test only cares that the stale cookie was cleared.
    }

    expect(cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: '/' });
    // A rejected token must not survive into locals — a downstream client
    // built from a stale sessionToken would hand the API a token it just
    // refused, turning a clean re-login into a 401 on every request.
    expect(event.locals.sessionToken).toBeNull();
  });

  it('populates locals.user for a valid session', async () => {
    vi.mocked(fetchMe).mockResolvedValue({ user, teams });
    const { event } = makeEvent('/flaky', 'good-token');
    const resolve = vi.fn().mockResolvedValue(new Response('ok'));

    await handle({ event, resolve });

    expect(event.locals.user).toEqual(user);
    expect(event.locals.teams).toEqual(teams);
    expect(event.locals.sessionToken).toBe('good-token');
    expect(event.locals.clientIp).toBe('203.0.113.7');
    // Task 0 exists to stop every /auth/me call from keying to the dashboard
    // container's own socket address — that guarantee only holds if the real
    // browser IP is what's actually handed to fetchMe, not just stored on
    // locals for someone else to forward later.
    expect(fetchMe).toHaveBeenCalledWith('good-token', '203.0.113.7');
  });

  it('redirects a must_change_password user to /change-password', async () => {
    const forced = { ...user, mustChangePassword: true };
    vi.mocked(fetchMe).mockResolvedValue({ user: forced, teams });
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
    vi.mocked(fetchMe).mockResolvedValue({ user: forced, teams });

    for (const pathname of ['/change-password', '/logout']) {
      const { event } = makeEvent(pathname, 'good-token');
      const resolve = vi.fn().mockResolvedValue(new Response('ok'));

      const response = await handle({ event, resolve });

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
    }
  });

  it('fails CLOSED when the API is unreachable (redirects to /login, never renders)', async () => {
    vi.mocked(fetchMe).mockResolvedValue(null);
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
});
