import type { PageServerLoad } from './$types';
import { getFlakyTests } from '$lib/api';

export const load: PageServerLoad = async ({ url, parent }) => {
  const { selectedProject } = await parent();
  
  if (!selectedProject) {
    return { flakyTests: [], currentProject: null, status: 'active' };
  }

  const status = url.searchParams.get('status') || 'active';
  const flakyTests = await getFlakyTests(selectedProject.id, status);

  return {
    flakyTests,
    currentProject: selectedProject,
    status,
  };
};
