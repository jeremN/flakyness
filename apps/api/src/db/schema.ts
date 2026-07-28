import { pgTable, uuid, varchar, timestamp, integer, text, decimal, index, uniqueIndex, jsonb, boolean } from 'drizzle-orm/pg-core';
import type { FailureDetail } from '../parsers/types';

// Organizational grouping of projects (plan 057 / roadmap #5). A project
// belongs to at most one team; a user belongs to many. This is a single-org
// grouping-and-access-control boundary, NOT hard multi-tenant isolation —
// see the spec's "Scope boundaries" section.
export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  // `withTimezone` like users/sessions, NOT plain `timestamp` like the older
  // tables. The spec specifies timestamptz for every table in this feature
  // (design doc :111), and plan 056's Task 1 review settled the rule: new
  // tables follow the spec while they are still empty, because switching
  // later means an ALTER against live rows. The pre-existing tables stay
  // timezone-naive; a sweep is a recorded follow-up in plans/README.md.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Projects being tracked
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  gitlabProjectId: varchar('gitlab_project_id', { length: 100 }),
  // Organizational owner. NULLABLE and ON DELETE SET NULL by design — a team
  // is not an ownership parent, so deleting a team orphans its projects
  // rather than destroying them. This deliberately breaks the "projects child
  // tables cascade" convention in AGENTS.md; the convention is about tables
  // that hang OFF a project, and this one hangs off a team. An orphaned
  // project is visible to global admins only (plan 058).
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
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
  // Which rule promoted this test, when the rule engine (4b) drove it; NULL for
  // legacy single-threshold mutes and all manual/release events. ON DELETE SET
  // NULL so deleting a rule preserves the historical audit row.
  ruleId: uuid('rule_id').references(() => quarantineRules.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  projectCreatedIdx: index('quarantine_events_project_created_idx')
    .on(table.projectId, table.createdAt),
}));

// Ordered per-project quarantine policy rules (roadmap 4b). NULL selectors are
// wildcards; lower `position` = higher priority (first-match-wins). When a
// project has >=1 enabled rule, reconcileQuarantine takes the rule path; else
// the legacy single-threshold path (plan 051) runs unchanged.
export const quarantineRules = pgTable('quarantine_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  position: integer('position').notNull(),
  name: varchar('name', { length: 255 }),
  enabled: boolean('enabled').notNull().default(true),
  // Glob for branch/file; membership for tag. NULL = any.
  selectorBranch: varchar('selector_branch', { length: 255 }),
  selectorFile: varchar('selector_file', { length: 500 }),
  selectorTag: varchar('selector_tag', { length: 255 }),
  action: varchar('action', { length: 16 }).notNull(), // quarantine | exempt
  conditionType: varchar('condition_type', { length: 16 }), // flake_rate | consecutive | NULL (exempt)
  flakeThreshold: decimal('flake_threshold', { precision: 5, scale: 4 }),
  minRuns: integer('min_runs'),
  windowDays: integer('window_days'),
  consecutiveFailures: integer('consecutive_failures'),
  ttlDays: integer('ttl_days'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  projectPositionIdx: index('quarantine_rules_project_position_idx')
    .on(table.projectId, table.position),
}));

// Local user accounts (plan 056 / roadmap #5+#6). Identity is API-owned: the
// dashboard is a client that logs in here, never the enforcement point.
// Deliberately OIDC-ready — nothing below assumes the password is the only
// possible credential, so an external IdP can be added beside it later.
//
// These two tables use `timestamptz` (not plain `timestamp`, as the rest of
// this file does) per the design spec — `sessions.expires_at` is a security
// control compared against `Date.now()` in JS, so it must not silently skew
// if the API container's TZ ever diverges from the DB server's. The rest of
// the schema predates that decision; migrating it is a separate, deliberate
// sweep, not something to "fix" here for consistency.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Login identity. Stored lower-cased (normalised at the route edge) so
  // "Ada@x.io" and "ada@x.io" cannot become two accounts.
  email: varchar('email', { length: 255 }).unique().notNull(),
  // scrypt, encoded `scrypt$N$r$p$salt$hash` — see services/auth/password.ts.
  passwordHash: varchar('password_hash', { length: 256 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  // The operator. Bypasses all team scoping (plan 058). Never defaults true.
  isGlobalAdmin: boolean('is_global_admin').notNull().default(false),
  // Set when an admin provisions the account with a show-once temp password
  // (plan 057); forces a reset on first login.
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

// Server-side sessions. The raw token lives only in the client's cookie; we
// store a SHA-256 of it, exactly as projects.token_hash does — so a database
// dump does not hand out live sessions.
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // Sliding TTL anchor: refreshed on use, so an active session does not expire
  // mid-workday. See services/auth/session.ts.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tokenHashIdx: index('sessions_token_hash_idx').on(table.tokenHash),
  userIdIdx: index('sessions_user_id_idx').on(table.userId),
}));

// User <-> team membership, with the per-membership role.
//
// 'team_admin' manages their team's projects (config, rules, token rotation);
// 'member' is read-only within the team. Global admin lives on users, not
// here, because it is not scoped to a team.
export const teamMembers = pgTable('team_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  role: varchar('role', { length: 16 }).notNull(), // team_admin | member
  // timestamptz, for the same reason as `teams.created_at` above.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userTeamUnique: uniqueIndex('team_members_user_team_unique').on(table.userId, table.teamId),
  teamIdIdx: index('team_members_team_id_idx').on(table.teamId),
  userIdIdx: index('team_members_user_id_idx').on(table.userId),
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
export type QuarantineRule = typeof quarantineRules.$inferSelect;
export type NewQuarantineRule = typeof quarantineRules.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
