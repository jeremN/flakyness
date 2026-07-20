import type { ServerLoadEvent } from '@sveltejs/kit';
import { getProjects } from '$lib/server/api';

export async function load({ url }: ServerLoadEvent) {
  let projects: Awaited<ReturnType<typeof getProjects>> = [];
  let apiError: string | null = null;
  try {
    projects = await getProjects();
  } catch {
    apiError = 'Cannot reach the Flackyness API. Showing an empty dashboard.';
  }
  const selectedProjectId = url.searchParams.get('project') || projects[0]?.id || null;
  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0] || null;
  return { projects, selectedProject, apiError };
}
