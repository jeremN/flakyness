# Flackyness - AI Agent Context Guide

> **Purpose:** This document helps AI agents (and developers) quickly understand the Flackyness codebase to improve, fix, or add features effectively.

**Last Updated:** July 13, 2026  
**Current Status:** Batches 1–2 of the improve-skill backlog complete (19 plans landed, PRs #36–#56); full stack updated to latest (pnpm 11, TS 6, Vite 8, Svelte 5.56, zod 4, Drizzle 0.45, Hono 4.12) — see `plans/README.md` for the authoritative plan-by-plan status  
**Grade:** A- (92/100)

---

## 🎯 Project Overview

**Flackyness** is a self-hosted flaky test tracking system for CI/CD pipelines.

### What It Does
1. **Collects** Playwright JSON test reports from GitLab CI
2. **Detects** flaky tests by analyzing historical results
3. **Visualizes** flakiness metrics in a SvelteKit dashboard
4. **Tracks** test stability over time with ECharts

### Tech Stack
- **Backend:** Hono (TypeScript) + Node.js 24
- **Database:** PostgreSQL + Drizzle ORM
- **Dashboard:** SvelteKit + Tailwind CSS v4 (via `@tailwindcss/vite`) + ECharts
- **Deployment:** Docker Compose

### Toolchain (important)
- **Package manager: pnpm 11** (pinned via `packageManager` in root `package.json`; use `corepack pnpm …`).
- **Supply-chain hardening** in `pnpm-workspace.yaml`: `minimumReleaseAge: 1440` (don't install versions <24h old) and `allowBuilds: { esbuild: true }` (build scripts blocked by default — add new ones here after auditing).
  - Consequence: a fresh-published "latest" can be temporarily un-installable; pin one release back until it ages out. That's why `@sveltejs/kit` may trail the absolute latest.
- **TypeScript is split across the workspace**: `apps/api` is on **TS 7**; `apps/dashboard` stays on **TS 6** because `svelte-check` 4.x crashes under TS 7 — it reads `ts.default.sys.useCaseSensitiveFileNames`, a CommonJS shape the native TS 7 rewrite removed (upstream bug, not fixable here). `.github/dependabot.yml` has a dashboard-only entry that ignores TypeScript majors; lift it once svelte-check supports TS 7.
- **Dashboard CSS**: Tailwind v4 goes through the `@tailwindcss/vite` plugin (NOT a `postcss.config.js`). No `tailwind.config.js` file exists (it was dead — never loaded, no `@config` directive — removed in Plan 009).
- **Linting: oxlint** (`pnpm lint` → `oxlint --deny-warnings apps/`), NOT ESLint. `.oxlintrc.json` disables `no-unassigned-vars` (false-positive on Svelte `bind:this`). CI runs it via `oxc-project/oxlint-action`.
- **CI**: `.github/workflows/ci.yml` runs lint → typecheck (API `tsc` + dashboard `svelte-check`) → test (real Postgres 16 service) → build → docker. Plus `docker-publish.yml`.

---

## 📁 Project Structure

```
flackyness/
├── apps/
│   ├── api/                          # Hono backend (Port 8080)
│   │   ├── src/
│   │   │   ├── index.ts             # Main entry point
│   │   │   ├── db/
│   │   │   │   ├── schema.ts        # ⭐ Database schema (Drizzle)
│   │   │   │   ├── index.ts         # DB connection
│   │   │   │   └── seed.ts          # Sample data
│   │   │   ├── metrics.ts           # Prometheus registry + /metrics collectors
│   │   │   ├── routes/              # API endpoints
│   │   │   │   ├── reports.ts       # POST /api/v1/reports (ingestion)
│   │   │   │   ├── projects.ts      # Projects CRUD (read-side)
│   │   │   │   ├── tests.ts         # Test history + flaky mute/unmute
│   │   │   │   └── admin.ts         # Project create/rotate-token/delete, config overrides, health
│   │   │   ├── services/
│   │   │   │   ├── flakiness.ts     # ⭐ Flakiness detection algorithm
│   │   │   │   └── notifications.ts # Flaky-transition webhook delivery
│   │   │   ├── parsers/
│   │   │   │   ├── playwright.ts    # ⭐ Parse Playwright JSON
│   │   │   │   └── junit.ts         # Parse JUnit XML (jest-junit, pytest, Go, Maven, …)
│   │   │   └── middleware/
│   │   │       ├── auth.ts          # Bearer token auth
│   │   │       ├── logger.ts        # Structured logging
│   │   │       └── rate-limit.ts    # Rate limiting
│   │   ├── drizzle/                 # Database migrations (0000–0005)
│   │   ├── fixtures/                # Test fixtures
│   │   └── Dockerfile
│   │
│   └── dashboard/                    # SvelteKit frontend (Port 5173/3000)
│       ├── src/
│       │   ├── routes/              # SvelteKit pages
│       │   │   ├── +layout.svelte   # ⭐ Main layout + sidebar
│       │   │   ├── +page.svelte     # Overview page
│       │   │   ├── flaky/           # Flaky tests page
│       │   │   ├── runs/            # Test runs page
│       │   │   ├── analysis/        # Analysis view (surfaces GET /analysis)
│       │   │   └── tests/[testName]/ # Test detail page
│       │   └── lib/
│       │       ├── api.ts           # ⭐ API client
│       │       └── components/      # Reusable components
│       │           ├── Chart.svelte
│       │           └── ErrorState.svelte
│       └── Dockerfile
│
├── docs/
│   ├── API.md                       # API documentation
│   └── GETTING_STARTED.md           # New-user setup + CI integration guide
├── IMPLEMENTATION_PLAN.md           # ⭐ Full implementation roadmap
├── docker-compose.yml               # Production deployment
└── .env.example                     # Environment variables template
```

**⭐ = Critical files** to understand first

---

## 🔑 Key Concepts

### 1. Data Flow

```
GitLab CI → Playwright → JSON Report
                            ↓
                    POST /api/v1/reports
                            ↓
                    Parse with playwright.ts
                            ↓
            Store in test_runs + test_results
                            ↓
        Trigger flakiness detection (async)
                            ↓
            Update flaky_tests table
                            ↓
                Dashboard displays data
```

### 2. Database Schema

**4 Main Tables:**

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `projects` | Track projects | `id`, `name`, `token_hash`, `flake_threshold`, `window_days`, `min_runs` (nullable per-project overrides), `webhook_url` |
| `test_runs` | Pipeline executions | `project_id`, `branch`, `commit_sha` |
| `test_results` | Individual test outcomes | `test_name`, `status`, `duration_ms`, `tags`, `annotations` (jsonb, Playwright metadata) |
| `flaky_tests` | Computed flaky tests | `flake_rate`, `status` (`active` / `resolved` / `ignored`), `last_seen` |

Migrations: `apps/api/drizzle/` holds `0000`–`0005`.

**Relationships:**
```
projects (1) ─── (N) test_runs (1) ─── (N) test_results
    │
    └─── (N) flaky_tests
```

### 3. Flakiness Detection Algorithm

Located in: `apps/api/src/services/flakiness.ts`

**Logic:**
```typescript
// A test is flaky if:
flake_rate = (failed + flaky) / total_runs
is_flaky = flake_rate >= threshold (default 5%) AND total_runs >= minRuns (default 3)
```

`DEFAULT_CONFIG` (5% threshold, 3 min runs) is only the **fallback**. Each
project's `flake_threshold` / `window_days` / `min_runs` columns (NULL =
unset) win over it via `resolveProjectConfig`, which merges the project's
non-NULL overrides on top of `DEFAULT_CONFIG`.

**Triggered:**
- After each report ingestion (async, non-blocking)
- Manually via analysis endpoint

### 4. Muting Flaky Tests

`flaky_tests.status` is `active`, `resolved`, or `ignored` (muted).
`PATCH /api/v1/tests/flaky/:id` (`routes/tests.ts`) flips between `ignored`
and `active`. **Non-obvious invariant:** the reconcile upsert in
`updateFlakyTests` (`services/flakiness.ts`) preserves `ignored` across
every subsequent ingest — an operator-muted test stays silent even while
it keeps failing, until explicitly unmuted.

### 5. Webhook Notifications

Each project may carry a `webhook_url` (nullable, admin-set via
`PATCH /api/v1/admin/projects/:id`). After a report ingest, if any test
just became flaky or just resolved, `services/notifications.ts` POSTs a
`flaky_tests_changed` payload to that URL. v1 scope: one best-effort POST,
no retries, no signing — delivery failures are logged and swallowed, never
failing the ingest request.

### 6. Prometheus Metrics

`GET /metrics` (`apps/api/src/metrics.ts`, mounted in `index.ts`) exposes
`flackyness_reports_ingested_total`, `flackyness_report_parse_failures_total`,
`flackyness_flaky_tests_active`, plus default Node process metrics. Off by
default: the route 404s unless `METRICS_TOKEN` is set; once set, it requires
a matching Bearer token (401 otherwise), checked with the same
constant-time comparison as admin auth. Only `flakyTestsActive` is labeled
by project — the counters stay unlabeled to keep cardinality flat.

---

## 🛠️ Common Tasks

### Starting Development

```bash
# 0. Ensure a root .env exists with DB_PASSWORD + ADMIN_TOKEN set
#    (docker compose parses the whole file's interpolations before it starts
#    anything, so it fails outright if they're unset)
cp .env.example .env

# 1. Start PostgreSQL — scope to the `postgres` service. A bare
#    `docker compose up -d` starts EVERY service, and the hard-coded
#    container names collide with any other checkout on this machine.
docker compose up -d postgres

# 2. Run migrations
pnpm db:migrate

# 3. Seed sample data (optional)
pnpm db:seed

# 4. Start dev servers (both API + Dashboard)
pnpm dev

# Access:
# - API: http://localhost:8080
# - Dashboard: http://localhost:5173
```

### Database Operations

```bash
# Generate migration after schema changes
pnpm db:generate

# Apply migrations
pnpm db:migrate

# Open Drizzle Studio (DB GUI)
pnpm db:studio

# Seed sample data
pnpm --filter api db:seed
```

### Testing

```bash
# Run all tests
pnpm test

# Run API tests only
pnpm --filter api test

# Watch mode
pnpm --filter api test:watch

# Type check
pnpm --filter api exec tsc --noEmit
```

### Docker Deployment

```bash
# Build images
docker compose build

# Start production stack
docker compose --profile production up -d

# View logs
docker compose logs -f api
docker compose logs -f dashboard
```

---

## 🔐 Security & Performance

### Rate Limits (Phase 6)

| Endpoint | Limit | Key |
|----------|-------|-----|
| `POST /api/v1/reports` | 60/min | Project ID |
| Read APIs | 100/min | IP Address |

**Implementation:** `apps/api/src/middleware/rate-limit.ts`

### Database Indexes (Phase 6)

**8 indexes** for performance:
- `test_results.test_run_id` (B-tree)
- `test_results.test_name` (B-tree)
- `test_results.created_at` (BRIN - time-series)
- `flaky_tests(project_id, status)` (composite)
- And 4 more...

**Impact:** ~100x query speedup for large datasets

### Input Validation

- **Body size limit:** 10MB max
- **Pagination:** 1-100 items (clamped)
- **Zod validation:** All POST/PUT endpoints

---

## 🚀 Adding New Features

### 1. Add a New API Endpoint

**Example:** Add `GET /api/v1/projects/:id/summary`

```typescript
// apps/api/src/routes/projects.ts

projectsRouter.get('/:id/summary', async (c) => {
  const projectId = c.req.param('id');
  
  // Query database
  const stats = await getProjectStats(projectId);
  
  // Return JSON
  return c.json({ summary: stats });
});
```

**Don't forget:**
- ✅ Apply rate limiting (already on router)
- ✅ Add to `docs/API.md`
- ✅ Add tests in `routes/api.test.ts`

### 2. Add a New Dashboard Page

**Example:** Add `/settings` page

```bash
# 1. Create page file
mkdir -p apps/dashboard/src/routes/settings
touch apps/dashboard/src/routes/settings/+page.svelte
touch apps/dashboard/src/routes/settings/+page.server.ts
```

```svelte
<!-- apps/dashboard/src/routes/settings/+page.svelte -->
<script lang="ts">
  export let data;
</script>

<h1>Settings</h1>
<!-- Your content -->
```

```typescript
// apps/dashboard/src/routes/settings/+page.server.ts
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
  const { selectedProject } = await parent();
  
  return {
    // Your data
  };
};
```

**Don't forget:**
- ✅ Add link to `+layout.svelte` sidebar
- ✅ Update `project` search param in URLs
- ✅ Add loading/error states

### 3. Extend Database Schema

**Example:** Add `tags` to tests

```typescript
// apps/api/src/db/schema.ts

export const testResults = pgTable('test_results', {
  // ... existing fields
  tags: varchar('tags', { length: 500 }), // NEW
}, (table) => ({
  // ... existing indexes
  tagsIdx: index('test_results_tags_idx').on(table.tags), // NEW
}));
```

```bash
# Generate migration
pnpm db:generate

# Review migration in drizzle/ directory
# Apply migration
pnpm db:migrate
```

---

## 🐛 Debugging Tips

### API Issues

```bash
# Check logs (structured JSON in prod)
docker compose logs -f api

# Check database connection
docker compose exec postgres psql -U postgres -d flackyness

# View recent errors
# Logs include requestId for tracking requests
```

### Dashboard Issues

```bash
# Check browser console for API errors
# Check .env file for PUBLIC_API_URL

# Test API directly
curl http://localhost:8080/api/v1/projects

# Verify CORS headers
curl -H "Origin: http://localhost:5173" \
     http://localhost:8080/health -v
```

### Database Performance

```sql
-- Check index usage
EXPLAIN ANALYZE
SELECT * FROM test_results 
WHERE test_name = 'some test'
ORDER BY created_at DESC LIMIT 50;

-- Should see "Index Scan" in output

-- View table sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

---

## ⚠️ Known Issues & TODOs

### Critical (From Code Review - Phase 6)
- ✅ ~~Rate limiting~~ (Complete)
- ✅ ~~Database indexes~~ (Complete)
- ✅ ~~Input validation~~ (Complete)

### Medium Priority
- ✅ ~~Admin API endpoints (create/rotate tokens)~~ (Complete — `routes/admin.ts`)
- ✅ ~~Prometheus metrics endpoint~~ (Complete — `apps/api/src/metrics.ts`, `GET /metrics`, gated by `METRICS_TOKEN`; plan 018, PR #56)
- ⏳ E2E tests (Playwright) — no `playwright.config` or spec files in the repo yet

### Code review findings — status (June 4, 2026)
Resolved by `main`'s hardening pass (`d613f00`): UUID param validation, admin-token `crypto.timingSafeEqual`, stream-aware body limit (`hono/body-limit`), graceful shutdown, FK `onDelete: cascade`, oxlint + CI.

**Resolved in branch `fix/review-findings`:**
- ✅ `/projects/:id/analysis` DoS — `days` clamped to [1, 90], `threshold` validated to [0, 1].
- ✅ Flaky-test write races — `(project_id, test_name)` unique index (migration `0002`) + `onConflictDoUpdate` upsert in `updateFlakyTests`.
- ✅ N+1 delete — `admin.ts` deletes test results via a single `inArray`.
- ✅ `packages/shared` dead code — removed.
- ✅ 14 Svelte `state_referenced_locally` warnings — converted to `$derived` (svelte-check now 0/0).

**Accepted by design (revisit if commercialised / multi-tenant):**
- 🔵 **Unauthenticated read APIs** (`/projects/*`, `/tests/*`) — intentional for the current internal/self-hosted use (concept validation). If sold, add an env-gated read token that the dashboard's server-side loads pass.

**Open / optional:**
- ✅ ~~TypeScript 7 for the API~~ (Complete — Plan 023: `apps/api` is on TS 7, `ignoreDeprecations` removed from root tsconfig since `tsc --noEmit` and `pnpm build` both pass clean under TS 7 without it; `apps/dashboard` stays on TS 6, fenced in `.github/dependabot.yml`, until `svelte-check` supports TS 7). Still open: consider `noUncheckedIndexedAccess`.
- ⏳ `analyzeFlakiness` still aggregates in memory — fine at current scale; push to SQL `GROUP BY` if datasets grow large.

**Ops / scaling notes:**
- `main` is **branch-protected**: PRs + green CI (Lint, Type Check, Tests, Build, Docker Build) required to merge. `enforce_admins` is off, so the owner can bypass in emergencies — flip it on for strict enforcement.
- Rate limiting (`hono-rate-limiter`) uses an **in-memory** store, so limits are per-instance. Move to a shared (Redis) store before running more than one API replica.
- Read APIs (`/projects/*`, `/tests/*`) are unauthenticated by design (concept stage). For multi-tenant/SaaS: add an env-gated read token + per-project token scoping.
- The Dependabot lockfile-sync workflow's commit/push path hasn't run live yet (needs an eligible npm PR that changes deps past cooldown) — sanity-check the first one.

### Low Priority
- ⏳ Table partitioning (for >1M test results)
- ⏳ Read replicas (for >100 concurrent users)
- ⏳ Email notifications for flaky tests
- ⏳ GitLab webhook integration

### Future Enhancements
- 🔮 Support for other test frameworks (Jest, pytest)
- 🔮 Slack/Discord notifications
- 🔮 Flakiness trends (ML predictions)
- 🔮 Test failure screenshots

See `IMPLEMENTATION_PLAN.md` for full roadmap.

---

## 📊 Important Patterns

### 1. Error Handling

**Always use structured logger:**

```typescript
// ❌ Bad
console.error('Error:', err);

// ✅ Good
logger.error('Operation failed', {
  operation: 'fetchData',
  error: {
    name: err.name,
    message: err.message,
  },
  context: { userId: '123' },
});
```

### 2. Database Queries

**Always use Drizzle query builder** (prevents SQL injection):

```typescript
// ✅ Good - parameterized
const results = await db
  .select()
  .from(testResults)
  .where(eq(testResults.testName, userInput));

// ❌ Bad - don't construct raw SQL with user input
```

### 3. API Responses

**Consistent format:**

```typescript
// Success
return c.json({ data: result });

// Error
return c.json({ error: 'Description' }, statusCode);
```

### 4. SvelteKit Data Loading

**Use parent() for shared data:**

```typescript
// +layout.server.ts provides selectedProject
// Child pages access it:
export const load: PageServerLoad = async ({ parent }) => {
  const { selectedProject } = await parent();
  // Use selectedProject.id for queries
};
```

---

## 🧪 Testing Strategy

### Unit Tests
- Parser: `apps/api/src/parsers/playwright.test.ts`
- Flakiness: `apps/api/src/services/flakiness.test.ts`
- All tested with Vitest

### Integration Tests
- API endpoints: `apps/api/src/routes/api.test.ts`
- Skipped when DATABASE_URL not set (CI-friendly)

### Manual Testing
```bash
# Simulate CI report upload
pnpm --filter api simulate:ci

# View in dashboard
open http://localhost:5173
```

---

## 📚 Reference Documentation

| Document | Purpose |
|----------|---------|
| [IMPLEMENTATION_PLAN.md](file:///Users/jeremienehlil/Documents/Code/Personal/flackyness/IMPLEMENTATION_PLAN.md) | Full 6-phase roadmap |
| [docs/API.md](file:///Users/jeremienehlil/Documents/Code/Personal/flackyness/docs/API.md) | API endpoint reference |
| [README.md](file:///Users/jeremienehlil/Documents/Code/Personal/flackyness/README.md) | User-facing setup guide |
| [.gitlab-ci.yml.example](file:///Users/jeremienehlil/Documents/Code/Personal/flackyness/.gitlab-ci.yml.example) | CI integration example |

### Key Brain Artifacts
Historical review artifacts lived outside the repo and are no longer available.

---

## 🎯 Quick Reference Commands

```bash
# Development
pnpm dev                    # Start all dev servers
pnpm test                   # Run all tests
pnpm lint                   # Lint all code

# Database
pnpm db:generate            # Generate migration
pnpm db:migrate             # Apply migrations
pnpm db:studio              # Open DB GUI
pnpm db:seed                # Seed sample data

# Docker (needs DB_PASSWORD + ADMIN_TOKEN set, or compose won't even parse)
docker compose up -d postgres  # Start PostgreSQL only (bare `up -d` starts EVERYTHING)
docker compose build        # Build all images
docker compose --profile production up -d  # Full stack

# Specific apps
pnpm --filter api test      # API tests only
pnpm --filter dashboard build  # Build dashboard
```

---

## 💡 Tips for AI Agents

### When Adding Features
1. ✅ Check `IMPLEMENTATION_PLAN.md` for context
2. ✅ Review similar existing code for patterns
3. ✅ Add rate limiting if creating new endpoints
4. ✅ Consider database indexes for new queries
5. ✅ Update `docs/API.md` for new endpoints
6. ✅ Add tests (unit + integration)
7. ✅ Use structured logger, not console.log

### When Fixing Bugs
1. ✅ Check logs for error context (requestId)
2. ✅ Verify database indexes are being used (EXPLAIN)
3. ✅ Look for similar issues in code review findings
4. ✅ Add test to prevent regression

### When Refactoring
1. ✅ Run tests before and after
2. ✅ Maintain rate limiting and validation
3. ✅ Keep database migrations backward-compatible
4. ✅ Update TypeScript types if needed

---

## 🆘 Emergency Checklist

### Database Issues
```sql
-- Kill long-running queries
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'active' AND query_start < NOW() - INTERVAL '5 minutes';

-- Check locks
SELECT * FROM pg_locks WHERE NOT granted;

-- Vacuum if needed
VACUUM ANALYZE;
```

### API Not Responding
```bash
# Check if it's running
curl http://localhost:8080/health

# Restart API
docker compose restart api

# Check logs
docker compose logs -f api | tail -100
```

### Dashboard Not Loading
```bash
# Check API URL
cat apps/dashboard/.env | grep PUBLIC_API_URL

# Rebuild
pnpm --filter dashboard build
```

---

**Good luck! 🚀**

*Last updated by AI Agent on July 13, 2026*
*If you improve this project, please update this guide!*
