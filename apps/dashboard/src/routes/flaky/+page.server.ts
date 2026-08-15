import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { createApi, APIError } from '$lib/server/api';
import { canMuteTests } from '$lib/permissions';

export const load: PageServerLoad = async ({ url, parent, locals }) => {
  const { selectedProject } = await parent();

  if (!selectedProject) {
    return { flakyTests: [], currentProject: null, status: 'active', canMute: false };
  }

  const status = url.searchParams.get('status') || 'active';
  const api = createApi(locals.sessionToken, locals.clientIp);
  const flakyTests = await api.getFlakyTests(selectedProject.id, status);

  return {
    flakyTests,
    currentProject: selectedProject,
    status,
    canMute: canMuteTests(locals.user, locals.teams, selectedProject),
  };
};

export const actions = {
  setStatus: async ({ request, locals }) => {
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    const status = String(form.get('status') ?? '');
    if (!id || (status !== 'ignored' && status !== 'active')) {
      return fail(400, { message: 'Invalid request' });
    }
    // No canMuteTests() check here on purpose: the API is the boundary and it
    // re-decides on every request. Re-deciding here too would mean two copies
    // of one rule that can drift, and the copy that drifts is the one nobody
    // tests against a real session.
    try {
      await createApi(locals.sessionToken, locals.clientIp).setFlakyStatus(id, status);
    } catch (err) {
      if (err instanceof APIError) {
        if (err.statusCode === 401 || err.statusCode === 403) {
          return fail(403, { message: 'You do not have permission to mute tests in this project.' });
        }
        return fail(err.statusCode === 404 ? 404 : 502, { message: 'Failed to update status' });
      }
      return fail(502, { message: 'Failed to update status' });
    }
    return { success: true };
  },
} satisfies Actions;
