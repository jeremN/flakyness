import { describe, it, expect } from 'vitest';
import { scryptSync } from 'crypto';
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

  describe('out-of-range encoded cost parameters', () => {
    // Node's scrypt() treats N:0, r:0, and p:0 as "unset" and silently
    // substitutes ITS OWN defaults (16384/8/1) instead of throwing — so the
    // `n <= 1 || r <= 0 || p <= 0` guard in verifyPassword is not redundant
    // with anything scrypt enforces internally. Each digest below is a REAL
    // scrypt output computed at the default cost, so a verifyPassword that
    // let the zeroed parameter through would silently "verify" it. These
    // prove the guard actually rejects it instead.
    const salt = Buffer.from('0123456789abcdef');
    const defaultDerived = scryptSync(PW, salt, 32, { N: 16384, r: 8, p: 1 });
    const saltB64 = salt.toString('base64');
    const derivedB64 = defaultDerived.toString('base64');

    it.each([
      ['N of 0 (scrypt would silently use its default N)', `scrypt$0$8$1$${saltB64}$${derivedB64}`],
      ['r of 0 (scrypt would silently use its default r)', `scrypt$16384$0$1$${saltB64}$${derivedB64}`],
      ['p of 0 (scrypt would silently use its default p)', `scrypt$16384$8$0$${saltB64}$${derivedB64}`],
    ])('rejects an encoded %s, even against a hash real at the default cost', async (_label, stored) => {
      await expect(verifyPassword(PW, stored)).resolves.toBe(false);
    });
  });

  it('returns false (never throws) when the encoded N is not a power of two and scrypt itself rejects it', async () => {
    // N=3 passes this module's own `n <= 1` guard but fails scrypt's
    // internal "N must be a power of two" validation, which throws
    // synchronously — exercising the try/catch around the verify-time
    // scrypt call.
    await expect(verifyPassword('anything', 'scrypt$3$8$1$c2FsdA==$aGFzaA==')).resolves.toBe(false);
  });

  it("re-derives using the hash's ENCODED cost parameters, not the module's current defaults", async () => {
    // Proves verifyPassword actually reads back N/r/p from the stored
    // string (not the module's N/R/P constants) — the whole point of
    // encoding them, per the format comment above hashPassword.
    const salt = Buffer.from('0123456789abcdef');
    const legacyN = 8192; // deliberately different from the module's current N (16384)
    const derived = scryptSync(PW, salt, 32, { N: legacyN, r: 8, p: 1 });
    const stored = `scrypt$${legacyN}$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
    await expect(verifyPassword(PW, stored)).resolves.toBe(true);
  });

  it('rejects a wrong algorithm label even when the rest of the hash is real', async () => {
    // The 'wrong algorithm label' malformed-hash case above uses a junk
    // digest that never matches regardless, so it can't prove the label
    // check actually gates anything. Here the digest is a REAL scrypt
    // output for the encoded salt/params — if the label check were ever
    // skipped, this would incorrectly verify.
    const salt = Buffer.from('0123456789abcdef');
    const derived = scryptSync(PW, salt, 32, { N: 16384, r: 8, p: 1 });
    const stored = `argon2$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
    await expect(verifyPassword(PW, stored)).resolves.toBe(false);
  });

  it('rejects an encoded empty salt even against a hash real for that empty salt', async () => {
    // scrypt() itself happily accepts a zero-length salt (it doesn't
    // enforce a minimum), so `salt.length === 0` is a real, load-bearing
    // guard — not something the KDF would reject on our behalf. The digest
    // here is a genuine scrypt output computed WITH an empty salt.
    const derived = scryptSync(PW, Buffer.alloc(0), 32, { N: 16384, r: 8, p: 1 });
    const stored = `scrypt$16384$8$1$$${derived.toString('base64')}`;
    await expect(verifyPassword(PW, stored)).resolves.toBe(false);
  });
});
