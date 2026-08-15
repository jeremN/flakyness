import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env as privateEnv } from '../../tests/env-private-stub';
import { SESSION_COOKIE_PATH } from '$lib/session';
import { actions, load } from './+page.server';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const fetchMock = vi.fn();

// clientIp and sessionToken default to fixed, non-null values so every test
// but the dedicated "omits X-Forwarded-For" one exercises the header-present
// path without having to say so. sessionToken deliberately differs from the
// fresh token the mocked API returns in every success-path test, so a bug
// that re-sets the OLD token (rather than lifting the new one from
// set-cookie) would still be visible as "the assertion below is wrong",
// not accidentally pass by both values matching.
function formEvent(
  fields: Record<string, string>,
  opts: { clientIp?: string | null; sessionToken?: string | null } = {}
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const cookies = { set: vi.fn() };
  const clientIp = opts.clientIp === undefined ? '203.0.113.7' : opts.clientIp;
  const sessionToken = opts.sessionToken === undefined ? 'sess-old-abc' : opts.sessionToken;
  return { request: { formData: async () => fd }, cookies, locals: { clientIp, sessionToken } };
}

function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    currentPassword: 'current-secret-1',
    newPassword: 'brand-new-secret-1',
    confirmPassword: 'brand-new-secret-1',
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  delete privateEnv.COOKIE_SECURE;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('change-password load', () => {
  it('returns forced: true when locals.user.mustChangePassword is true', () => {
    const result = load({ locals: { user: { mustChangePassword: true } } } as any) as { forced: boolean };
    expect(result.forced).toBe(true);
  });

  it('returns forced: false when locals.user.mustChangePassword is false', () => {
    const result = load({ locals: { user: { mustChangePassword: false } } } as any) as { forced: boolean };
    expect(result.forced).toBe(false);
  });

  it('returns forced: false when there is no signed-in user', () => {
    const result = load({ locals: { user: null } } as any) as { forced: boolean };
    expect(result.forced).toBe(false);
  });
});

describe('change-password action', () => {
  it(
    'replaces the session cookie with the token the API re-issues, forwards ' +
      'X-Forwarded-For, and redirects to /',
    async () => {
      // Deliberately distinct from formEvent's default fixture IP
      // (203.0.113.7 — reused by nearly every other test in this file): if
      // the action ever hardcoded a literal instead of threading
      // locals.clientIp through, a fixture-matching literal would pass this
      // assertion by coincidence. A value unique to this test can only match
      // if the real wiring is exercised. Mirrors login/page.server.test.ts
      // and hooks.server.test.ts's identical fix.
      const clientIp = '198.51.100.9';
      const event = formEvent(validFields(), { clientIp, sessionToken: 'sess-old-abc' });
      fetchMock.mockResolvedValue(
        jsonResponse({ success: true }, 200, { 'set-cookie': 'fk_session=sess-new-xyz; Path=/; HttpOnly' })
      );

      await expect(actions.default(event as any)).rejects.toMatchObject({ status: 303, location: '/' });

      // Full request assertion — url, method, headers (including the
      // forwarded session cookie), and body. Proves the OLD token is sent
      // to authenticate the request, and that confirmPassword is never
      // forwarded to the API (the API schema only accepts
      // currentPassword/newPassword).
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/api/v1/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'fk_session=sess-old-abc',
          'X-Forwarded-For': clientIp,
        },
        body: JSON.stringify({ currentPassword: 'current-secret-1', newPassword: 'brand-new-secret-1' }),
      });

      // The crux of this action: must be the NEW token lifted from the
      // API's set-cookie, never the old one the request was sent with.
      // Full options object (not objectContaining), pinning `maxAge` too.
      expect(event.cookies.set).toHaveBeenCalledWith('fk_session', 'sess-new-xyz', {
        path: SESSION_COOKIE_PATH,
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 7 * 24 * 60 * 60,
      });
      expect(event.cookies.set).not.toHaveBeenCalledWith('fk_session', 'sess-old-abc', expect.anything());
    }
  );

  it('omits X-Forwarded-For entirely when there is no client IP', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true }, 200, { 'set-cookie': 'fk_session=sess-new-xyz; Path=/; HttpOnly' })
    );
    const event = formEvent(validFields(), { clientIp: null });

    await expect(actions.default(event as any)).rejects.toMatchObject({ status: 303 });

    const [, init] = fetchMock.mock.calls[0];
    expect('X-Forwarded-For' in init.headers).toBe(false);
  });

  it("rejects a new password shorter than 12 characters before calling the API", async () => {
    const event = formEvent(validFields({ newPassword: 'short-pw', confirmPassword: 'short-pw' }));

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(400);
    expect(result.data.error).toBe('New password must be at least 12 characters.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation without calling the API', async () => {
    const event = formEvent(validFields({ confirmPassword: 'does-not-match-1' }));

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(400);
    expect(result.data.error).toBe('New password and confirmation do not match.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty current password without calling the API', async () => {
    const event = formEvent(validFields({ currentPassword: '' }));

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with the API's message when the current password is wrong", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Current password is incorrect' }, 401));
    const event = formEvent(validFields());

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(401);
    expect(result.data.error).toBe('Current password is incorrect');
    expect(event.cookies.set).not.toHaveBeenCalled();
  });

  it('returns a 429 fail with a rate-limit-specific message, not the generic one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Too Many Requests' }, 429));
    const event = formEvent(validFields());

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(429);
    expect(result.data.error).toBe('Too many attempts. Wait a minute and try again.');
  });

  it('returns a 503 fail when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const event = formEvent(validFields());

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(503);
  });

  it('returns a 502 fail when the API responds ok but sets no session cookie', async () => {
    // Distinct branch from the crux of this action: the API says success but
    // — for whatever reason — the response carries no new session. Redirecting
    // anyway here would leave the browser holding the now-revoked OLD token,
    // reproducing exactly the "changing my password broke my account" bug
    // this task exists to avoid.
    fetchMock.mockResolvedValue(jsonResponse({ success: true }, 200));
    const event = formEvent(validFields());

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(502);
    expect(event.cookies.set).not.toHaveBeenCalled();
  });

  it('never puts any password in the returned form data on a local validation failure', async () => {
    const event = formEvent(validFields({ newPassword: 'too-short', confirmPassword: 'too-short' }));

    const result = (await actions.default(event as any)) as any;

    expect(result.data).not.toHaveProperty('currentPassword');
    expect(result.data).not.toHaveProperty('newPassword');
    expect(result.data).not.toHaveProperty('confirmPassword');
    expect(JSON.stringify(result.data)).not.toContain('current-secret-1');
    expect(JSON.stringify(result.data)).not.toContain('too-short');
  });

  it('never puts any password in the returned form data on an API failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Current password is incorrect' }, 401));
    const event = formEvent(validFields());

    const result = (await actions.default(event as any)) as any;

    expect(result.data).not.toHaveProperty('currentPassword');
    expect(result.data).not.toHaveProperty('newPassword');
    expect(result.data).not.toHaveProperty('confirmPassword');
    expect(JSON.stringify(result.data)).not.toContain('current-secret-1');
    expect(JSON.stringify(result.data)).not.toContain('brand-new-secret-1');
  });

  it('fails closed with a 401 rather than sending a request when there is no session token', async () => {
    // Not reachable through hooks.server.ts's gate in practice, but proves
    // the action does not build a Cookie header out of `null`.
    const event = formEvent(validFields(), { sessionToken: null });

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sets a Secure cookie when COOKIE_SECURE=true', async () => {
    privateEnv.COOKIE_SECURE = 'true';
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true }, 200, { 'set-cookie': 'fk_session=sess-new-xyz; Path=/; HttpOnly' })
    );
    const event = formEvent(validFields());

    await expect(actions.default(event as any)).rejects.toMatchObject({ status: 303 });

    expect(event.cookies.set).toHaveBeenCalledWith(
      'fk_session',
      'sess-new-xyz',
      expect.objectContaining({ secure: true })
    );
  });
});
