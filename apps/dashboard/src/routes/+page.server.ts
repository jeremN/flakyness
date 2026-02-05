import type { PageServerLoad } from './$types';
import { getProjectStats, getFlakyTests, getProjectRuns, getFlakeTrend } from '$lib/api';

export const load: PageServerLoad = async ({ parent }) => {
  const { selectedProject } = await parent();

  if (!selectedProject) {
    return { stats: null, flakyTests: [], recentRuns: [], trendData: null };
  }

  const projectId = selectedProject.id;

  const [stats, flakyTests, recentRuns, trendData] = await Promise.all([
    getProjectStats(projectId),
    getFlakyTests(projectId, 'active'),
    getProjectRuns(projectId, 5),
    getFlakeTrend(projectId, 7),
  ]);

  return {
    stats,
    flakyTests,
    recentRuns,
    trendData,
  };
};
