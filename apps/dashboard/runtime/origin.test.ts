import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { configureOrigin, parseOrigin, PROTOCOL_HEADER, HOST_HEADER } from './origin.js';

function fakeRequest(headers: Record<string, string> = {}): IncomingMessage {
  return { headers: { ...headers } } as unknown as IncomingMessage;
}

describe('parseOrigin', () => {
  it('keeps a non-default port in the host', () => {
    expect(parseOrigin('http://localhost:3000')).toEqual({ protocol: 'http', host: 'localhost:3000' });
  });

  it('drops the default port, as browsers do in the Origin header', () => {
    expect(parseOrigin('https://flaky.example.com:443')).toEqual({ protocol: 'https', host: 'flaky.example.com' });
  });

  it('accepts one trailing slash', () => {
    expect(parseOrigin('https://flaky.example.com/')).toEqual({ protocol: 'https', host: 'flaky.example.com' });
  });

  it.each([
    ['no scheme', 'localhost:3000'],
    ['not a URL', 'flaky'],
    ['a path', 'https://example.com/dashboard'],
    ['a query', 'https://example.com?x=1'],
    ['a fragment', 'https://example.com/#top'],
    ['credentials', 'https://user:pw@example.com'],
    ['a non-http scheme', 'ftp://example.com'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseOrigin(value)).toThrow(/^ORIGIN must/);
  });
});

describe('configureOrigin', () => {
  it('changes nothing when ORIGIN is unset or empty', () => {
    for (const env of [{}, { ORIGIN: '' }] as Record<string, string | undefined>[]) {
      const before = { ...env };
      expect(configureOrigin(env)).toBeNull();
      expect(env).toEqual(before);
    }
  });

  it('points adapter-node at the internal headers', () => {
    const env: Record<string, string | undefined> = { ORIGIN: 'http://localhost:3000' };
    configureOrigin(env);
    expect(env.PROTOCOL_HEADER).toBe(PROTOCOL_HEADER);
    expect(env.HOST_HEADER).toBe(HOST_HEADER);
  });

  it('writes ORIGIN into the internal headers and overwrites client values', () => {
    const pin = configureOrigin({ ORIGIN: 'https://flaky.example.com' });
    const req = fakeRequest({
      host: 'evil.example',
      [PROTOCOL_HEADER]: 'http',
      [HOST_HEADER]: 'evil.example',
    });
    pin!(req);
    expect(req.headers[PROTOCOL_HEADER]).toBe('https');
    expect(req.headers[HOST_HEADER]).toBe('flaky.example.com');
    // The real Host header stays as sent: only the origin headers are pinned.
    expect(req.headers.host).toBe('evil.example');
  });

  it.each(['PROTOCOL_HEADER', 'HOST_HEADER', 'PORT_HEADER'])('refuses ORIGIN combined with %s', (name) => {
    const env = { ORIGIN: 'http://localhost:3000', [name]: 'x-forwarded-whatever' };
    expect(() => configureOrigin(env)).toThrow(`Set ORIGIN or ${name}, not both`);
  });

  it('refuses an invalid ORIGIN before it touches the environment', () => {
    const env: Record<string, string | undefined> = { ORIGIN: 'https://example.com/app' };
    expect(() => configureOrigin(env)).toThrow(/^ORIGIN must/);
    expect(env.PROTOCOL_HEADER).toBeUndefined();
  });
});
