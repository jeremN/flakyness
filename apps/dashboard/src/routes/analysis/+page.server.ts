import { getAnalysis } from '$lib/server/api';
import type { Project } from '../../app.d';

// Mirror the API's own clamps (apps/api/src/routes/projects.ts `GET /:id/analysis`)
// so the UI never displays values the server would have silently corrected.
function parseDays(raw: string | null): number {
  return Math.min(Math.max(parseInt(raw || '14', 10) || 14, 1), 90);
}

function parseThreshold(raw: string | null): number {
  const parsed = parseFloat(raw || '0.05');
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0.05;
}

// Typed locally (rather than via `./$types`' `PageServerLoad`) so that importing
// `load` from a test keeps its precise, inferred return type instead of widening
// to `PageServerLoad`'s generic default (which includes `void`).
interface PageServerLoadEvent {
  url: URL;
  parent: () => Promise<{ selectedProject: Project | null }>;
}

export async function load({ url, parent }: PageServerLoadEvent) {
  const { selectedProject } = await parent();

  const days = parseDays(url.searchParams.get('days'));
  const threshold = parseThreshold(url.searchParams.get('threshold'));

  if (!selectedProject) {
    return { analysis: null, currentProject: null, days, threshold };
  }

  const analysis = await getAnalysis(selectedProject.id, days, threshold);

  return {
    analysis,
    currentProject: selectedProject,
    days,
    threshold,
  };
}
