import { randomBytes } from 'crypto';

export const TEAM_ROLES = ['team_admin', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * A show-once temporary password for an admin-provisioned account.
 *
 * base64url of 18 random bytes = 24 characters, 144 bits — twice the length
 * MIN_PASSWORD_LENGTH demands, and URL-safe so it survives a copy/paste out
 * of a terminal, a form field, or a chat message without escaping surprises.
 * Sourced from `crypto.randomBytes` (a CSPRNG), never `Math.random()` — a
 * generated credential is a security boundary, not just a UI nicety.
 */
export function generateTempPassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Guard against removing (or demoting) the final global admin.
 *
 * An install with zero global admins cannot create one back through the API —
 * `POST /admin/users` is itself global-admin-gated — so the only recovery is
 * hand-editing Postgres. Refusing on a count of 0 as well as 1 is deliberate:
 * a count we cannot explain is a reason to stop, not to proceed.
 */
export function canRemoveGlobalAdmin(currentGlobalAdminCount: number): boolean {
  return currentGlobalAdminCount > 1;
}

/** Login identity is case-insensitive and whitespace-insensitive. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
