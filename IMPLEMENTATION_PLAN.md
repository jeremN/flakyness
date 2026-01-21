# Flaky Test Tracking System for CI/CD

A self-hosted solution to collect, analyze, and visualize flaky E2E test data from Playwright test runs in GitLab CI pipelines.

## Goals

1. **Collect** test results from Playwright JSON reports via GitLab CI
2. **Detect** flaky tests using historical analysis (same test, different outcomes)
3. **Visualize** flakiness metrics in a dashboard

---

## Proposed Architecture

```mermaid
flowchart LR
    subgraph GitLab CI
        A[Playwright Tests] --> B[JSON Report]
        B --> C[curl to API]
    end
    
    subgraph Flackyness Backend
        C --> D[Hono API]
        D --> E[(PostgreSQL)]
        D --> F[Rate Limiter]
    end
    
    subgraph Dashboard
        G[SvelteKit] --> D
        G --> H[ECharts]
    end
```

---

## Tech Stack (Final)

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Backend API** | **Hono** | TypeScript-first, ~14KB, multi-runtime (Node/Bun), built-in CORS/JWT middleware |
| **Database** | **PostgreSQL + Drizzle ORM** | MVCC concurrency, partitioning support, Drizzle is type-safe and lightweight |
| **Dashboard** | **SvelteKit** | User preference, compile-time optimization, excellent perf, built-in routing |
| **Charts** | **Apache ECharts** | Large dataset handling, heatmaps, active development (v6.0) |
| **Deployment** | Docker Compose | Self-hosted simplicity |

---

## Security Considerations

### API Authentication

| Layer | Implementation |
|-------|----------------|
| **Project tokens** | Bearer tokens per project, stored hashed in DB |
| **Hono middleware** | `bearerAuth` middleware validates tokens on ingestion endpoints |
| **Dashboard auth** | SvelteKit `hooks.server.ts` with HTTP-only cookies |

```typescript
// Example Hono auth middleware
import { bearerAuth } from 'hono/bearer-auth'

app.use('/api/v1/reports', bearerAuth({ verifyToken: async (token) => {
  const project = await db.query.projects.findFirst({
    where: eq(projects.tokenHash, hashToken(token))
  })
  return !!project
}}))
```

### Rate Limiting

| Endpoint | Limit | Rationale |
|----------|-------|-----------|
| `POST /api/v1/reports` | 60/min per token | Prevent accidental CI loops |
| Dashboard API | 100/min per IP | Prevent scraping |

```typescript
// Using hono-rate-limiter
import { rateLimiter } from 'hono-rate-limiter'

app.use('/api/v1/reports', rateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (c) => c.req.header('Authorization') ?? ''
}))
```

### Input Validation

| Risk | Mitigation |
|------|------------|
| Malformed JSON | Schema validation with `zod` before DB insert |
| SQL injection | Parameterized queries via Drizzle ORM |
| XSS in test names | HTML escaping on dashboard render |
| Oversized payloads | `Content-Length` limit (10MB max) |

### Other Security Headers

```typescript
import { secureHeaders } from 'hono/secure-headers'

app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"], // ECharts needs inline
  },
  xFrameOptions: 'DENY',
}))
```

---

## Scalability Considerations

### Database Scaling Strategy

```mermaid
flowchart TD
    subgraph Phase 1: MVP
        A[Single PostgreSQL]
    end
    
    subgraph Phase 2: Growth
        B[Primary] --> C[Read Replica]
        B --> D[Table Partitioning]
    end
    
    subgraph Phase 3: Scale
        E[PgBouncer] --> F[Primary]
        F --> G[Multiple Replicas]
        F --> H[TimescaleDB Extension]
    end
```

| Concern | Solution | When |
|---------|----------|------|
| **Growing `test_results` table** | Range partition by `created_at` (monthly) | >1M rows |
| **Read-heavy dashboard** | PostgreSQL read replica | >10 concurrent users |
| **Connection exhaustion** | PgBouncer connection pooling | >50 connections |
| **Historical data queries** | BRIN indexes on time columns | Immediately |
| **Data retention** | `DETACH PARTITION` + `DROP` (O(1)) | >6 months data |

### Table Partitioning (Prepared Schema)

```sql
-- Partition test_results by month
CREATE TABLE test_results (
  id UUID NOT NULL,
  test_run_id UUID NOT NULL,
  test_name VARCHAR(500) NOT NULL,
  test_file VARCHAR(500),
  status VARCHAR(20) NOT NULL,
  duration_ms INT,
  retry_count INT DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)  -- Include partition key
) PARTITION BY RANGE (created_at);

-- Create partitions (automate with pg_partman or cron)
CREATE TABLE test_results_2024_12 
  PARTITION OF test_results 
  FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');
```

### Horizontal Scaling Path

| Stage | Users | Data Volume | Architecture |
|-------|-------|-------------|--------------|
| **MVP** | 1-5 | <100K results | Single PostgreSQL, single Hono instance |
| **Team** | 5-20 | <1M results | + Read replica, partitioning |
| **Org** | 20-100 | <10M results | + PgBouncer, multiple API instances |
| **Enterprise** | 100+ | >10M results | TimescaleDB, Citus, dedicated infra |

---

## GitLab CI Integration

```yaml
e2e-tests:
  image: mcr.microsoft.com/playwright:latest
  script:
    - npm ci
    - npx playwright test --reporter=json --output-file=results.json
  after_script:
    - |
      curl -X POST "$FLACKYNESS_API/api/v1/reports" \
        -H "Authorization: Bearer $FLACKYNESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d @results.json \
        -F "project=$CI_PROJECT_NAME" \
        -F "branch=$CI_COMMIT_REF_NAME" \
        -F "commit=$CI_COMMIT_SHA" \
        -F "pipeline=$CI_PIPELINE_ID"
  artifacts:
    paths:
      - results.json
    when: always
```

---

## Hosting Options

### Option 1: Self-Hosted (Docker Compose) ⭐ Recommended

Best for: Full control, on-premise requirements, no recurring costs.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: flackyness
      POSTGRES_PASSWORD: ${DB_PASSWORD}

  api:
    build: ./apps/api
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgres://postgres:${DB_PASSWORD}@postgres/flackyness

  dashboard:
    build: ./apps/dashboard
    ports:
      - "3000:3000"
    environment:
      API_URL: http://api:8080

volumes:
  postgres_data:
```

| Pros | Cons |
|------|------|
| No monthly cost | You manage uptime |
| Full data control | Need reverse proxy (Caddy/nginx) |
| Works behind firewall | Manual SSL setup |

---

### Option 2: fly.io

Best for: Simple deployment, global edge, low cost.

| Component | fly.io Service | Cost (Est.) |
|-----------|----------------|-------------|
| API (Hono) | Fly Machine | ~$5/mo (shared-cpu-1x) |
| Dashboard (SvelteKit) | Fly Machine | ~$5/mo |
| PostgreSQL | Fly Postgres | ~$7/mo (1GB) |
| **Total** | | **~$17/mo** |

```bash
# Deploy commands
fly launch --name flackyness-api
fly postgres create --name flackyness-db
fly deploy
```

| Pros | Cons |
|------|------|
| Easy CLI deployment | Postgres on Fly can be finnicky |
| Free SSL | Cold starts on low-tier |
| Global regions | Limited dashboard visibility |

---

### Option 3: Railway

Best for: Simplest setup, visual dashboard, quick iteration.

| Component | Railway Service | Cost (Est.) |
|-----------|-----------------|-------------|
| API + Dashboard | 2 Services | ~$5-10/mo |
| PostgreSQL | Railway Postgres | ~$5/mo (hobby) |
| **Total** | | **~$10-15/mo** |

| Pros | Cons |
|------|------|
| GitHub integration | Less control than fly.io |
| Great web UI | Can get expensive at scale |
| Automatic previews | |

---

### Option 4: Render

Best for: Heroku-like experience, straightforward pricing.

| Component | Render Service | Cost (Est.) |
|-----------|----------------|-------------|
| API | Web Service | $7/mo (starter) |
| Dashboard | Static Site or Web Service | Free - $7/mo |
| PostgreSQL | Render Postgres | $7/mo (starter) |
| **Total** | | **~$14-21/mo** |

---

### Comparison Summary

| Criteria | Docker (Self) | fly.io | Railway | Render |
|----------|---------------|--------|---------|--------|
| **Setup effort** | Medium | Low | Very Low | Low |
| **Monthly cost** | $0 (+ hosting) | ~$17 | ~$12 | ~$17 |
| **Scalability** | Manual | Good | Good | Good |
| **Data control** | Full | Cloud | Cloud | Cloud |
| **Best for** | On-prem/airgap | Edge/global | Quick start | Heroku users |

> [!TIP]
> **My recommendation**: Start with **Docker Compose** locally for development. For production, **fly.io** offers the best balance of control and simplicity if you're comfortable with CLI. **Railway** if you prefer a visual dashboard.

---

## Project Structure

```
flackyness/
├── apps/
│   ├── api/                    # Hono backend
│   │   ├── src/
│   │   │   ├── routes/         # API endpoints
│   │   │   ├── middleware/     # Auth, rate limiting, validation
│   │   │   ├── services/       # Business logic
│   │   │   ├── parsers/        # Playwright JSON parser
│   │   │   └── db/             # Drizzle schema + queries
│   │   └── package.json
│   │
│   └── dashboard/              # SvelteKit frontend
│       ├── src/
│       │   ├── routes/         # SvelteKit pages
│       │   ├── lib/
│       │   │   ├── components/ # Svelte components
│       │   │   ├── charts/     # ECharts wrappers
│       │   │   └── api.ts      # API client
│       │   └── hooks.server.ts # Auth middleware
│       └── package.json
│
├── packages/
│   └── shared/                 # Shared types/utilities
│
├── docker-compose.yml          # PostgreSQL + apps
├── .gitlab-ci.yml              # Example CI config
└── README.md
```

---

## Finalized Decisions

| Decision | Choice | Notes |
|----------|--------|-------|
| **Playwright format** | Built-in JSON (`--reporter=json`) | Simple, no extra deps |
| **Auth (MVP)** | API tokens per project | Dashboard login post-MVP |
| **GitLab integration** | `curl` from `after_script` | Simplest, immediate |
| **Hosting** | Docker Compose (self-hosted) | fly.io/Railway as alternatives |

---

## Implementation Checklist

### Phase 1: Project Setup

#### 1.1 Monorepo Structure
- [ ] Initialize pnpm workspace in `/flackyness`
- [ ] Create `pnpm-workspace.yaml` with apps/packages structure
- [ ] Create `apps/api/package.json` (Hono + TypeScript)
- [ ] Create `apps/dashboard/package.json` (SvelteKit)
- [ ] Create `packages/shared/package.json` (shared types)
- [ ] Add root `package.json` with workspace scripts
- [ ] Configure TypeScript (`tsconfig.json` at root + per package)
- [ ] Add `.gitignore`, `.env.example`

#### 1.2 Database Setup
- [ ] Create `docker-compose.yml` with PostgreSQL 16
- [ ] Install Drizzle ORM + `drizzle-kit` in api
- [ ] Create `apps/api/src/db/schema.ts` with tables:
  - [ ] `projects` table
  - [ ] `test_runs` table  
  - [ ] `test_results` table (with partition prep)
  - [ ] `flaky_tests` table
- [ ] Create initial migration
- [ ] Add seed script with sample project

#### 1.3 API Foundation
- [ ] Set up Hono app entry point (`apps/api/src/index.ts`)
- [ ] Add health check endpoint (`GET /health`)
- [ ] Configure CORS middleware
- [ ] Configure secure headers middleware
- [ ] Add environment config (`DATABASE_URL`, `API_PORT`)
- [ ] Verify API starts and connects to DB

---

### Phase 2: Ingestion Pipeline

#### 2.1 Playwright JSON Parser
- [ ] Create `apps/api/src/parsers/playwright.ts`
- [ ] Define Zod schema for Playwright JSON format
- [ ] Parse test suites, specs, and test cases
- [ ] Extract: test name, file, status, duration, retries, errors
- [ ] Add unit tests for parser

#### 2.2 Report Ingestion Endpoint
- [ ] Create `POST /api/v1/reports` route
- [ ] Accept JSON body + query params (project, branch, commit, pipeline)
- [ ] Validate input with Zod
- [ ] Create `test_run` record
- [ ] Insert `test_results` for each test
- [ ] Return success response with run ID

#### 2.3 Authentication
- [ ] Create `apps/api/src/middleware/auth.ts`
- [ ] Hash token function (SHA-256)
- [ ] Bearer auth middleware for `/api/v1/reports`
- [ ] Add `token_hash` column to projects table
- [ ] Create endpoint to generate project token (admin only)

#### 2.4 Rate Limiting
- [ ] Install `hono-rate-limiter`
- [ ] Configure 60 req/min per token on ingestion
- [ ] Configure 100 req/min per IP on read endpoints
- [ ] Return proper 429 responses

---

### Phase 3: Flakiness Detection

#### 3.1 Detection Algorithm
- [ ] Create `apps/api/src/services/flakiness.ts`
- [ ] Implement `detectFlakyTests(projectId, windowDays)`:
  - [ ] Query test results in time window
  - [ ] Group by test name
  - [ ] Calculate pass/fail/flaky counts
  - [ ] Compute flake rate
- [ ] Flag tests with flake rate > threshold (default 5%)
- [ ] Update `flaky_tests` table with computed stats

#### 3.2 Background Processing
- [ ] Run detection after each report ingestion
- [ ] Update flaky test records (upsert)
- [ ] Track `first_detected`, `last_seen`, `flake_count`

#### 3.3 API Endpoints for Dashboard
- [ ] `GET /api/v1/projects` — list projects
- [ ] `GET /api/v1/projects/:id/flaky-tests` — flaky tests list
- [ ] `GET /api/v1/projects/:id/stats` — overview metrics
- [ ] `GET /api/v1/tests/:id/history` — test run history

---

### Phase 4: SvelteKit Dashboard

#### 4.1 Dashboard Setup
- [ ] Initialize SvelteKit app (`npm create svelte@latest`)
- [ ] Configure adapter-node for Docker
- [ ] Set up API client (`apps/dashboard/src/lib/api.ts`)
- [ ] Add environment config for API URL

#### 4.2 Layout & Navigation
- [ ] Create root layout with sidebar
- [ ] Project selector dropdown
- [ ] Navigation: Overview, Flaky Tests, Runs

#### 4.3 Overview Page (`/`)
- [ ] Fetch project stats
- [ ] Display key metrics cards:
  - [ ] Total tests tracked
  - [ ] Active flaky tests count
  - [ ] Overall flake rate %
  - [ ] Tests fixed this week
- [ ] Flake rate trend chart (ECharts line)

#### 4.4 Flaky Tests Page (`/flaky`)
- [ ] Data table with columns: Test Name, File, Flake Rate, Last Seen, Status
- [ ] Sortable by flake rate, last seen
- [ ] Filter by branch
- [ ] Click row → test detail page

#### 4.5 Test Detail Page (`/tests/[id]`)
- [ ] Test info header (name, file, current status)
- [ ] History timeline chart (ECharts)
- [ ] Recent runs table with pass/fail/flaky badges
- [ ] Error messages from failed runs

#### 4.6 ECharts Integration
- [ ] Install `echarts` + `svelte-echarts` (or wrapper)
- [ ] Create reusable chart components:
  - [ ] Line chart (trends)
  - [ ] Heatmap (optional: flakiness calendar)
- [ ] Responsive sizing

---

### Phase 5: Production Readiness

#### 5.1 Docker Configuration
- [ ] `apps/api/Dockerfile` (multi-stage build)
- [ ] `apps/dashboard/Dockerfile` (SvelteKit node adapter)
- [ ] Update `docker-compose.yml` for production:
  - [ ] postgres service with volume
  - [ ] api service with healthcheck
  - [ ] dashboard service with API_URL
- [ ] Add `docker-compose.override.yml` for dev

#### 5.2 Error Handling & Logging
- [ ] Global error handler in Hono
- [ ] Structured logging (JSON format)
- [ ] Log ingestion events, errors, auth failures
- [ ] SvelteKit error pages (404, 500)

#### 5.3 Documentation
- [ ] `README.md` with setup instructions
- [ ] `.env.example` with all variables
- [ ] Example `.gitlab-ci.yml` snippet
- [ ] API documentation (endpoints, auth)

#### 5.4 Testing
- [x] Unit tests: parser, flakiness algorithm
- [x] Integration tests: API endpoints
- [ ] E2E tests: key dashboard flows (Playwright)
- [x] CI pipeline for tests

---

### Phase 6: Security & Performance Hardening

> **Status:** Based on code review findings  
> **Priority:** Critical for production deployment

#### 6.1 Rate Limiting (CRITICAL)
- [ ] Install `hono-rate-limiter` package
- [ ] Create rate limiting middleware:
  - [ ] Report ingestion: 60 requests/min per project token
  - [ ] Read endpoints: 100 requests/min per IP
  - [ ] Admin endpoints: 20 requests/min per IP
- [ ] Add rate limit headers (X-RateLimit-*)
- [ ] Return 429 with Retry-After header
- [ ] Test rate limiting with automated scripts

#### 6.2 Database Indexes (CRITICAL)
- [ ] Add indexes to schema:
  - [ ] `test_results.test_run_id` (FK lookups)
  - [ ] `test_results.test_name` (flakiness detection)
  - [ ] `test_results.created_at` (BRIN for time-series)
  - [ ] `flaky_tests(project_id, status)` composite
  - [ ] `test_runs.project_id` (dashboard queries)
- [ ] Generate migration with drizzle-kit
- [ ] Verify query performance improvement

#### 6.3 Admin Endpoints
- [ ] Create admin authentication middleware
- [ ] Implement endpoints:
  - [ ] `POST /api/v1/admin/projects` - Create project + generate token
  - [ ] `POST /api/v1/admin/projects/:id/rotate-token` - Rotate token
  - [ ] `GET /api/v1/admin/projects` - List all projects with stats
  - [ ] `DELETE /api/v1/admin/projects/:id` - Delete project
  - [ ] `GET /api/v1/admin/health` - System health metrics
- [ ] Add ADMIN_TOKEN to .env with strong random value
- [ ] Document admin API in docs/API.md

#### 6.4 Input Validation & Limits
- [ ] Add body size limit middleware (10MB max)
- [ ] Add pagination max limits (100 items)
- [ ] Validate query parameters:
  - [ ] Numeric limits (e.g., days: 1-365)
  - [ ] String length limits
  - [ ] Enum validation for status filters
- [ ] Add request timeout (30s for ingestion, 10s for reads)

#### 6.5 Code Quality Improvements
- [ ] Enable TypeScript strict mode in tsconfig.json
- [ ] Replace all `console.error` with structured logger
- [ ] Add JSDoc comments to all exported functions
- [ ] Run ESLint with recommended rules
- [ ] Fix any remaining TypeScript warnings

#### 6.6 Monitoring & Observability
- [ ] Add Prometheus metrics endpoint (`/metrics`)
- [ ] Track key metrics:
  - [ ] Report ingestion count/rate
  - [ ] API response times (p50, p95, p99)
  - [ ] Database query duration
  - [ ] Active connections
  - [ ] Error rates by endpoint
- [ ] Add structured error tracking
- [ ] Create Grafana dashboard template (optional)

#### 6.7 Security Hardening
- [ ] Add helmet.js integration for additional headers
- [ ] Implement CSRF protection for future web forms
- [ ] Add security.txt file
- [ ] Run npm audit and fix vulnerabilities
- [ ] Add dependabot configuration
- [ ] Create SECURITY.md with disclosure policy

#### 6.8 Performance Optimization
- [ ] Add database connection pooling configuration
- [ ] Implement query result caching (Redis optional)
- [ ] Optimize flakiness detection query
- [ ] Add database query logging in development
- [ ] Profile critical endpoints with load testing

---

## Verification Checklist

### Functional Testing
- [x] Submit report via curl → appears in DB
- [x] Flaky test detected after inconsistent results
- [x] Dashboard displays correct data
- [ ] Rate limiting triggers at threshold
- [x] Invalid token returns 401

### Performance Testing
- [ ] Ingestion handles 1000 test results per report
- [ ] Dashboard loads in <2s with 10K results
- [ ] Partition queries use pruning correctly

### Security Testing
- [ ] Rate limiting prevents abuse
- [ ] Invalid tokens rejected
- [ ] SQL injection attempts fail
- [ ] XSS attempts sanitized
- [ ] Large payloads rejected (>10MB)

### Production Readiness
- [ ] All Phase 6 tasks completed
- [ ] Load testing passed (100 req/s for 5 min)
- [ ] Zero TypeScript errors
- [ ] Zero security vulnerabilities
- [ ] Documentation complete
