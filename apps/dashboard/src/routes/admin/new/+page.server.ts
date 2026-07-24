import type { Actions } from './$types';
import { fail } from '@sveltejs/kit';
import {
  createProject,
  adminConfigured,
  AdminApiError,
  MissingAdminTokenError,
} from '$lib/server/adminApi';

export const actions = {
  default: async ({ request }) => {
    if (!adminConfigured()) {
      return fail(403, { message: 'The dashboard server has no ADMIN_TOKEN configured.' });
    }
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    const gitlabProjectId = String(form.get('gitlabProjectId') ?? '').trim();

    if (!name) {
      return fail(400, { message: 'Project name is required.', name });
    }

    try {
      const body: { name: string; gitlabProjectId?: string } = { name };
      if (gitlabProjectId) body.gitlabProjectId = gitlabProjectId;
      const result = await createProject(body);
      return {
        created: true,
        token: result.token,
        warning: result.warning,
        projectName: result.project.name,
      };
    } catch (e) {
      if (e instanceof MissingAdminTokenError) return fail(403, { message: e.message, name });
      if (e instanceof AdminApiError) return fail(e.statusCode, { message: e.message, name });
      return fail(502, { message: 'Unexpected error contacting the API.', name });
    }
  },
} satisfies Actions;
