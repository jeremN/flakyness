import type { PageServerLoad, Actions } from './$types';
import { error, fail, redirect } from '@sveltejs/kit';
import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';
import { validateConfigForm, buildConfigPatch, CONFIG_FIELD_SPECS } from '$lib/admin-validation';
import type { AdminTeam } from '../../../app.d';

export const load: PageServerLoad = async ({ params, locals }) => {
  const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
  let projects;
  try {
    ({ projects } = await adminApi.listProjects());
  } catch (e) {
    const status = e instanceof NotAuthenticatedError ? 403 : e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load project');
  }
  const project = projects.find((p) => p.id === params.projectId);
  if (!project) throw error(404, 'Project not found');

  // listTeams() is global-admin only (admin-teams.ts's canAdministerTeams
  // gate rejects a team_admin outright) — but this screen is ALSO reachable
  // by a team_admin, since its load calls listProjects(), which plan 058
  // scopes rather than refuses. Calling listTeams() unconditionally would
  // 403 the whole settings screen for every team_admin. Fetch it only for a
  // global admin; the page also gates the team-reassignment control on
  // `data.user?.isGlobalAdmin`, so a team_admin never sees a control it
  // can't use.
  if (!locals.user?.isGlobalAdmin) return { project, teams: [] as AdminTeam[] };

  try {
    const { teams } = await adminApi.listTeams();
    return { project, teams };
  } catch (e) {
    const status = e instanceof NotAuthenticatedError ? 403 : e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load teams');
  }
};

// Converts an adminApi throw to the right `fail`, tagged with the action name
// so the page can route the feedback to the correct section.
function actionError(action: string, e: unknown) {
  if (e instanceof NotAuthenticatedError) return fail(403, { action, message: e.message });
  if (e instanceof AdminApiError) return fail(e.statusCode, { action, message: e.message });
  return fail(502, { action, message: 'Unexpected error contacting the API.' });
}

export const actions = {
  patch: async ({ request, params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    const form = await request.formData();
    const raw: Record<string, string> = {};
    for (const field of Object.keys(CONFIG_FIELD_SPECS)) {
      raw[field] = String(form.get(field) ?? '');
    }
    raw.webhookUrl = String(form.get('webhookUrl') ?? '');
    raw.webhookKind = String(form.get('webhookKind') ?? '');

    const { valid, errors } = validateConfigForm(raw);
    if (!valid) return fail(400, { action: 'patch', errors });

    const body = buildConfigPatch(raw, form.get('autoQuarantineEnabled') != null);
    // Team reassignment is global-admin-only on the API (admin.ts:443, gated
    // on `'teamId' in data`, NOT on truthiness — `{teamId: null}` is the
    // deliberate orphaning case and must be distinguishable from the key
    // being absent altogether). The team <select> only renders for a global
    // admin (see load(), above), so a team_admin's submit never carries this
    // field — include the key in the PATCH body only when the form actually
    // submitted it, or every settings save by a team_admin would 403, even
    // one that never touched the team. Follows the same manual-field
    // precedent as webhookUrl/webhookKind above rather than extending
    // CONFIG_FIELD_SPECS (which always sends its fields, never omits them).
    if (form.has('teamId')) {
      const teamId = String(form.get('teamId') ?? '');
      body.teamId = teamId === '' ? null : teamId;
    }
    try {
      await adminApi.patchProject(params.projectId, body);
      return { action: 'patch', success: true };
    } catch (e) {
      return actionError('patch', e);
    }
  },

  rotate: async ({ params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    try {
      const result = await adminApi.rotateToken(params.projectId);
      return { action: 'rotate', token: result.token, warning: result.warning };
    } catch (e) {
      return actionError('rotate', e);
    }
  },

  pruneDryRun: async ({ params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    try {
      const prune = await adminApi.pruneProject(params.projectId, false);
      return { action: 'prune', prune };
    } catch (e) {
      return actionError('prune', e);
    }
  },

  pruneConfirm: async ({ params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    try {
      const prune = await adminApi.pruneProject(params.projectId, true);
      return { action: 'prune', prune };
    } catch (e) {
      return actionError('prune', e);
    }
  },

  delete: async ({ request, params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    const form = await request.formData();
    const name = String(form.get('name') ?? '');
    const confirmName = String(form.get('confirmName') ?? '');
    // Server-side footgun guard: the typed name must match the name we showed.
    // (The client also disables the button; this is the real check.)
    if (confirmName !== name || name === '') {
      return fail(400, { action: 'delete', message: 'Type the exact project name to confirm.' });
    }
    try {
      await adminApi.deleteProject(params.projectId);
    } catch (e) {
      return actionError('delete', e);
    }
    throw redirect(303, '/admin');
  },
} satisfies Actions;
