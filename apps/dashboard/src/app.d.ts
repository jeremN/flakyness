/// <reference types="@sveltejs/kit" />

// API types matching the backend
export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectStats {
  project: {
    id: string;
    name: string;
  };
  activeFlakyTests: number;
  resolvedThisWeek: number;
  totalRuns: number;
  totalTests: number;
}

export interface FlakyTest {
  id: string;
  testName: string;
  testFile: string;
  firstDetected: string;
  lastSeen: string;
  flakeCount: number;
  totalRuns: number;
  flakeRate: string;
  status: 'active' | 'resolved' | 'ignored';
}

export interface TestRun {
  id: string;
  branch: string;
  commitSha: string;
  pipelineId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  createdAt: string;
}

export interface TestFlakiness {
  testName: string;
  testFile: string;
  totalRuns: number;
  passCount: number;
  failCount: number;
  flakyCount: number;
  flakeRate: number;
  isFlaky: boolean;
  lastSeen: string;
}

export interface AnalysisResponse {
  windowDays: number;
  threshold: number;
  flakyTests: TestFlakiness[];
  allTests: TestFlakiness[];
}

export type TrendDirection = 'improving' | 'worsening' | 'stable' | 'insufficient-data';

export interface TestTrendBucket {
  date: string;
  totalRuns: number;
  failed: number;
  flaky: number;
  // `null` means the test did not run that day — distinct from `0`, which
  // means it ran and never flaked. See apps/api/src/routes/tests.ts
  // `buildTrend` and docs/API.md.
  flakeRate: number | null;
}

export interface TestTrend {
  testName: string;
  projectId: string;
  days: number;
  direction: TrendDirection;
  trend: TestTrendBucket[];
}

// One row from GET /api/v1/projects/:id/runs/:runId's `results` array — a
// single test's outcome within that one run. `id` is deliberately omitted:
// the API doesn't expose `test_results.id` here (testName is unique within
// a run, so index-based keying is sufficient — see runs/[runId]/+page.svelte).
export interface RunResult {
  testName: string;
  testFile: string | null;
  status: string;
  durationMs: number | null;
  retryCount: number | null;
  errorMessage: string | null;
  tags: string[] | null;
  annotations: { type: string; description?: string }[] | null;
  failureDetail: {
    errors: { message?: string; stack?: string; snippet?: string; value?: string }[];
    stdout?: string;
    stderr?: string;
    attachments?: { name: string; contentType: string; path?: string }[];
  } | null;
}

export interface RunDetail {
  run: TestRun;
  results: RunResult[];
  truncated: boolean;
}

export interface TestHistory {
  testName: string;
  flakyInfo: FlakyTest | null;
  stats: {
    totalRuns: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    avgDuration: number;
  };
  history: Array<{
    id: string;
    status: string;
    durationMs: number;
    retryCount: number;
    errorMessage: string | null;
    tags: string[] | null;
    annotations: { type: string; description?: string }[] | null;
    createdAt: string;
    branch: string;
    commitSha: string;
  }>;
}

export interface AdminProject {
  id: string;
  name: string;
  gitlabProjectId: string | null;
  hasToken: boolean;
  createdAt: string;
  flakeThreshold: number | null;
  windowDays: number | null;
  minRuns: number | null;
  webhookUrl: string | null;
  webhookKind: 'slack' | 'generic' | null;
  retentionDays: number | null;
  autoQuarantineEnabled: boolean;
  quarantineThreshold: number | null;
  quarantineMinRuns: number | null;
  quarantineTtlDays: number | null;
  stats: {
    totalRuns: number;
    totalTests: number;
    activeFlakyTests: number;
  };
}

export interface CreateProjectResult {
  project: { id: string; name: string; gitlabProjectId: string | null; createdAt: string };
  token: string;
  warning: string;
}

export interface RotateTokenResult {
  project: { id: string; name: string };
  token: string;
  warning: string;
}

export interface PruneResult {
  dryRun: boolean;
  cutoff: string;
  runsToDelete?: number;
  resultsToDelete?: number;
  runsDeleted?: number;
  resultsDeleted?: number;
}
