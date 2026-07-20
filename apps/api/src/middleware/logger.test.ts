import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { requestLogger, logError } from './logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestLogger', () => {
  it('routes the completion log to a console fn by status class', async () => {
    const info: string[] = [];
    const warn: string[] = [];
    const error: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m) => { info.push(String(m)); });
    vi.spyOn(console, 'warn').mockImplementation((m) => { warn.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation((m) => { error.push(String(m)); });

    const app = new Hono();
    app.use('*', requestLogger());
    app.get('/ok', (c) => c.json({}, 200));
    app.get('/missing', (c) => c.json({}, 404));
    app.get('/broken', (c) => c.json({}, 500));

    await app.request('/ok');
    await app.request('/missing');
    await app.request('/broken');

    const completed = (arr: string[]) => arr.filter((l) => l.includes('Request completed'));
    // 200 -> info (console.log), 404 -> warn, 500 -> error
    expect(completed(info).some((l) => l.includes('200'))).toBe(true);
    expect(completed(warn).some((l) => l.includes('404'))).toBe(true);
    expect(completed(error).some((l) => l.includes('500'))).toBe(true);
    // and not misrouted: the 200 completion is not a warning
    expect(completed(warn).some((l) => l.includes('200'))).toBe(false);
  });

  it('sets a requestId on context and logs the request start', async () => {
    const info: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m) => { info.push(String(m)); });

    let capturedId: unknown;
    const app = new Hono();
    app.use('*', requestLogger());
    // Annotate as bare `Context` (Env = any) so `c.get('requestId')` type-checks
    // the same way it does in logger.ts itself; a concrete `new Hono()` env
    // narrows the valid keys to Hono's ContextVariableMap and rejects it.
    app.get('/x', (c: Context) => {
      capturedId = c.get('requestId');
      return c.json({});
    });
    await app.request('/x');

    expect(typeof capturedId).toBe('string');
    expect((capturedId as string).length).toBeGreaterThan(0);
    expect(info.some((l) => l.includes('Request started'))).toBe(true);
  });
});

describe('logError', () => {
  const fakeCtx = () =>
    ({ get: () => 'rid-abc', req: { method: 'POST', path: '/api/v1/x' } }) as unknown as Context;

  it('includes context and the error message (dev format)', () => {
    const out: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m) => { out.push(String(m)); });

    logError(new Error('boom-message'), fakeCtx());

    const line = out.join('\n');
    expect(line).toContain('POST');
    expect(line).toContain('/api/v1/x');
    expect(line).toContain('rid-abc');
    expect(line).toContain('boom-message');
    // NOTE: the dev formatLog prints only error.message, not error.name — name
    // is asserted in the production-JSON test below.
  });

  it('omits the stack trace in production (no path leak)', async () => {
    vi.resetModules();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { logError: prodLogError } = await import('./logger');
      const out: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((m) => { out.push(String(m)); });

      const err = new Error('prod-msg');
      err.stack = 'Error: prod-msg\n    at /secret/internal/path.ts:99:7';
      prodLogError(err, fakeCtx());

      const raw = out[0];
      const parsed = JSON.parse(raw); // production format is JSON
      expect(parsed.error.name).toBe('Error');
      expect(parsed.error.message).toBe('prod-msg');
      expect(parsed.error.stack).toBeUndefined();
      expect(raw).not.toContain('/secret/internal/path.ts');
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      vi.resetModules();
    }
  });
});

describe('log format', () => {
  it('is JSON in production and a pretty non-JSON line in dev', async () => {
    // Production: re-import under NODE_ENV=production.
    vi.resetModules();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let prodLine = '';
    try {
      const { logger } = await import('./logger');
      const out: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((m) => { out.push(String(m)); });
      logger.info('hello', { path: '/p' });
      prodLine = out[0];
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      vi.resetModules();
    }
    expect(() => JSON.parse(prodLine)).not.toThrow();

    // Dev: default test env (NODE_ENV=test !== 'production' -> isDev).
    const { logger: devLogger } = await import('./logger');
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m) => { out.push(String(m)); });
    devLogger.info('hello', { path: '/p' });
    const devLine = out[0];

    expect(devLine).toMatch(/^\[.*\] INFO/);
    let devIsJson = true;
    try { JSON.parse(devLine); } catch { devIsJson = false; }
    expect(devIsJson).toBe(false);
  });
});
