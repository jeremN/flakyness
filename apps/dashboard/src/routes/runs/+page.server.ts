import type { PageServerLoad } from './$types';
import { getProjectRuns } from '$lib/api';

export const load: PageServerLoad = async ({ parent }) => {
  const { selectedProject } = await parent();
  
  if (!selectedProject) {
    return { runs: [], currentProject: null };
  }

  const runs = await getProjectRuns(selectedProject.id, 50);

  return {
    runs,
    currentProject: selectedProject,
  };
};
