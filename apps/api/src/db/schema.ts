import { pgTable, uuid, varchar, timestamp, integer, text, decimal, index, uniqueIndex, jsonb, boolean } from 'drizzle-orm/pg-core';
import type { FailureDetail } from '../parsers/types';

// Projects being tracked
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  gitlabProjectId: varchar('gitlab_project_id', { length: 100 }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(), // SHA-256 hash
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Per-project flakiness overrides; NULL means "use DEFAULT_CONFIG".
  flakeThreshold: decimal('flake_threshold', { precision: 5, scale: 4 }),
  windowDays: integer('window_days'),
  minRuns: integer('min_runs'),
  // Admin-set outbound webhook for flaky-test transition notifications; NULL
  // means "no webhook configured". Set only via the admin-token PATCH route
  // (same trust level as the operator's shell) — no SSRF deny-list in v1.
  webhookUrl: varchar('webhook_url', { length: 2048 }),
  // Channel formatter for the outbound webhook: NULL = auto-detect from the URL
  // (hooks.slack.com → Slack, else generic), 'slack'/'generic' = explicit
  // override (how a self-hosted Mattermost URL opts into Slack formatting).
  // See services/notifications/channel.ts.
  webhookKind: varchar('webhook_kind', { length: 16 }),
  // Per-project data retention. NULL means "keep forever" (the default for
  // every existing install). When set, `POST /admin/projects/:id/prune`
  // deletes test_runs older than this many days; test_results cascade.
  // Must never be lower than the resolved flakiness windowDays — see
  // routes/admin.ts.
  retentionDays: integer('retention_days'),
  // Auto-quarantine (opt-in per project; default off = current behavior).
  // See plan 051 / docs/superpowers/specs/2026-07-22-auto-quarantine-design.md.
  autoQuarantineEnabled: boolean('auto_quarantine_enabled').notNull().default(false),
  // Stricter-than-detection flake rate to auto-quarantine; NULL = default 0.20.
  // Must be >= the resolved flakeThreshold (validated in routes/admin.ts).
  quarantineThreshold: decimal('quarantine_threshold', { precision: 5, scale: 4 }),
  // Min runs before (re-)quarantine; NULL = resolved minRuns.
  quarantineMinRuns: integer('quarantine_min_runs'),
  // Mandatory TTL of an auto-quarantine, in days; NULL = default 7.
  quarantineTtlDays: integer('quarantine_ttl_days'),
}, (table) => ({
  // Index for token hash lookup (authentication)
  tokenHashIdx: index('projects_token_hash_idx').on(table.tokenHash),
}));

// Individual test runs (pipeline executions)
export const testRuns = pgTable('test_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
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
  testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'cascade' }).notNull(),
  testName: varchar('test_name', { length: 500 }).notNull(),
  testFile: varchar('test_file', { length: 500 }),
  status: varchar('status', { length: 20 }).notNull(), // passed, failed, skipped, flaky
  durationMs: integer('duration_ms'),
  retryCount: integer('retry_count').default(0),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Playwright metadata, persisted as-is; NULL when the report has none.
  tags: jsonb('tags').$type<string[]>(),
  annotations: jsonb('annotations').$type<{ type: string; description?: string }[]>(),
  // Richer per-run failure detail (stack/snippet/errors[]/stdout/stderr/
  // attachment metadata); NULL when the result has none (e.g. it passed, or
  // was ingested before this column existed). See plan 037. Attachments are
  // metadata only — never the base64 `body`.
  failureDetail: jsonb('failure_detail').$type<FailureDetail>(),
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
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  testName: varchar('test_name', { length: 500 }).notNull(),
  testFile: varchar('test_file', { length: 500 }),
  firstDetected: timestamp('first_detected'),
  lastSeen: timestamp('last_seen'),
  flakeCount: integer('flake_count').default(0),
  totalRuns: integer('total_runs').default(0),
  flakeRate: decimal('flake_rate', { precision: 5, scale: 4 }), // 0.0000 to 1.0000
  status: varchar('status', { length: 20 }).default('active'), // active, resolved, ignored
  // Mute provenance: 'manual' | 'auto' | NULL. Only meaningful while
  // status='ignored'. NULL on a legacy muted row = indefinite manual mute
  // (never auto-released). See plan 051.
  muteSource: varchar('mute_source', { length: 10 }),
  // Auto-quarantine TTL expiry; set for mute_source='auto', NULL otherwise.
  quarantineExpiresAt: timestamp('quarantine_expires_at'),
  // When this test last exited quarantine (auto-release OR manual unmute);
  // anchors the clean-slate rule (fresh runs must post-date it).
  quarantineReleasedAt: timestamp('quarantine_released_at'),
}, (table) => ({
  // Composite index for dashboard queries (filter by project + status)
  projectStatusIdx: index('flaky_tests_project_status_idx')
    .on(table.projectId, table.status),
  // Index for sorting by flake rate
  flakeRateIdx: index('flaky_tests_flake_rate_idx').on(table.flakeRate),
  // One flaky-test row per (project, test) — enables atomic upsert and blocks
  // duplicate rows from concurrent report ingestions.
  projectTestUnique: uniqueIndex('flaky_tests_project_test_unique')
    .on(table.projectId, table.testName),
}));

// Append-only audit of every quarantine transition (auto + manual) — the
// "traçabilité du mute" (plan 051). No UI in #2; feeds #4's audit view.
export const quarantineEvents = pgTable('quarantine_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  testName: varchar('test_name', { length: 500 }).notNull(),
  event: varchar('event', { length: 20 }).notNull(), // entered | released | manual_mute | manual_unmute
  source: varchar('source', { length: 10 }).notNull(), // auto | manual
  flakeRate: decimal('flake_rate', { precision: 5, scale: 4 }),
  threshold: decimal('threshold', { precision: 5, scale: 4 }),
  ttlDays: integer('ttl_days'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  projectCreatedIdx: index('quarantine_events_project_created_idx')
    .on(table.projectId, table.createdAt),
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
export type QuarantineEvent = typeof quarantineEvents.$inferSelect;
export type NewQuarantineEvent = typeof quarantineEvents.$inferInsert;
