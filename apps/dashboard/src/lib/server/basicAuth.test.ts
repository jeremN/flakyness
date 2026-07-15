import { describe, it, expect } from 'vitest';
import { checkBasicAuth } from './basicAuth';

function basicHeader(userPass: string): string {
  return `Basic ${Buffer.from(userPass).toString('base64')}`;
}

describe('checkBasicAuth', () => {
  it('accepts a valid password, ignoring the username', () => {
    expect(checkBasicAuth(basicHeader('admin:hunter2'), 'hunter2')).toBe(true);
    expect(checkBasicAuth(basicHeader('anyone:hunter2'), 'hunter2')).toBe(true);
    expect(checkBasicAuth(basicHeader(':hunter2'), 'hunter2')).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(checkBasicAuth(basicHeader('admin:wrong'), 'hunter2')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(checkBasicAuth(null, 'hunter2')).toBe(false);
    expect(checkBasicAuth(undefined, 'hunter2')).toBe(false);
    expect(checkBasicAuth('', 'hunter2')).toBe(false);
  });

  it('rejects a malformed header', () => {
    // Wrong scheme.
    expect(checkBasicAuth(`Bearer ${Buffer.from('admin:hunter2').toString('base64')}`, 'hunter2')).toBe(
      false
    );
    // Not base64 at all / decodes to something with no `:` separator.
    expect(checkBasicAuth('Basic ###not-base64###', 'hunter2')).toBe(false);
    // No password segment.
    expect(checkBasicAuth(`Basic ${Buffer.from('no-colon-here').toString('base64')}`, 'hunter2')).toBe(
      false
    );
    // No scheme/space at all.
    expect(checkBasicAuth('garbage', 'hunter2')).toBe(false);
  });

  it('never matches an empty expected password, even against an empty presented password', () => {
    expect(checkBasicAuth(basicHeader('admin:'), '')).toBe(false);
    expect(checkBasicAuth(basicHeader('admin:hunter2'), '')).toBe(false);
  });

  it('is case-insensitive on the Basic scheme name', () => {
    const encoded = Buffer.from('admin:hunter2').toString('base64');
    expect(checkBasicAuth(`basic ${encoded}`, 'hunter2')).toBe(true);
    expect(checkBasicAuth(`BASIC ${encoded}`, 'hunter2')).toBe(true);
  });
});
