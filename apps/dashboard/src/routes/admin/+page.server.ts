import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { listProjects, adminConfigured, AdminApiError } from '$lib/server/adminApi';

export const load: PageServerLoad = async () => {
  if (!adminConfigured()) {
    return { adminProjects: [], adminEnabled: false };
  }
  try {
    const { projects } = await listProjects();
    return { adminProjects: projects, adminEnabled: true };
  } catch (e) {
    const status = e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load projects');
  }
};
