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
 * Written before plan 058 Task 5 landed, when `isGlobalAdmin` was a stored
 * attribute with no authorization behind it — every `/admin/*` route
 * (including `POST /admin/users` and `PATCH /admin/users/:id`) was gated by
 * `adminAuth()`, which checked only `ADMIN_TOKEN`, so an install with zero
 * global admins was trivially recoverable via `ADMIN_TOKEN` alone and this
 * guard was not yet protecting against an unrecoverable state.
 *
 * Task 5 is the "once" this comment predicted: admin routes are now gated by
 * `adminOrGlobalAdminAuth()`, which accepts a global-admin *session* in
 * addition to `ADMIN_TOKEN` — the account system's intended path, with
 * `ADMIN_TOKEN` as break-glass. `isGlobalAdmin` is genuinely load-bearing
 * now, and this guard is what keeps zero global admins from being reachable
 * by anyone without direct database access (`ADMIN_TOKEN` unset or
 * forgotten). Refusing on a count of 0 as well as 1 is deliberate: a count we
 * cannot explain is a reason to stop, not to proceed.
 */
export function canRemoveGlobalAdmin(currentGlobalAdminCount: number): boolean {
  return currentGlobalAdminCount > 1;
}

/** Login identity is case-insensitive and whitespace-insensitive. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
