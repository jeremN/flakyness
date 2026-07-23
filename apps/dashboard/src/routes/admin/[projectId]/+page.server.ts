import type { PageServerLoad, Actions } from './$types';
import { error, fail } from '@sveltejs/kit';
import {
  listProjects,
  patchProject,
  adminConfigured,
  AdminApiError,
  MissingAdminTokenError,
} from '$lib/server/adminApi';
import { validateConfigForm, buildConfigPatch, CONFIG_FIELD_SPECS } from '$lib/admin-validation';

export const load: PageServerLoad = async ({ params }) => {
  const { projects } = await listProjects();
  const project = projects.find((p) => p.id === params.projectId);
  if (!project) throw error(404, 'Project not found');
  return { project };
};

// Converts an adminApi throw to the right `fail`, tagged with the action name
// so the page can route the feedback to the correct section.
function actionError(action: string, e: unknown) {
  if (e instanceof MissingAdminTokenError) return fail(403, { action, message: e.message });
  if (e instanceof AdminApiError) return fail(e.statusCode, { action, message: e.message });
  return fail(502, { action, message: 'Unexpected error contacting the API.' });
}

export const actions = {
  patch: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'patch', message: 'ADMIN_TOKEN not set.' });

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
      await patchProject(params.projectId, body);
      return { action: 'patch', success: true };
    } catch (e) {
      return actionError('patch', e);
    }
  },
} satisfies Actions;
