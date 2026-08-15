import type { PageServerLoad, Actions } from './$types';
import { error, fail, redirect } from '@sveltejs/kit';
import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';
import { validateConfigForm, buildConfigPatch, CONFIG_FIELD_SPECS } from '$lib/admin-validation';

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
  return { project };
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
