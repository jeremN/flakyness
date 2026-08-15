import { eq } from 'drizzle-orm';
import { db, users } from '../db';

/**
 * `POST /api/v1/admin/users` always sets `mustChangePassword: true` — by
 * design, so a freshly provisioned user is forced through a first-time
 * rotation before anything else. Since commit f5d16b0 that flag is an
 * authorization boundary: `canReadProject`, `canWriteProject`,
 * `canAdministerTeams` and `canEnterAdminApi` (services/auth/access.ts) all
 * return `false` for a 'user' session that hasn't rotated yet.
 *
 * The suites that call this provision a user purely to log straight in and
 * exercise team-scoping or admin-race behaviour with full authority — they
 * are not testing the password lifecycle. This clears the flag directly in
 * the database right after provisioning, so the fixture's login lands past
 * the forced first-time change instead of mid-reset. The forced change
 * itself has its own dedicated coverage
 * (middleware/password-change.test.ts).
 */
export async function clearMustChangePassword(userId: string): Promise<void> {
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
}
