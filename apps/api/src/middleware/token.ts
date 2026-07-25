import { createHash, timingSafeEqual } from 'crypto';

/**
 * Extract the token from a `Bearer <token>` Authorization header.
 * Returns null if the header is missing or not in the expected format.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1];
}

/**
 * Constant-time token comparison, shared by adminAuth and any other route
 * gated by a bearer token compared against a single expected value (e.g. the
 * /metrics endpoint's METRICS_TOKEN, and the admin rate limiter's valid-token
 * exemption).
 *
 * Hashing both tokens before comparing ensures:
 * 1. Both buffers are always the same length (32 bytes SHA-256)
 * 2. No timing leak on token length
 * 3. Uses Node.js native crypto.timingSafeEqual (constant-time)
 *
 * Lives in this DB-free module (rather than auth.ts, which imports the Drizzle
 * `db` and inits a connection pool at load) so the rate limiter can reuse the
 * exact same extraction/compare without dragging the database into its
 * unit tests.
 */
export function tokensMatch(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}
