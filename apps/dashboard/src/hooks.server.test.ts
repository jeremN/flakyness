import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Handle } from '@sveltejs/kit';

// hooks.server.ts reads DASHBOARD_PASSWORD/ADMIN_TOKEN from $env/dynamic/private
// once, at module-evaluation time (see the file's own comment on why: it's a
// one-time startup warning, not a per-request check). To exercise every
// combination we need a *fresh* module instance per test, with the env stub
// populated before that module is evaluated — hence vi.resetModules() +
// dynamic import in each case, rather than a single top-level import.
async function loadHooks(envOverrides: Record<string, string | undefined>): Promise<{ handle: Handle }> {
  vi.resetModules();
  const { env } = await import('./tests/env-private-stub');
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, envOverrides);
  return import('./hooks.server');
}

function makeEvent(headers: Record<string, string> = {}) {
  return {
    request: new Request('http://localhost/flaky', { headers }),
  } as Parameters<Handle>[0]['event'];
}

function basicHeader(userPass: string): string {
  return `Basic ${Buffer.from(userPass).toString('base64')}`;
}

describe('hooks.server handle (Basic Auth gate)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves unchanged when DASHBOARD_PASSWORD is unset (no regression)', async () => {
    const { handle } = await loadHooks({ DASHBOARD_PASSWORD: undefined, ADMIN_TOKEN: undefined });
    const resolve = vi.fn().mockResolvedValue(new Response('ok'));
    const response = await handle({ event: makeEvent(), resolve });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('returns 401 with a WWW-Authenticate challenge when no credentials are presented', async () => {
    const { handle } = await loadHooks({ DASHBOARD_PASSWORD: 'hunter2', ADMIN_TOKEN: undefined });
    const resolve = vi.fn();
    const response = await handle({ event: makeEvent(), resolve });

    expect(resolve).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="Flackyness"');
  });

  it('returns 401 for wrong credentials, without calling resolve', async () => {
    const { handle } = await loadHooks({ DASHBOARD_PASSWORD: 'hunter2', ADMIN_TOKEN: undefined });
    const resolve = vi.fn();
    const response = await handle({
      event: makeEvent({ authorization: basicHeader('admin:wrong') }),
      resolve,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it('resolves when correct Basic credentials are presented', async () => {
    const { handle } = await loadHooks({ DASHBOARD_PASSWORD: 'hunter2', ADMIN_TOKEN: undefined });
    const resolve = vi.fn().mockResolvedValue(new Response('ok'));
    const response = await handle({
      event: makeEvent({ authorization: basicHeader('admin:hunter2') }),
      resolve,
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('warns once at startup when ADMIN_TOKEN is set but DASHBOARD_PASSWORD is not', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadHooks({ DASHBOARD_PASSWORD: undefined, ADMIN_TOKEN: 'admin-token' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/DASHBOARD_PASSWORD/);
  });

  it('does not warn when DASHBOARD_PASSWORD is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadHooks({ DASHBOARD_PASSWORD: 'hunter2', ADMIN_TOKEN: 'admin-token' });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when neither ADMIN_TOKEN nor DASHBOARD_PASSWORD is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadHooks({ DASHBOARD_PASSWORD: undefined, ADMIN_TOKEN: undefined });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
