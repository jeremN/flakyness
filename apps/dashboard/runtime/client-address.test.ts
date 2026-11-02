import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { configureClientAddress, resolveClientAddress, CLIENT_ADDRESS_HEADER } from './client-address.js';

function fakeRequest(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { headers: { ...headers }, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('resolveClientAddress', () => {
  const trusted = ['10.0.0.2', '10.0.0.3'];

  it('uses the socket address when the socket is not a trusted proxy, whatever X-Forwarded-For says', () => {
    expect(resolveClientAddress('203.0.113.9', '1.1.1.1', trusted)).toBe('203.0.113.9');
  });

  it('takes the rightmost X-Forwarded-For entry from a trusted proxy', () => {
    expect(resolveClientAddress('10.0.0.2', '1.1.1.1, 198.51.100.7', trusted)).toBe('198.51.100.7');
  });

  it('skips trusted proxies from the right, so a chain of two proxies works', () => {
    expect(resolveClientAddress('10.0.0.2', 'spoofed, 198.51.100.7, 10.0.0.3', trusted)).toBe('198.51.100.7');
  });

  it('falls back to the socket address when a trusted proxy sends no X-Forwarded-For', () => {
    expect(resolveClientAddress('10.0.0.2', undefined, trusted)).toBe('10.0.0.2');
    expect(resolveClientAddress('10.0.0.2', ' , ', trusted)).toBe('10.0.0.2');
  });

  it('normalizes IPv4-mapped IPv6 addresses on both sides', () => {
    expect(resolveClientAddress('::ffff:10.0.0.2', '::ffff:198.51.100.7', trusted)).toBe('198.51.100.7');
  });
});

describe('configureClientAddress', () => {
  it('changes nothing when TRUSTED_PROXY_IPS is unset or empty', () => {
    for (const env of [{}, { TRUSTED_PROXY_IPS: '' }, { TRUSTED_PROXY_IPS: ' , ' }] as Record<string, string | undefined>[]) {
      const before = { ...env };
      expect(configureClientAddress(env)).toBeNull();
      expect(env).toEqual(before);
    }
  });

  it.each(['ADDRESS_HEADER', 'XFF_DEPTH'])('refuses TRUSTED_PROXY_IPS combined with %s', (name) => {
    expect(() => configureClientAddress({ TRUSTED_PROXY_IPS: '10.0.0.2', [name]: 'x' })).toThrow(
      new RegExp(`Set TRUSTED_PROXY_IPS or ${name}, not both`)
    );
  });

  it('points ADDRESS_HEADER at the internal header', () => {
    const env: Record<string, string | undefined> = { TRUSTED_PROXY_IPS: '10.0.0.2' };
    configureClientAddress(env);
    expect(env.ADDRESS_HEADER).toBe(CLIENT_ADDRESS_HEADER);
  });

  it('overwrites a forged internal header and ignores X-Forwarded-For from an untrusted socket', () => {
    const pin = configureClientAddress({ TRUSTED_PROXY_IPS: '10.0.0.2' })!;
    const req = fakeRequest('203.0.113.9', { [CLIENT_ADDRESS_HEADER]: '1.1.1.1', 'x-forwarded-for': '1.1.1.1' });
    pin(req);
    expect(req.headers[CLIENT_ADDRESS_HEADER]).toBe('203.0.113.9');
  });

  it('writes the client address a trusted proxy forwarded', () => {
    const pin = configureClientAddress({ TRUSTED_PROXY_IPS: ' 10.0.0.2 ,10.0.0.3' })!;
    const req = fakeRequest('10.0.0.3', { 'x-forwarded-for': '198.51.100.7' });
    pin(req);
    expect(req.headers[CLIENT_ADDRESS_HEADER]).toBe('198.51.100.7');
  });

  it('always sets the header, so adapter-node never sees it missing', () => {
    const pin = configureClientAddress({ TRUSTED_PROXY_IPS: '10.0.0.2' })!;
    const req = fakeRequest('10.0.0.2');
    pin(req);
    expect(req.headers[CLIENT_ADDRESS_HEADER]).toBe('10.0.0.2');
  });
});
