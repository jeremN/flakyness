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
    createdAt: string;
    branch: string;
    commitSha: string;
  }>;
}
