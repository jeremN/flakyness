import { error, fail, type Actions, type ServerLoadEvent } from '@sveltejs/kit';
import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';

export async function load({ locals }: ServerLoadEvent) {
  if (!locals.user?.isGlobalAdmin) {
    // 404, not 403: the same existence-hiding posture admin/teams takes on
    // reads. A non-admin has no business learning that a user-management
    // screen exists.
    throw error(404, 'Not found');
  }
  const api = createAdminApi(locals.sessionToken, locals.clientIp);
  try {
    const { users } = await api.listUsers();
    return { users };
  } catch (e) {
    // Every other admin load in the repo maps a fetch failure to an inline
    // error page instead of an unhandled 500 (admin/+page.server.ts,
    // admin/teams/+page.server.ts) — match that here too.
    const status = e instanceof NotAuthenticatedError ? 403 : e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load users');
  }
}

/** Map an API error onto a form fail, preserving the API's own message. */
function toFail(e: unknown) {
  if (e instanceof AdminApiError) return fail(e.statusCode, { error: e.message });
  if (e instanceof NotAuthenticatedError) return fail(403, { error: 'Not signed in.' });
  // Fallback for anything else (e.g. a raw network TypeError from a dead
  // API) — matches admin/teams/+page.server.ts's toFail byte-for-byte.
  // Without this, an unrecognized throw propagated past every action and
  // SvelteKit rendered a full-page 500 instead of the inline banner every
  // sibling admin screen shows on an outage.
  return fail(502, { error: 'Unexpected error contacting the API.' });
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim();
    const displayName = String(form.get('displayName') ?? '').trim();
    const isGlobalAdmin = form.get('isGlobalAdmin') != null;
    if (!email) return fail(400, { error: 'Enter an email address.' });
    try {
      const result = await createAdminApi(locals.sessionToken, locals.clientIp).createUser({
        email,
        ...(displayName ? { displayName } : {}),
        isGlobalAdmin,
      });
      // The temporary password is shown exactly once, here — it is never
      // returned by GET /admin/users, so this response is its only sighting.
      return { success: true, temporaryPassword: result.temporaryPassword, warning: result.warning };
    } catch (e) {
      return toFail(e);
    }
  },

  resetPassword: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const userId = String(form.get('userId') ?? '');
    if (!userId) return fail(400, { error: 'Missing user.' });
    try {
      const result = await createAdminApi(locals.sessionToken, locals.clientIp).resetUserPassword(userId);
      return { success: true, temporaryPassword: result.temporaryPassword, warning: result.warning };
    } catch (e) {
      return toFail(e);
    }
  },

  toggleGlobalAdmin: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const userId = String(form.get('userId') ?? '');
    const isGlobalAdmin = String(form.get('isGlobalAdmin') ?? '') === 'true';
    if (!userId) return fail(400, { error: 'Missing user.' });
    try {
      await createAdminApi(locals.sessionToken, locals.clientIp).patchUser(userId, { isGlobalAdmin });
      return { success: true };
    } catch (e) {
      // Surfaces the API's own 409 message verbatim — e.g. "Cannot demote
      // the last global admin" (admin-users.ts:270).
      return toFail(e);
    }
  },

  delete: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const userId = String(form.get('userId') ?? '');
    if (!userId) return fail(400, { error: 'Missing user.' });
    try {
      await createAdminApi(locals.sessionToken, locals.clientIp).deleteUser(userId);
      return { success: true };
    } catch (e) {
      // Surfaces the API's own 409 message verbatim — e.g. "Cannot delete
      // the last global admin" (admin-users.ts:360).
      return toFail(e);
    }
  },
};
