import { getRunDetail } from '$lib/server/api';
import { isHttpError } from '@sveltejs/kit';
import type { Project, RunDetail } from '../../../app.d';

// Typed locally (rather than via `./$types`' `PageServerLoad`) so that importing
// `load` from a test keeps its precise, inferred return type instead of widening
// to `PageServerLoad`'s generic default (which includes `void`) — same
// rationale as routes/+page.server.ts and routes/tests/[testName]/+page.server.ts.
interface PageServerLoadEvent {
  parent: () => Promise<{ selectedProject: Project | null }>;
  params: { runId: string };
  url: URL;
}

export async function load({ parent, params, url }: PageServerLoadEvent) {
  const { selectedProject } = await parent();

  if (!selectedProject) {
    return { runDetail: null, projectId: null, statusFilter: null, loadFailed: false };
  }

  // Absent by default (failures-first, OQ1); `?status=all` (or another
  // explicit value) widens the scope. Passed straight through to the API —
  // it validates and falls back safely on its own.
  const statusFilter = url.searchParams.get('status') ?? undefined;

  let runDetail: RunDetail | null = null;
  let loadFailed = false;
  try {
    runDetail = await getRunDetail(selectedProject.id, params.runId, statusFilter);
  } catch (err) {
    // A 404 (the run was pruned, or the id is simply wrong) is a legitimate,
    // permanent outcome — let it propagate so SvelteKit's own +error.svelte
    // renders it, same as any other kit `error(...)`. Do NOT fold it into
    // the generic degraded state below.
    if (isHttpError(err) && err.status === 404) {
      throw err;
    }
    // Anything else (network blip, upstream 5xx→502, etc.) degrades this
    // page to an ErrorState with a retry button rather than a white screen
    // or the generic kit error page — mirrors the trend widget's resilience
    // in routes/tests/[testName]/+page.server.ts, except here it covers the
    // page's main content since there is no secondary/optional data here.
    loadFailed = true;
  }

  return {
    runDetail,
    projectId: selectedProject.id,
    statusFilter: statusFilter ?? null,
    loadFailed,
  };
}
