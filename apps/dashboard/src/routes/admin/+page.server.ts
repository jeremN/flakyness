import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';

export const load: PageServerLoad = async ({ locals }) => {
  const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
  try {
    const { projects } = await adminApi.listProjects();
    return { adminProjects: projects, adminEnabled: true };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { adminProjects: [], adminEnabled: false };
    }
    const status = e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load projects');
  }
};
