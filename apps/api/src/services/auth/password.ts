import { randomBytes, scrypt, timingSafeEqual, ScryptOptions } from 'crypto';

/**
 * Promisified wrapper around Node's scrypt. Both call sites below always pass
 * cost parameters, so `options` is required — there is no no-options overload
 * to support.
 */
const scryptAsync = (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });

/**
 * scrypt cost parameters. N=16384/r=8/p=1 is the widely-used interactive
 * profile (~16 MiB of memory per hash — comfortably under Node's 32 MiB
 * default `maxmem`, so no explicit maxmem is needed).
 *
 * They are written INTO the encoded hash rather than read from here at verify
 * time. That is the whole point of the encoding: raising the cost later
 * re-hashes new passwords without invalidating every existing one.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

/**
 * Minimum password length. Deliberately length-only, with no character-class
 * rules: NIST SP 800-63B recommends length over composition, and a
 * composition rule pushes users toward `Passw0rd!` patterns.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Hash a password for storage.
 *
 * Format: `scrypt$N$r$p$<base64 salt>$<base64 derived key>`
 * Self-describing on purpose — see the comment on the cost constants.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false — never throws — for ANY malformed `stored` value. A corrupt
 * or legacy row must read as "wrong password", not as a 500 that tells an
 * attacker they found something interesting.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n <= 1 || r <= 0 || p <= 0) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, expected.length, { N: n, r, p });
  } catch {
    // Out-of-range cost parameters make scrypt throw; treat as a bad hash.
    return false;
  }

  // Lengths are equal by construction (we derived `expected.length` bytes),
  // so timingSafeEqual cannot throw here.
  return timingSafeEqual(derived, expected);
}
