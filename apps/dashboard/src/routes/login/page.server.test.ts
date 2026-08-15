import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env as privateEnv } from '../../tests/env-private-stub';
import { SESSION_COOKIE_PATH } from '$lib/session';
import { actions } from './+page.server';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const fetchMock = vi.fn();

// clientIp defaults to a fixed, non-null value so every test but the
// dedicated "omits X-Forwarded-For" one exercises the header-present path
// without having to say so.
function formEvent(fields: Record<string, string>, clientIp: string | null = '203.0.113.7') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const cookies = { set: vi.fn() };
  return { request: { formData: async () => fd }, cookies, locals: { clientIp } };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // privateEnv.ts reads COOKIE_SECURE fresh on every call (not cached at
  // import time) — see api.test.ts's identical READ_TOKEN pattern.
  delete privateEnv.COOKIE_SECURE;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('login action', () => {
  it('sets the session cookie and redirects to / on success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ mustChangePassword: false }, 200, { 'set-cookie': 'fk_session=tok-abc; Path=/; HttpOnly' })
    );
    // Leading/trailing whitespace on the email proves .trim() actually runs
    // — the full-body assertion below checks for the TRIMMED value, so
    // deleting the .trim() call would leave the untrimmed string in the
    // request body and redden this.
    const event = formEvent({ email: '  a@b.com  ', password: 'hunter2' }, '203.0.113.7');

    await expect(actions.default(event as any)).rejects.toMatchObject({ status: 303, location: '/' });

    // Full request assertion (url, method, headers, body) — not just "fetch
    // was called". A prior version of this suite only ever checked
    // fetchMock with `not.toHaveBeenCalled()`, which let the endpoint path
    // be renamed, or the whole call rewritten as a GET with the password in
    // the query string, and still pass 9/9. This kills both, plus the
    // .trim() survivor above.
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
      body: JSON.stringify({ email: 'a@b.com', password: 'hunter2' }),
    });

    // Full options object, not `objectContaining` — pins `maxAge` too, which
    // a partial match would let silently regress to e.g. `maxAge: 1`.
    expect(event.cookies.set).toHaveBeenCalledWith('fk_session', 'tok-abc', {
      path: SESSION_COOKIE_PATH,
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 60 * 60,
    });
  });

  it('omits X-Forwarded-For entirely when there is no client IP', async () => {
    // An empty header is worse than none — see fetchMe's identical case in
    // lib/server/session.test.ts. Mirrors that test's shape.
    fetchMock.mockResolvedValue(
      jsonResponse({ mustChangePassword: false }, 200, { 'set-cookie': 'fk_session=tok-abc; Path=/; HttpOnly' })
    );
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' }, null);

    await expect(actions.default(event as any)).rejects.toMatchObject({ status: 303 });

    const [, init] = fetchMock.mock.calls[0];
    expect('X-Forwarded-For' in init.headers).toBe(false);
  });

  it('redirects to /change-password when the API says a reset is required', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ mustChangePassword: true }, 200, { 'set-cookie': 'fk_session=tok-abc; Path=/; HttpOnly' })
    );
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' });

    await expect(actions.default(event as any)).rejects.toMatchObject({
      status: 303,
      location: '/change-password',
    });
  });

  it('returns a 400 fail when email or password is empty, without calling the API', async () => {
    const event = formEvent({ email: '', password: '' });

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a 401 fail with the generic message on bad credentials — never names which field was wrong', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    const event = formEvent({ email: 'a@b.com', password: 'wrong' });

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(401);
    expect(result.data.error).toBe('Invalid email or password.');
  });

  it('returns a 429 fail with a rate-limit-specific message, not the generic credential one', async () => {
    // A 429 must not masquerade as "Invalid email or password." — it
    // discloses nothing about accounts, only that the shared per-IP budget
    // is exhausted (e.g. a team signing in together on a Monday morning).
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Too Many Requests' }, 429));
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' });

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(429);
    expect(result.data.error).toBe('Too many sign-in attempts. Wait a minute and try again.');
  });

  it('never puts the password in the returned form data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    const event = formEvent({ email: 'a@b.com', password: 'super-secret-value' });

    const result = (await actions.default(event as any)) as any;

    expect(result.data).not.toHaveProperty('password');
    expect(JSON.stringify(result.data)).not.toContain('super-secret-value');
  });

  it('returns a 503 fail when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' });

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(503);
  });

  it('returns a 502 fail when the API responds ok but sets no session cookie', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mustChangePassword: false }, 200));
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' });

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(502);
  });

  it('returns a 502 fail when the API responds 200 with an unparsable body', async () => {
    // Distinct branch from the "no cookie" 502 above: here the cookie header
    // IS present (parseSessionCookie succeeds), but res.json() throws. Proves
    // the cookie is never set on this path — the failure happens before
    // cookies.set is reached.
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' });
    fetchMock.mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'set-cookie': 'fk_session=tok-abc; Path=/; HttpOnly' } })
    );

    const result = (await actions.default(event as any)) as any;

    expect(result.status).toBe(502);
    expect(event.cookies.set).not.toHaveBeenCalled();
  });

  // Deviation from the task-4 brief (recorded in task-4-report.md): the brief's
  // code block reads `process.env.COOKIE_SECURE`, which is untestable here —
  // `process.env` appears nowhere else in src/, every other server module
  // reads $env/dynamic/*, and the test setup only stubs the private env
  // module. These two tests pin both states of the flag directly.
  it('sets a Secure cookie when COOKIE_SECURE=true', async () => {
    privateEnv.COOKIE_SECURE = 'true';
    fetchMock.mockResolvedValue(
      jsonResponse({ mustChangePassword: false }, 200, { 'set-cookie': 'fk_session=tok-abc; Path=/; HttpOnly' })
    );
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' });

    await expect(actions.default(event as any)).rejects.toMatchObject({ status: 303 });

    expect(event.cookies.set).toHaveBeenCalledWith(
      'fk_session',
      'tok-abc',
      expect.objectContaining({ secure: true })
    );
  });

  it('leaves the cookie non-Secure when COOKIE_SECURE is unset', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ mustChangePassword: false }, 200, { 'set-cookie': 'fk_session=tok-abc; Path=/; HttpOnly' })
    );
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' });

    await expect(actions.default(event as any)).rejects.toMatchObject({ status: 303 });

    expect(event.cookies.set).toHaveBeenCalledWith(
      'fk_session',
      'tok-abc',
      expect.objectContaining({ secure: false })
    );
  });
});
