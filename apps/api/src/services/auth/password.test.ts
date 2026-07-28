import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './password';

describe('password hashing (scrypt)', () => {
  const PW = 'correct horse battery staple';

  it('never stores the password in the encoded hash', async () => {
    const stored = await hashPassword(PW);
    expect(stored).not.toContain(PW);
  });

  it('encodes the parameters so a future cost bump stays verifiable', async () => {
    const stored = await hashPassword(PW);
    const parts = stored.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    // N, r, p all parse as positive integers.
    expect(Number(parts[1])).toBeGreaterThan(1);
    expect(Number(parts[2])).toBeGreaterThan(0);
    expect(Number(parts[3])).toBeGreaterThan(0);
  });

  it('salts per call — the same password hashes to two different strings', async () => {
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password', async () => {
    expect(await verifyPassword(PW, await hashPassword(PW))).toBe(true);
  });

  it('rejects a wrong password', async () => {
    expect(await verifyPassword('wrong password entirely', await hashPassword(PW))).toBe(false);
  });

  it('rejects a near-miss (one character off)', async () => {
    expect(await verifyPassword(PW + 'x', await hashPassword(PW))).toBe(false);
  });

  it('rejects a tampered hash segment', async () => {
    const stored = await hashPassword(PW);
    const parts = stored.split('$');
    // Flip the first byte of the stored digest.
    const digest = Buffer.from(parts[5], 'base64');
    digest[0] ^= 0xff;
    parts[5] = digest.toString('base64');
    expect(await verifyPassword(PW, parts.join('$'))).toBe(false);
  });

  it('rejects a tampered salt (proves the salt is actually fed to the KDF)', async () => {
    const stored = await hashPassword(PW);
    const parts = stored.split('$');
    const salt = Buffer.from(parts[4], 'base64');
    salt[0] ^= 0xff;
    parts[4] = salt.toString('base64');
    expect(await verifyPassword(PW, parts.join('$'))).toBe(false);
  });

  it.each([
    ['empty string', ''],
    ['not our format', 'plaintext-password'],
    ['wrong algorithm label', 'argon2$16384$8$1$c2FsdA==$aGFzaA=='],
    ['too few segments', 'scrypt$16384$8$1$c2FsdA=='],
    ['non-numeric cost', 'scrypt$abc$8$1$c2FsdA==$aGFzaA=='],
    ['empty salt', 'scrypt$16384$8$1$$aGFzaA=='],
    ['empty digest', 'scrypt$16384$8$1$c2FsdA==$'],
  ])('returns false (never throws) for a malformed stored hash: %s', async (_label, stored) => {
    await expect(verifyPassword('anything', stored)).resolves.toBe(false);
  });

  it('exposes a minimum length the routes can share', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });
});
