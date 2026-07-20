import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { getClientIp } from './rate-limit';

// Build the minimal shape getClientIp reads: c.env.incoming.socket.remoteAddress
// and c.req.header('x-forwarded-for').
function fakeCtx(opts: { socketIp?: string; xff?: string }): Context {
  return {
    env: opts.socketIp
      ? { incoming: { socket: { remoteAddress: opts.socketIp } } }
      : {},
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'x-forwarded-for' ? opts.xff : undefined,
    },
  } as unknown as Context;
}

describe('getClientIp', () => {
  const original = process.env.TRUSTED_PROXY_IPS;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY_IPS;
    else process.env.TRUSTED_PROXY_IPS = original;
  });

  it('uses the socket IP and ignores X-Forwarded-For when no proxy is trusted', () => {
    delete process.env.TRUSTED_PROXY_IPS;
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '9.9.9.9' }))).toBe('1.2.3.4');
  });

  it('returns "unknown" when there is no socket IP', () => {
    delete process.env.TRUSTED_PROXY_IPS;
    expect(getClientIp(fakeCtx({ xff: '9.9.9.9' }))).toBe('unknown');
  });

  it('honours X-Forwarded-For when the socket IP is a trusted proxy', () => {
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4, 5.5.5.5';
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('ignores X-Forwarded-For when the socket IP is NOT trusted (spoofing guard)', () => {
    process.env.TRUSTED_PROXY_IPS = '5.5.5.5';
    // Socket 1.2.3.4 is not in the trusted list, so the client's spoofed
    // X-Forwarded-For must be ignored and the real socket IP used.
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '9.9.9.9' }))).toBe('1.2.3.4');
  });
});
