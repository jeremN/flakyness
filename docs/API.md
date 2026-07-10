# Flackyness API Documentation

Base URL: `http://localhost:8080` (development) or your production URL

## Authentication

All write endpoints require Bearer token authentication:

```http
Authorization: Bearer your-project-token
```

Tokens are generated per-project and should be stored securely (e.g., GitLab CI/CD variables).

---

## Endpoints

### Health Check

```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-12-11T12:00:00.000Z"
}
```

---

### API Info

```http
GET /api/v1
```

**Response:**
```json
{
  "name": "Flackyness API",
  "version": "0.0.1"
}
```

---

### Projects

#### List Projects

```http
GET /api/v1/projects
```

**Response:**
```json
{
  "projects": [
    {
      "id": "uuid",
      "name": "my-project",
      "createdAt": "2024-12-01T00:00:00.000Z"
    }
  ]
}
```

#### Get Project Stats

```http
GET /api/v1/projects/:id/stats
```

**Response:**
```json
{
  "project": {
    "id": "uuid",
    "name": "my-project"
  },
  "activeFlakyTests": 5,
  "resolvedThisWeek": 2,
  "totalRuns": 150,
  "totalTests": 250
}
```

#### Get Project Flaky Tests

```http
GET /api/v1/projects/:id/flaky-tests?status=active&limit=50
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | `active` | Filter by status: `active`, `resolved`, `ignored`, or `all` |
| `limit` | number | `50` | Number of flaky tests to return, clamped to `[1, 100]` |

**Response:**
```json
{
  "flakyTests": [
    {
      "id": "uuid",
      "testName": "user login should work",
      "testFile": "tests/auth.spec.ts",
      "firstDetected": "2024-12-01T00:00:00.000Z",
      "lastSeen": "2024-12-11T00:00:00.000Z",
      "flakeCount": 15,
      "totalRuns": 50,
      "flakeRate": "0.30",
      "status": "active"
    }
  ]
}
```

#### Get Project Test Runs

```http
GET /api/v1/projects/:id/runs?limit=20
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | `20` | Number of runs to return |

**Response:**
```json
{
  "runs": [
    {
      "id": "uuid",
      "branch": "main",
      "commitSha": "abc123def456",
      "pipelineId": "12345",
      "startedAt": "2024-12-11T12:00:00.000Z",
      "finishedAt": "2024-12-11T12:05:00.000Z",
      "totalTests": 100,
      "passed": 95,
      "failed": 3,
      "skipped": 1,
      "flaky": 1,
      "createdAt": "2024-12-11T12:00:00.000Z"
    }
  ]
}
```

#### Get Real-Time Flakiness Analysis

```http
GET /api/v1/projects/:id/analysis?days=14&threshold=0.05
```

Computes flakiness directly from stored test results (not cached). Responds
`404` if the project doesn't exist.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | number | project's `windowDays` override, else `14` | Analysis window in days, clamped to `[1, 90]` |
| `threshold` | number | project's `flakeThreshold` override, else `0.05` | Flake-rate threshold (0–1) above which a test is considered flaky, clamped to `[0, 1]` |

An explicit `days` or `threshold` query param always overrides the project's
stored config (see [Update Project Flakiness Config](#update-project-flakiness-config)).
`minRuns` is not query-overridable here; it always comes from the project's
resolved config (default `3`).

**Response:**
```json
{
  "windowDays": 14,
  "threshold": 0.05,
  "flakyTests": [
    {
      "testName": "user login should work",
      "testFile": "tests/auth.spec.ts",
      "totalRuns": 20,
      "passCount": 15,
      "failCount": 2,
      "flakyCount": 3,
      "flakeRate": 0.15,
      "isFlaky": true,
      "lastSeen": "2024-12-11T12:00:00.000Z"
    }
  ],
  "allTests": [
    {
      "testName": "user login should work",
      "testFile": "tests/auth.spec.ts",
      "totalRuns": 20,
      "passCount": 15,
      "failCount": 2,
      "flakyCount": 3,
      "flakeRate": 0.15,
      "isFlaky": true,
      "lastSeen": "2024-12-11T12:00:00.000Z"
    }
  ]
}
```

#### Get Flake Rate Trend

```http
GET /api/v1/projects/:id/trend?days=7
```

Daily flake rate aggregation for the requested window.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | number | `7` | Trend window in days, clamped to `[1, 90]` |

**Response:**
```json
{
  "days": ["Jul 4", "Jul 5", "Jul 6", "Jul 7", "Jul 8", "Jul 9", "Jul 10"],
  "rates": [1.2, 0.0, 2.5, 1.8, 0.0, 3.1, 1.2]
}
```

`rates` are flake percentages (0–100) per day, computed as `(flaky + failed) / total * 100`.

---

### Reports

#### Upload Playwright Report

```http
POST /api/v1/reports?branch=main&commit=abc123&pipeline=12345
```

The target project is identified by the Bearer token — there is no `project` parameter.

**Headers:**
```http
Authorization: Bearer your-project-token
Content-Type: application/json
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch` | string | No | Git branch name; defaults to `main`; max 255 chars |
| `commit` | string | Yes | Git commit SHA, max 40 chars |
| `pipeline` | string | No | CI pipeline ID; max 100 chars |

**Body:** Raw Playwright JSON report (from `--reporter=json`)

**Response (201):**
```json
{
  "success": true,
  "testRun": {
    "id": "uuid",
    "project": "my-project",
    "branch": "main",
    "commit": "abc123",
    "pipeline": "12345",
    "summary": {
      "total": 100,
      "passed": 95,
      "failed": 2,
      "flaky": 3,
      "skipped": 0
    }
  }
}
```

---

### Tests

#### Get Test History

```http
GET /api/v1/tests/:name/history?project=project-id
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | Yes | Project ID |

**Response:**
```json
{
  "testName": "user login should work",
  "flakyInfo": {
    "id": "uuid",
    "testName": "user login should work",
    "testFile": "tests/auth.spec.ts",
    "flakeRate": "0.30",
    "status": "active",
    "firstDetected": "2024-12-01T00:00:00.000Z",
    "lastSeen": "2024-12-11T00:00:00.000Z"
  },
  "stats": {
    "totalRuns": 50,
    "passed": 35,
    "failed": 10,
    "flaky": 5,
    "skipped": 0,
    "avgDuration": 1500
  },
  "history": [
    {
      "id": "uuid",
      "status": "flaky",
      "durationMs": 1234,
      "retryCount": 1,
      "errorMessage": null,
      "createdAt": "2024-12-11T12:00:00.000Z",
      "branch": "main",
      "commitSha": "abc123"
    }
  ]
}
```

#### Get Flaky Test by ID

```http
GET /api/v1/tests/flaky/:id
```

Returns a single flaky-test row by its UUID. Responds `404` if no flaky test with that ID exists.

**Response:**
```json
{
  "flakyTest": {
    "id": "uuid",
    "projectId": "uuid",
    "testName": "user login should work",
    "testFile": "tests/auth.spec.ts",
    "firstDetected": "2024-12-01T00:00:00.000Z",
    "lastSeen": "2024-12-11T00:00:00.000Z",
    "flakeCount": 15,
    "totalRuns": 50,
    "flakeRate": "0.30",
    "status": "active"
  }
}
```

---

## Admin Endpoints

Admin endpoints require the `ADMIN_TOKEN` environment variable for authentication.

```http
Authorization: Bearer your-admin-token
```

> ⚠️ **Security:** Set a strong `ADMIN_TOKEN` in production. Generate with: `openssl rand -hex 32`

### List All Projects

```http
GET /api/v1/admin/projects
```

**Response:**
```json
{
  "projects": [
    {
      "id": "uuid",
      "name": "my-project",
      "gitlabProjectId": "123",
      "hasToken": true,
      "createdAt": "2024-12-01T00:00:00.000Z",
      "flakeThreshold": null,
      "windowDays": null,
      "minRuns": null,
      "stats": {
        "totalRuns": 150,
        "totalTests": 5000,
        "activeFlakyTests": 5
      }
    }
  ]
}
```

`flakeThreshold`, `windowDays`, and `minRuns` are per-project flakiness detection
overrides — see [Update Project Flakiness Config](#update-project-flakiness-config).
`null` means the project uses the built-in default for that field.

### Create Project

```http
POST /api/v1/admin/projects
```

**Body:**
```json
{
  "name": "new-project",
  "gitlabProjectId": "123"  // optional
}
```

**Response (201):**
```json
{
  "project": {
    "id": "uuid",
    "name": "new-project",
    "createdAt": "2024-12-11T00:00:00.000Z"
  },
  "token": "flackyness_abc123...",
  "warning": "Save this token securely. It will not be shown again."
}
```

### Rotate Token

```http
POST /api/v1/admin/projects/:id/rotate-token
```

**Response:**
```json
{
  "project": {
    "id": "uuid",
    "name": "my-project"
  },
  "token": "flackyness_newtoken...",
  "warning": "Save this token securely. The old token is now invalid."
}
```

### Update Project Flakiness Config

```http
PATCH /api/v1/admin/projects/:id
```

Update a project's per-project flakiness detection overrides. Fields omitted
from the body are left unchanged; sending a field as `null` explicitly clears
it back to the built-in default. At least one field is required.

**Body (all fields optional, but at least one required):**
```json
{
  "flakeThreshold": 0.1,
  "windowDays": 30,
  "minRuns": 5
}
```

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `flakeThreshold` | number \| null | `[0, 1]` | Flake-rate threshold above which a test is considered flaky. `null` resets to the default (`0.05`). |
| `windowDays` | integer \| null | `[1, 90]` | Analysis window in days used by background flakiness reconciliation. `null` resets to the default (`14`). |
| `minRuns` | integer \| null | `[1, 100]` | Minimum number of runs required before a test is analyzed. `null` resets to the default (`3`). |

**Response (200):**
```json
{
  "project": {
    "id": "uuid",
    "name": "my-project",
    "gitlabProjectId": "123",
    "createdAt": "2024-12-01T00:00:00.000Z",
    "flakeThreshold": 0.1,
    "windowDays": 30,
    "minRuns": 5
  }
}
```

Returns `400` if the body fails validation (out-of-range values or an empty
body) and `404` if the project doesn't exist.

> **Tuning flakiness detection:** Flakiness is normally governed by three
> defaults — `windowDays: 14`, `flakeThreshold: 0.05`, `minRuns: 3`. This
> endpoint overrides them per project. Changes take effect on the **next
> report ingest** (the flaky-tests table is only recomputed then), and MAY
> reclassify tests already tracked for the project: tightening a threshold
> can resolve tests that no longer qualify as flaky, while loosening it can
> activate tests that newly cross the bar. This is expected, not a bug.
> `GET /api/v1/projects/:id/analysis` picks up overrides immediately (it's
> computed live), but explicit `days`/`threshold` query params on that
> endpoint still take precedence over the stored project config.

### Delete Project

```http
DELETE /api/v1/admin/projects/:id
```

**Response:**
```json
{
  "success": true,
  "message": "Project \"my-project\" and all associated data deleted."
}
```

### System Health

```http
GET /api/v1/admin/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-12-11T12:00:00.000Z",
  "database": {
    "projects": 5,
    "testRuns": 150,
    "testResults": 15000,
    "flakyTests": 25
  },
  "version": "0.0.1"
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message description"
}
```

### Common Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `201` | Created |
| `400` | Bad Request - Invalid input |
| `401` | Unauthorized - Missing or invalid token |
| `404` | Not Found - Resource doesn't exist |
| `409` | Conflict - Resource already exists |
| `429` | Too Many Requests - Rate limit exceeded |
| `500` | Internal Server Error |

---

## Rate Limiting

| Endpoint | Limit |
|----------|-------|
| `POST /api/v1/reports` | 60 requests/minute per token |
| `Admin endpoints` | 20 requests/minute per IP |
| All other endpoints | 100 requests/minute per IP |

When rate limited, you'll receive:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

---

## Example: Upload Report with curl

```bash
# Run Playwright tests with JSON reporter
npx playwright test --reporter=json --output-file=results.json

# Upload results
curl -X POST "https://flackyness.example.com/api/v1/reports" \
  --url-query "branch=main" \
  --url-query "commit=$(git rev-parse HEAD)" \
  --url-query "pipeline=$CI_PIPELINE_ID" \
  -H "Authorization: Bearer $FLACKYNESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @results.json
```

## Example: Create Project (Admin)

```bash
curl -X POST "http://localhost:8080/api/v1/admin/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-new-project"}'
```
