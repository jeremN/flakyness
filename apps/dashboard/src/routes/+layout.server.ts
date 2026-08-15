import type { ServerLoadEvent } from '@sveltejs/kit';
import { createApi } from '$lib/server/api';

export async function load({ url, locals }: ServerLoadEvent) {
  const api = createApi(locals.sessionToken, locals.clientIp);
  let projects: Awaited<ReturnType<typeof api.getProjects>> = [];
  let apiError: string | null = null;
  try {
    projects = await api.getProjects();
  } catch {
    apiError = 'Cannot reach the Flackyness API. Showing an empty dashboard.';
  }
  const selectedProjectId = url.searchParams.get('project') || projects[0]?.id || null;
  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0] || null;
  return { projects, selectedProject, apiError };
}
