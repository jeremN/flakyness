import type { PageServerLoad } from './$types';
import { createApi } from '$lib/server/api';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { selectedProject } = await parent();

  if (!selectedProject) {
    return { runs: [], currentProject: null };
  }

  const api = createApi(locals.sessionToken, locals.clientIp);
  const runs = await api.getProjectRuns(selectedProject.id, 50);

  return {
    runs,
    currentProject: selectedProject,
  };
};
