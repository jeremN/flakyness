import type { ServerLoadEvent } from '@sveltejs/kit';
import { getProjects } from '$lib/api';

export async function load({ url }: ServerLoadEvent) {
  const projects = await getProjects();
  const selectedProjectId = url.searchParams.get('project') || projects[0]?.id || null;
  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0] || null;

  return {
    projects,
    selectedProject,
  };
}
