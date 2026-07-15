import { getTestHistory, getTestTrend } from '$lib/api';
import { error } from '@sveltejs/kit';

// Mirrors the API's own guard (apps/api/src/routes/tests.ts `/:testName/trend`
// and apps/api/src/routes/projects.ts `/:id/trend`): guard the *parse* before
// the clamp, or a typo'd `days` query param (`NaN`) would sail straight
// through Math.min/Math.max unchanged (every comparison against NaN is
// false) and silently produce an empty trend. Not `parseInt(...) || 30`:
// that would also swallow `days=0` into 30 instead of clamping it to 1.
function parseDays(raw: string | null): number {
  const rawDays = parseInt(raw ?? '', 10);
  return Number.isNaN(rawDays) ? 30 : Math.min(Math.max(rawDays, 1), 90);
}

// Typed locally (rather than via `./$types`' `PageServerLoad`) so that importing
// `load` from a test keeps its precise, inferred return type instead of widening
// to `PageServerLoad`'s generic default (which includes `void`) — same
// rationale as routes/+page.server.ts and routes/analysis/+page.server.ts.
interface PageServerLoadEvent {
  params: { testName: string };
  url: URL;
}

export async function load({ params, url }: PageServerLoadEvent) {
  const testName = params.testName;
  const projectId = url.searchParams.get('project');

  if (!projectId) {
    throw error(400, 'Project ID is required');
  }

  const days = parseDays(url.searchParams.get('days'));

  const testHistory = await getTestHistory(testName, projectId);

  // The trend widget degrades independently of the run-history table above
  // (plan 008's rule; design decision 5 of plan 028): a failed trend fetch
  // must not 500 a page that is otherwise perfectly usable without it.
  let testTrend: Awaited<ReturnType<typeof getTestTrend>> | null = null;
  let trendFailed = false;
  try {
    testTrend = await getTestTrend(testName, projectId, days);
  } catch {
    trendFailed = true;
  }

  return {
    testHistory,
    testTrend,
    trendFailed,
    projectId,
  };
}
