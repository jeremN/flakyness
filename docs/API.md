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
GET /api/v1/projects/:id/flaky-tests?status=active
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | `active` | Filter by status: `active`, `resolved`, `ignored`, or `all` |

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

---

### Reports

#### Upload Playwright Report

```http
POST /api/v1/reports?project=my-project&branch=main&commit=abc123&pipeline=12345
```

**Headers:**
```http
Authorization: Bearer your-project-token
Content-Type: application/json
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | Yes | Project name or ID |
| `branch` | string | Yes | Git branch name |
| `commit` | string | Yes | Git commit SHA |
| `pipeline` | string | No | CI pipeline ID |

**Body:** Raw Playwright JSON report (from `--reporter=json`)

**Response:**
```json
{
  "success": true,
  "runId": "uuid",
  "testsProcessed": 100,
  "flakyDetected": 3
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
      "stats": {
        "totalRuns": 150,
        "totalTests": 5000,
        "activeFlakyTests": 5
      }
    }
  ]
}
```

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
  -H "Authorization: Bearer $FLACKYNESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @results.json \
  --data-urlencode "project=my-project" \
  --data-urlencode "branch=main" \
  --data-urlencode "commit=$(git rev-parse HEAD)" \
  --data-urlencode "pipeline=$CI_PIPELINE_ID"
```

## Example: Create Project (Admin)

```bash
curl -X POST "http://localhost:8080/api/v1/admin/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-new-project"}'
```
