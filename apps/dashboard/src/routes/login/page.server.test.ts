import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env as privateEnv } from '../../tests/env-private-stub';
import { actions } from './+page.server';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const fetchMock = vi.fn();

function formEvent(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const cookies = { set: vi.fn(), delete: vi.fn() };
  return { request: { formData: async () => fd }, cookies };
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
    const event = formEvent({ email: 'a@b.com', password: 'hunter2' });

    await expect(actions.default(event as any)).rejects.toMatchObject({ status: 303, location: '/' });

    expect(event.cookies.set).toHaveBeenCalledWith(
      'fk_session',
      'tok-abc',
      expect.objectContaining({ path: '/', httpOnly: true, sameSite: 'lax' })
    );
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
