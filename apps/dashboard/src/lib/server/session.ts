import { env } from '$env/dynamic/public';
import { SESSION_COOKIE } from '../session';
import type { SessionUser, TeamSummary } from '../../app.d';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

/**
 * Validate a session token against the API and return who it belongs to.
 *
 * Returns null for an invalid/expired session AND for an unreachable API. The
 * dashboard is not the security boundary — when it cannot confirm an identity
 * it must fail closed, and the caller redirects to /login. A five-second
 * timeout keeps a hung API from hanging every page load.
 */
export async function fetchMe(
  sessionToken: string,
  clientIp: string | null
): Promise<{ user: SessionUser; teams: TeamSummary[] } | null> {
  try {
    const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionToken}` };
    // Delta §D1.2. This call runs in hooks.server.ts on EVERY request, so it is
    // the single largest contributor to the shared-bucket problem Task 0 fixes.
    if (clientIp) headers['X-Forwarded-For'] = clientIp;

    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { user: SessionUser; teams: TeamSummary[] };
  } catch {
    return null;
  }
}
