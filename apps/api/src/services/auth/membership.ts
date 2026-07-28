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
 * As of this plan, `isGlobalAdmin` is a stored attribute with no
 * authorization behind it: every `/admin/*` route (including
 * `POST /admin/users` and `PATCH /admin/users/:id`) is gated by
 * `adminAuth()`, which checks only `ADMIN_TOKEN`. So today, an install with
 * zero global admins is trivially recoverable — a single
 * `PATCH /admin/users/:id {"isGlobalAdmin": true}` call with `ADMIN_TOKEN` —
 * and this guard is not protecting against an unrecoverable state yet.
 *
 * It is still worth enforcing now, because plan 058 is what makes
 * `isGlobalAdmin` load-bearing: once admin routes require a global-admin
 * *session* instead of (or in addition to) `ADMIN_TOKEN`, zero global admins
 * really would be unrecoverable without direct database access. Keeping this
 * invariant true from day one means plan 058 inherits a database that can
 * never reach that state, rather than having to add the guard retroactively
 * on data that may already violate it. Refusing on a count of 0 as well as 1
 * is deliberate: a count we cannot explain is a reason to stop, not to
 * proceed.
 */
export function canRemoveGlobalAdmin(currentGlobalAdminCount: number): boolean {
  return currentGlobalAdminCount > 1;
}

/** Login identity is case-insensitive and whitespace-insensitive. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
