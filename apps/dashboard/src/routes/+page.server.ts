import type { PageServerLoad } from './$types';
import { getProjectStats, getFlakyTests, getProjectRuns } from '$lib/api';

// Generate mock trend data for the last 7 days
function generateTrendData() {
  const days: string[] = [];
  const rates: number[] = [];
  const now = new Date();
  
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    days.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    // Mock flake rate between 2-12%
    rates.push(Math.round((Math.random() * 10 + 2) * 10) / 10);
  }
  
  return { days, rates };
}

export const load: PageServerLoad = async ({ parent }) => {
  const { selectedProject } = await parent();
  
  if (!selectedProject) {
    return { stats: null, flakyTests: [], recentRuns: [], trendData: null };
  }

  const projectId = selectedProject.id;
  
  const [stats, flakyTests, recentRuns] = await Promise.all([
    getProjectStats(projectId),
    getFlakyTests(projectId, 'active'),
    getProjectRuns(projectId, 5),
  ]);

  const trendData = generateTrendData();

  return {
    stats,
    flakyTests,
    recentRuns,
    trendData,
  };
};
