import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time check of an `Authorization: Basic <base64>` header against an
 * expected password.
 *
 * Pure and dependency-free (no `$env` import) so it can be unit-tested
 * directly, without a running server — see plan 031.
 *
 * The Basic scheme sends `user:password` base64-encoded. Flackyness models a
 * single shared operator credential, not per-user identity (see plan 031's
 * maintenance note), so the username portion is accepted but ignored — any
 * username is fine, only the password after the first `:` is checked.
 *
 * Comparison hashes both sides with SHA-256 before calling
 * `crypto.timingSafeEqual`, mirroring `apps/api/src/middleware/auth.ts`'s
 * `tokensMatch`: this keeps both buffers a fixed 32 bytes (so
 * `timingSafeEqual` never throws on a length mismatch) and avoids leaking the
 * password's length via a plain `===`, which is a timing oracle.
 */
export function checkBasicAuth(authHeader: string | null | undefined, expected: string): boolean {
  // An empty/unset expected password must never match anything — including
  // an empty presented password — so a misconfigured empty secret fails
  // closed, not open.
  if (!expected) return false;
  if (!authHeader) return false;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'basic') return false;

  let decoded: string;
  try {
    decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return false;

  const password = decoded.slice(separatorIndex + 1);

  const candidateHash = createHash('sha256').update(password).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}
