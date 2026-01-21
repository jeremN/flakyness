# Getting Started with Flackyness 🎭

This guide walks you through setting up Flackyness and connecting your first project.

## Table of Contents

1. [Quick Setup](#quick-setup)
2. [Create Your First Project](#create-your-first-project)
3. [Connect GitLab CI](#connect-gitlab-ci)
4. [View Results in Dashboard](#view-results-in-dashboard)
5. [Production Deployment](#production-deployment)

---

## Quick Setup

### Prerequisites

- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- Docker & Docker Compose

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/flackyness.git
cd flackyness
pnpm install
```

### 2. Start Database

```bash
docker compose up -d
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add a secure admin token:

```bash
# Generate a secure token
openssl rand -hex 32

# Add to .env
ADMIN_TOKEN=your-generated-token-here
```

### 4. Run Migrations

```bash
pnpm db:migrate
```

### 5. Start Development Servers

```bash
pnpm dev
```

You now have:
- **API** running at http://localhost:8080
- **Dashboard** running at http://localhost:5173

---

## Create Your First Project

Use the Admin API to create a project and get an API token.

### Using curl

```bash
# Set your admin token
export ADMIN_TOKEN="your-admin-token"

# Create a project
curl -X POST "http://localhost:8080/api/v1/admin/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-awesome-project"}'
```

**Response:**
```json
{
  "project": {
    "id": "abc-123-...",
    "name": "my-awesome-project"
  },
  "token": "flackyness_abc123def456...",
  "warning": "Save this token securely. It will not be shown again."
}
```

> ⚠️ **Important:** Save the `token` value! You'll need it for CI integration.

### View All Projects

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:8080/api/v1/admin/projects
```

---

## Connect GitLab CI

### 1. Add CI/CD Variable

In your GitLab project, go to **Settings → CI/CD → Variables** and add:

| Variable | Value | Masked |
|----------|-------|--------|
| `FLACKYNESS_TOKEN` | Your project token from above | ✅ Yes |
| `FLACKYNESS_API` | `https://your-flackyness-url.com` | No |

### 2. Update `.gitlab-ci.yml`

Add this job to your pipeline:

```yaml
e2e-tests:
  stage: test
  image: mcr.microsoft.com/playwright:latest
  script:
    - npm ci
    - npx playwright install --with-deps
    - npx playwright test --reporter=json --output-file=playwright-report.json
  after_script:
    - |
      if [ -f playwright-report.json ]; then
        curl -X POST "${FLACKYNESS_API}/api/v1/reports?branch=${CI_COMMIT_REF_NAME}&commit=${CI_COMMIT_SHA}&pipeline=${CI_PIPELINE_ID}" \
          -H "Authorization: Bearer ${FLACKYNESS_TOKEN}" \
          -H "Content-Type: application/json" \
          -d @playwright-report.json \
          --fail --silent --show-error
        echo "Report uploaded to Flackyness"
      fi
  artifacts:
    paths:
      - playwright-report.json
      - test-results/
    when: always
    expire_in: 7 days
```

### 3. Run Your First Pipeline

Push a commit to trigger the pipeline. After it completes, Flackyness will have your test results!

---

## View Results in Dashboard

Open http://localhost:5173 (or your production URL) to see:

### Overview Page
- **Active Flaky Tests** - Tests currently marked as flaky
- **Flake Rate Trend** - 7-day chart of your flake rate
- **Recent Test Runs** - Latest pipeline results

### Flaky Tests Page
- Filter by status: Active, Resolved, All
- See flake rate and run count for each test
- Click a test to see its full history

### Test Detail Page
- Run-by-run history
- Error messages from failures
- Duration trends

---

## Production Deployment

### Option 1: Docker Compose (Recommended)

```bash
# Clone on your server
git clone https://github.com/yourusername/flackyness.git
cd flackyness

# Create production .env
cat > .env << EOF
DATABASE_URL=postgres://postgres:secure-password@db:5432/flackyness
ADMIN_TOKEN=$(openssl rand -hex 32)
PUBLIC_API_URL=https://your-domain.com
EOF

# Start production stack
docker compose --profile production up -d

# Run migrations
docker compose exec api pnpm db:migrate
```

### Option 2: Kubernetes / Cloud Run

Build the Docker images and deploy to your container platform:

```bash
# Build images
docker build -t flackyness-api ./apps/api
docker build -t flackyness-dashboard ./apps/dashboard

# Push to your registry
docker push your-registry/flackyness-api
docker push your-registry/flackyness-dashboard
```

### Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name flackyness.example.com;

    # API
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Dashboard
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```

---

## Next Steps

- **Rotate tokens regularly** using `POST /api/v1/admin/projects/:id/rotate-token`
- **Set up alerts** (coming soon) for new flaky tests
- **Monitor health** via `GET /api/v1/admin/health`

## Troubleshooting

### "Invalid project token" error

1. Check the token is correct in your CI/CD variables
2. Ensure the token is masked but not protected
3. Verify the project exists: `curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8080/api/v1/admin/projects`

### No data in dashboard

1. Verify reports are being uploaded: check CI job logs
2. Ensure the API is reachable from your CI runners
3. Check API logs: `docker compose logs api`

### Dashboard shows 500 error

1. Check API is running: `curl http://localhost:8080/health`
2. Verify `PUBLIC_API_URL` is correct
3. Check for CORS issues in browser console

---

## Need Help?

- 📖 [Full API Documentation](docs/API.md)
- 🐛 [Report an Issue](https://github.com/yourusername/flackyness/issues)
