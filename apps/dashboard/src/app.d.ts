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
