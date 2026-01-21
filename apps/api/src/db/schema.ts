import { pgTable, uuid, varchar, timestamp, integer, text, decimal, index } from 'drizzle-orm/pg-core';

// Projects being tracked
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  gitlabProjectId: varchar('gitlab_project_id', { length: 100 }),
  tokenHash: varchar('token_hash', { length: 64 }), // SHA-256 hash
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  // Index for token hash lookup (authentication)
  tokenHashIdx: index('projects_token_hash_idx').on(table.tokenHash),
}));

// Individual test runs (pipeline executions)
export const testRuns = pgTable('test_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  branch: varchar('branch', { length: 255 }).notNull(),
  commitSha: varchar('commit_sha', { length: 40 }).notNull(),
  pipelineId: varchar('pipeline_id', { length: 100 }),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  totalTests: integer('total_tests'),
  passed: integer('passed'),
  failed: integer('failed'),
  skipped: integer('skipped'),
  flaky: integer('flaky'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  // Index for fetching runs by project
  projectIdIdx: index('test_runs_project_id_idx').on(table.projectId),
  // BRIN index for time-series queries (very efficient for timestamps)
  createdAtBrinIdx: index('test_runs_created_at_brin_idx').using('brin', table.createdAt),
}));

// Individual test results
export const testResults = pgTable('test_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  testRunId: uuid('test_run_id').references(() => testRuns.id).notNull(),
  testName: varchar('test_name', { length: 500 }).notNull(),
  testFile: varchar('test_file', { length: 500 }),
  status: varchar('status', { length: 20 }).notNull(), // passed, failed, skipped, flaky
  durationMs: integer('duration_ms'),
  retryCount: integer('retry_count').default(0),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  // Index for FK lookups (joining with test runs)
  testRunIdIdx: index('test_results_test_run_id_idx').on(table.testRunId),
  // Index for flakiness detection (group by test name)
  testNameIdx: index('test_results_test_name_idx').on(table.testName),
  // BRIN index for time-series queries
  createdAtBrinIdx: index('test_results_created_at_brin_idx').using('brin', table.createdAt),
}));

// Flaky test tracking (computed/cached)
export const flakyTests = pgTable('flaky_tests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  testName: varchar('test_name', { length: 500 }).notNull(),
  testFile: varchar('test_file', { length: 500 }),
  firstDetected: timestamp('first_detected'),
  lastSeen: timestamp('last_seen'),
  flakeCount: integer('flake_count').default(0),
  totalRuns: integer('total_runs').default(0),
  flakeRate: decimal('flake_rate', { precision: 5, scale: 4 }), // 0.0000 to 1.0000
  status: varchar('status', { length: 20 }).default('active'), // active, resolved, ignored
}, (table) => ({
  // Composite index for dashboard queries (filter by project + status)
  projectStatusIdx: index('flaky_tests_project_status_idx')
    .on(table.projectId, table.status),
  // Index for sorting by flake rate
  flakeRateIdx: index('flaky_tests_flake_rate_idx').on(table.flakeRate),
}));

// Type exports for use in application
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type TestRun = typeof testRuns.$inferSelect;
export type NewTestRun = typeof testRuns.$inferInsert;
export type TestResult = typeof testResults.$inferSelect;
export type NewTestResult = typeof testResults.$inferInsert;
export type FlakyTest = typeof flakyTests.$inferSelect;
export type NewFlakyTest = typeof flakyTests.$inferInsert;
