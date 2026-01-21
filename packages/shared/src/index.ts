// Shared types for Flackyness

// Test status enum
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'flaky';

// Flaky test status
export type FlakyTestStatus = 'active' | 'resolved' | 'ignored';

// API response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Project
export interface Project {
  id: string;
  name: string;
  gitlabProjectId?: string;
  createdAt: string;
}

// Test run summary
export interface TestRunSummary {
  id: string;
  projectId: string;
  branch: string;
  commitSha: string;
  pipelineId?: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  createdAt: string;
}

// Individual test result
export interface TestResult {
  id: string;
  testRunId: string;
  testName: string;
  testFile?: string;
  status: TestStatus;
  durationMs?: number;
  retryCount: number;
  errorMessage?: string;
  createdAt: string;
}

// Flaky test summary
export interface FlakyTestSummary {
  id: string;
  projectId: string;
  testName: string;
  testFile?: string;
  firstDetected?: string;
  lastSeen?: string;
  flakeCount: number;
  totalRuns: number;
  flakeRate: number;
  status: FlakyTestStatus;
}

// Project stats
export interface ProjectStats {
  totalTests: number;
  flakyTestCount: number;
  overallFlakeRate: number;
  testsFixedThisWeek: number;
}
