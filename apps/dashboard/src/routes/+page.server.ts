import { getProjectStats, getFlakyTests, getProjectRuns, getFlakeTrend } from '$lib/server/api';
import type { Project } from '../app.d';

// Typed locally (rather than via `./$types`' `PageServerLoad`) so that importing
// `load` from a test keeps its precise, inferred return type instead of widening
// to `PageServerLoad`'s generic default (which includes `void`).
interface PageServerLoadEvent {
  parent: () => Promise<{ selectedProject: Project | null }>;
}

export async function load({ parent }: PageServerLoadEvent) {
  const { selectedProject } = await parent();

  if (!selectedProject) {
    return { stats: null, flakyTests: [], recentRuns: [], trendData: null };
  }

  const projectId = selectedProject.id;

  const results = await Promise.allSettled([
    getProjectStats(projectId),
    getFlakyTests(projectId, 'active', 5),
    getProjectRuns(projectId, 5),
    getFlakeTrend(projectId, 7),
  ]);
  const stats = results[0].status === 'fulfilled' ? results[0].value : null;
  const flakyTests = results[1].status === 'fulfilled' ? results[1].value : [];
  const recentRuns = results[2].status === 'fulfilled' ? results[2].value : [];
  const trendData = results[3].status === 'fulfilled' ? results[3].value : null;

  return {
    stats,
    flakyTests,
    recentRuns,
    trendData,
    partialFailure: results.some(r => r.status === 'rejected'),
  };
}
