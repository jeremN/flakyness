import { error, fail, type Actions, type ServerLoadEvent } from '@sveltejs/kit';
import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';
import type { TeamSummary } from '../../../app.d';

export async function load({ locals }: ServerLoadEvent) {
  if (!locals.user?.isGlobalAdmin) {
    // 404, not 403: the same existence-hiding posture the API takes on reads.
    // A non-admin has no business learning that a user-management screen exists.
    error(404, 'Not found');
  }
  const api = createAdminApi(locals.sessionToken, locals.clientIp);
  const [{ teams }, { users }] = await Promise.all([api.listTeams(), api.listUsers()]);
  return { teams, users };
}

/** Map an API error onto a form fail, preserving the API's own message. */
function toFail(e: unknown) {
  if (e instanceof AdminApiError) return fail(e.statusCode, { error: e.message });
  if (e instanceof NotAuthenticatedError) return fail(403, { error: 'Not signed in.' });
  throw e;
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const name = String((await request.formData()).get('name') ?? '').trim();
    if (!name) return fail(400, { error: 'Enter a team name.' });
    try {
      await createAdminApi(locals.sessionToken, locals.clientIp).createTeam(name);
      return { success: true };
    } catch (e) {
      return toFail(e);
    }
  },

  rename: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const teamId = String(form.get('teamId') ?? '');
    const name = String(form.get('name') ?? '').trim();
    if (!name) return fail(400, { error: 'Enter a team name.' });
    try {
      await createAdminApi(locals.sessionToken, locals.clientIp).patchTeam(teamId, name);
      return { success: true };
    } catch (e) {
      return toFail(e);
    }
  },

  delete: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const teamId = String(form.get('teamId') ?? '');
    const typedName = String(form.get('confirmName') ?? '');

    const api = createAdminApi(locals.sessionToken, locals.clientIp);
    // Re-fetch the authoritative name server-side and compare there. A
    // client-submitted "expected name" would let the confirmation gate be
    // bypassed by editing the DOM — same rule as plan 055's reorder.
    const { teams } = await api.listTeams();
    const team = teams.find((t) => t.id === teamId);
    if (!team) return fail(404, { error: 'Team not found.' });
    if (typedName !== team.name) {
      return fail(400, { error: `Type the team name exactly to confirm: ${team.name}` });
    }

    try {
      const res = await api.deleteTeam(teamId);
      return { success: true, orphanedProjects: res.orphanedProjects };
    } catch (e) {
      return toFail(e);
    }
  },

  addMember: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const teamId = String(form.get('teamId') ?? '');
    const userId = String(form.get('userId') ?? '');
    const role = String(form.get('role') ?? '') as TeamSummary['role'];
    if (!teamId || !userId) return fail(400, { error: 'Select a user to add.' });
    try {
      await createAdminApi(locals.sessionToken, locals.clientIp).addTeamMember(teamId, userId, role);
      return { success: true };
    } catch (e) {
      return toFail(e);
    }
  },

  setRole: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const teamId = String(form.get('teamId') ?? '');
    const userId = String(form.get('userId') ?? '');
    const role = String(form.get('role') ?? '') as TeamSummary['role'];
    if (!teamId || !userId) return fail(400, { error: 'Missing team or user.' });
    try {
      await createAdminApi(locals.sessionToken, locals.clientIp).patchTeamMember(teamId, userId, role);
      return { success: true };
    } catch (e) {
      return toFail(e);
    }
  },

  removeMember: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const teamId = String(form.get('teamId') ?? '');
    const userId = String(form.get('userId') ?? '');
    if (!teamId || !userId) return fail(400, { error: 'Missing team or user.' });
    try {
      await createAdminApi(locals.sessionToken, locals.clientIp).removeTeamMember(teamId, userId);
      return { success: true };
    } catch (e) {
      return toFail(e);
    }
  },
};
