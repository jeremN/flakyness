# Flackyness 🎭

A self-hosted flaky test tracking system for CI/CD pipelines. Collect, analyze, and visualize flaky E2E test data from Playwright test runs.

## Features

- 📊 **Dashboard** - Visualize flaky test trends and metrics
- 🔍 **Flaky Detection** - Automatically detect tests with inconsistent results
- 📈 **Trend Analysis** - Track flake rates over time with ECharts
- 🔌 **GitLab CI Integration** - Simple curl-based report upload
- 🐳 **Docker Ready** - Easy self-hosted deployment

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Backend** | Hono + TypeScript |
| **Database** | PostgreSQL + Drizzle ORM |
| **Dashboard** | SvelteKit + ECharts |
| **Deployment** | Docker Compose |

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker & Docker Compose

### Development Setup

1. **Clone and install dependencies**
   ```bash
   git clone https://github.com/yourusername/flackyness.git
   cd flackyness
   pnpm install
   ```

2. **Start PostgreSQL**
   ```bash
   docker compose up -d
   ```

3. **Copy environment file**
   ```bash
   cp .env.example .env
   ```

4. **Run database migrations**
   ```bash
   pnpm db:migrate
   ```

5. **Seed sample data (optional)**
   ```bash
   pnpm db:seed
   ```

6. **Start development servers**
   ```bash
   pnpm dev
   ```

   - API: http://localhost:8080
   - Dashboard: http://localhost:5173

### Production Deployment (Docker)

Build and run the full stack with Docker:

```bash
# Set your database password
export DB_PASSWORD=your-secure-password

# Build and start all services
docker compose --profile production up -d

# Run database migrations
docker compose exec api node dist/db/migrate.js
```

Services:
- **API**: http://localhost:8080
- **Dashboard**: http://localhost:3000
- **PostgreSQL**: localhost:5432

## Project Structure

```
flackyness/
├── apps/
│   ├── api/                    # Hono backend
│   │   ├── src/
│   │   │   ├── routes/         # API endpoints
│   │   │   ├── middleware/     # Auth, logging
│   │   │   ├── services/       # Business logic
│   │   │   ├── parsers/        # Playwright JSON parser
│   │   │   └── db/             # Drizzle schema
│   │   └── Dockerfile
│   │
│   └── dashboard/              # SvelteKit frontend
│       ├── src/
│       │   ├── routes/         # Pages
│       │   └── lib/
│       │       ├── components/ # UI components
│       │       └── api.ts      # API client
│       └── Dockerfile
│
├── docs/
│   └── API.md                  # API documentation
├── docker-compose.yml          # Production config
└── docker-compose.override.yml # Development overrides
```

## Environment Variables

Create a `.env` file based on `.env.example`:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@localhost:5432/flackyness` |
| `API_PORT` | API server port | `8080` |
| `API_HOST` | API server host | `0.0.0.0` |
| `PUBLIC_API_URL` | Dashboard → API URL | `http://localhost:8080` |
| `DB_PASSWORD` | Database password (Docker) | `postgres` |
| `ADMIN_TOKEN` | Admin API authentication token | (required for admin endpoints) |

> 💡 Generate a secure admin token: `openssl rand -hex 32`

## GitLab CI Integration

Add to your `.gitlab-ci.yml`:

```yaml
e2e-tests:
  image: mcr.microsoft.com/playwright:latest
  variables:
    FLACKYNESS_API: "https://your-flackyness-instance.com"
  script:
    - npm ci
    - npx playwright test --reporter=json --output-file=results.json
  after_script:
    - |
      curl -X POST "$FLACKYNESS_API/api/v1/reports?branch=$CI_COMMIT_REF_NAME&commit=$CI_COMMIT_SHA&pipeline=$CI_PIPELINE_ID" \
        -H "Authorization: Bearer $FLACKYNESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d @results.json
  artifacts:
    paths:
      - results.json
    when: always
```

Set these CI/CD variables:
- `FLACKYNESS_TOKEN`: Your project's API token (get from admin API)

## API Endpoints

See [docs/API.md](docs/API.md) for full API documentation.

### Quick Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | - | Health check |
| `POST` | `/api/v1/reports` | Project | Upload Playwright report |
| `GET` | `/api/v1/projects` | - | List projects |
| `GET` | `/api/v1/projects/:id/stats` | - | Project statistics |
| `GET` | `/api/v1/projects/:id/flaky-tests` | - | Flaky tests list |
| `GET` | `/api/v1/projects/:id/runs` | - | Test runs list |
| `GET` | `/api/v1/tests/:name/history` | - | Test history |

### Admin API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/projects` | List all projects with stats |
| `POST` | `/api/v1/admin/projects` | Create project + generate token |
| `POST` | `/api/v1/admin/projects/:id/rotate-token` | Rotate project token |
| `DELETE` | `/api/v1/admin/projects/:id` | Delete project |
| `GET` | `/api/v1/admin/health` | System health metrics |

All admin endpoints require: `Authorization: Bearer $ADMIN_TOKEN`

## Development

### Available Scripts

```bash
# Root level
pnpm dev          # Start all dev servers
pnpm build        # Build all packages
pnpm test         # Run tests
pnpm lint         # Lint code

# API (in apps/api)
pnpm dev          # Start API in watch mode
pnpm test         # Run API tests
pnpm db:migrate   # Run migrations
pnpm db:studio    # Open Drizzle Studio
pnpm db:seed      # Seed sample data

# Dashboard (in apps/dashboard)
pnpm dev          # Start dashboard
pnpm build        # Build for production
pnpm check        # Type check
```

### Database Migrations

```bash
# Generate new migration
pnpm db:generate

# Apply migrations
pnpm db:migrate

# Push schema changes (dev only)
pnpm db:push
```

## Troubleshooting

### API can't connect to database

1. Ensure PostgreSQL is running: `docker compose ps`
2. Check connection string in `.env`
3. Verify port 5432 is available

### Dashboard shows "Internal Error"

1. Ensure API is running at the URL specified in `PUBLIC_API_URL`
2. Check browser console for CORS errors
3. Verify API health: `curl http://localhost:8080/health`

### Docker build fails

1. Ensure you're in the project root
2. Run `pnpm install` first to generate lock file
3. Check Docker has enough disk space

## License

MIT
