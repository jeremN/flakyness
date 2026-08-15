# Getting Started with Flackyness 🎭

This guide walks you through setting up Flackyness and connecting your first project.

## Table of Contents

1. [Quick Setup](#quick-setup)
2. [Create Your First User Account](#create-your-first-user-account)
3. [Create Your First Project](#create-your-first-project)
4. [Connect GitLab CI](#connect-gitlab-ci)
5. [View Results in Dashboard](#view-results-in-dashboard)
6. [Production Deployment](#production-deployment)

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

### 2. Configure Environment

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

There is no dashboard password to set — the dashboard authenticates real user
accounts (see [Create Your First User Account](#create-your-first-user-account)
below), and you'll create your first one right after starting the servers.

### 3. Start Database

```bash
docker compose up -d postgres
```

Scope this to the `postgres` service only. A bare `docker compose up -d`
starts every service (dashboard, API, etc.) with hard-coded container
names, which collide with any other checkout of this repo running on the
same machine — and `docker compose` refuses to even parse its config
unless `DB_PASSWORD` and `ADMIN_TOKEN` have values, which is why the `.env`
step above comes first.

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

## Create Your First User Account

> **Upgrading from an older version?** As of plan 059, `DASHBOARD_PASSWORD`
> is gone — the dashboard authenticates real user accounts, so you MUST
> complete this section (creating a global admin below) before anyone can
> sign in at all; see "Upgrading an existing instance" further down this
> section for what else changes.

After running the migrations, create the first global admin with your
`ADMIN_TOKEN`. There is no seeded account and no self-signup — deliberately:
a migration that plants a default password is a migration that ships one to
everybody.

```bash
curl -X POST http://localhost:8080/api/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","displayName":"Your Name","isGlobalAdmin":true}'
```

The response contains a **temporary password shown exactly once** — it is
never logged, never stored in plaintext, and cannot be retrieved again. Save
it. If you lose it, `POST /api/v1/admin/users/:userId/reset-password` issues
a new one.

Sign in with it against the API (`POST /api/v1/auth/login`), which returns a
session cookie. The account is flagged `mustChangePassword: true`.

**Change the password before doing anything else — the flag is enforced.**
Until you do, that session is refused on every `/api/v1` endpoint with:

```
403 { "error": "Password change required", "code": "password_change_required" }
```

Only the requests that let you finish the change are allowed through:
`POST /api/v1/auth/login`, `POST /api/v1/auth/change-password`,
`GET`/`HEAD /api/v1/auth/me`, and `POST /api/v1/auth/logout`.

```bash
curl -X POST http://localhost:8080/api/v1/auth/change-password \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"currentPassword":"<the temporary one>","newPassword":"<a new, longer one>"}'
```

The new password must be at least 12 characters **and must differ from the
temporary one** — reusing it is refused with
`400 { "code": "password_reused" }`, because a temporary secret that survives
the "rotation" is not rotated at all. On success the flag clears, every
session for that user is revoked, and a fresh cookie is issued to you.

This same account signs in to the dashboard's own `/login` screen (plan 059)
with the identical email/password — the dashboard forwards your session to
the API rather than holding a separate credential, so there is nothing extra
to set up here.

`ADMIN_TOKEN` remains valid as a break-glass machine credential; user
accounts do not replace it. It carries no session, so it is never subject to
the password-change refusal — which is what makes it the recovery path if
every human account on an instance is somehow stuck. Full endpoint
reference: [User
Provisioning](API.md#user-provisioning), [Team &
Membership](API.md#team--membership), and [Authentication (user
accounts)](API.md#authentication-user-accounts) in the API docs.

### Upgrading an existing instance — read this before deploying

The `mustChangePassword` flag has existed since user accounts shipped, but
nothing enforced it. **This release enforces it, and it applies immediately to
rows that already exist.** No migration runs, no flag flips: the session
middleware reads `users.must_change_password` live on every request, so any
account still carrying `true` starts being refused the moment the new API
starts. That includes accounts provisioned months ago whose owner signed in
with the temporary password and never changed it.

This is not a lockout — every affected user can still recover on their own —
but it will look like one to anyone who is not expecting it.

**Who is affected:**

```sql
SELECT id, email, created_at FROM users WHERE must_change_password = true;
```

**What they should do:** sign in as usual with the password they already have
and call `POST /api/v1/auth/change-password` (see above). Login stays
available while the flag is set — being unable to log in is not a symptom of
this change.

**If someone no longer knows their password**, issue a fresh temporary one
with `ADMIN_TOKEN`:

```bash
curl -X POST http://localhost:8080/api/v1/admin/users/<userId>/reset-password \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Break-glass:** `ADMIN_TOKEN` presents no session cookie, so it is never
subject to this refusal. Every admin endpoint stays reachable with it even if
every human account on the instance is mid-reset — including the reset-password
call above. Keep it available during the upgrade.

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

### JUnit XML instead of Playwright?

Flackyness also accepts JUnit XML reports (jest-junit, pytest, Go, Maven
Surefire, Cypress, …) on the same endpoint — the format is auto-detected
from the body, so no extra query param or header is needed:

```yaml
test:
  stage: test
  script:
    - pytest --junitxml=report.xml
  after_script:
    - |
      if [ -f report.xml ]; then
        curl -X POST "${FLACKYNESS_API}/api/v1/reports?branch=${CI_COMMIT_REF_NAME}&commit=${CI_COMMIT_SHA}&pipeline=${CI_PIPELINE_ID}" \
          -H "Authorization: Bearer ${FLACKYNESS_TOKEN}" \
          -H "Content-Type: application/xml" \
          --data-binary @report.xml \
          --fail --silent --show-error
        echo "Report uploaded to Flackyness"
      fi
  artifacts:
    paths:
      - report.xml
    when: always
    expire_in: 7 days
```

Note `--data-binary` (not `-d`) — it sends the file byte-for-byte, which
matters for XML. See [Upload a Test Report](API.md#upload-a-test-report-playwright-json-or-junit-xml)
for the JUnit field mapping and status rules (JUnit has no retry
semantics, so flakiness is detected across report uploads rather than
within a single one).

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
# Required: docker-compose.yml declares this with \`:?\`, so compose refuses to
# even parse its config without it — the stack will not start.
DB_PASSWORD=$(openssl rand -hex 32)
DATABASE_URL=postgres://postgres:secure-password@db:5432/flackyness
ADMIN_TOKEN=$(openssl rand -hex 32)
READ_TOKEN=$(openssl rand -hex 32)
PUBLIC_API_URL=https://your-domain.com
ORIGIN=https://your-domain.com
COOKIE_SECURE=true
EOF

# Start production stack
docker compose --profile production up -d

# Run migrations
docker compose exec api pnpm db:migrate

# Create your first user — see "Create Your First User Account" above.
# Nobody can sign in to the dashboard until you do this.
```

> ⚠️ **Set `ORIGIN` to the dashboard's externally visible URL, or every admin
> form action 403s.** `@sveltejs/adapter-node`'s CSRF check compares the
> browser's `Origin` header against its own guess at the request's origin;
> unset, it assumes `https` regardless of how the dashboard is actually
> served, so a plain-`http` deployment rejects its own same-origin POSTs as
> `"Cross-site POST form submissions are forbidden"`. `docker-compose.yml`
> defaults it to `http://localhost:3000` so a bare `docker compose up`
> still works — override it to your real URL (behind a reverse proxy, that's
> the proxy's `https` URL, not this container's own port) once you expose
> the dashboard beyond `localhost`.

> ⚠️ **There is no `DASHBOARD_PASSWORD` to set — the dashboard authenticates
> real user accounts instead (plan 059), and this is not optional.** Every
> dashboard route redirects an anonymous visitor to `/login`
> (`apps/dashboard/src/hooks.server.ts`), and every mutating action — mute/
> unmute a flaky test, the full `/admin` console (create/edit/rotate/prune/
> delete a project, manage teams and users) — runs as *whoever is signed in*,
> forwarding their session to the API rather than spending a shared
> `ADMIN_TOKEN` on their behalf. **You must create the first global-admin
> account before anyone can use the dashboard at all** — see [Create Your
> First User Account](#create-your-first-user-account) above; skipping it
> doesn't leave the dashboard open, it leaves it unusable.

> ⚠️ **Set `COOKIE_SECURE=true` once the dashboard is served over https.**
> The dashboard's own session cookie (set at `/login`) is the only session
> cookie a browser ever holds — the API's `Set-Cookie` is consumed
> server-side and never reaches the browser. Left unset (or `false`), the
> cookie is not marked `Secure`, which is the correct *default* for a
> plain-http deployment (setting it while serving over http makes the
> browser silently drop the cookie and breaks sign-in) but should be turned
> on as soon as you're behind TLS, as in the `.env` block above.

> 💡 **Also set `READ_TOKEN` once the API is reachable by anyone other than
> you.** Unset, all 11 read endpoints (`/projects/*`, `/tests/*`) are open,
> and `GET /api/v1/projects` enumerates every project on the instance — its
> UUID is enough to read that project's stats, runs, and flaky tests. Set
> `READ_TOKEN` on **both** the `api` and `dashboard` services with the
> **same value** — the dashboard presents it as a Bearer credential on every
> server-side call (`apps/dashboard/src/lib/server/api.ts`); setting it on
> only one side either leaves reads open (API unset) or 500s every dashboard
> page (dashboard unset). A project's own token also works for its own
> project's reads — this is how the GitHub Action fetches its quarantine
> list without a second secret.

> ⚠️ **`TRUSTED_PROXY_IPS` matters as soon as the dashboard is your login
> path — set to the wrong thing, or left unset, every user shares one
> rate-limit bucket.** The dashboard is a confidential client: the browser
> never calls the API directly, the dashboard *server* does, on behalf of
> everyone who uses it. Without `TRUSTED_PROXY_IPS`, the API can't tell those
> requests apart from one another and rate-limits them all by the same
> socket address — `apiRateLimit` (100/min) and `authRateLimit` (10/min, the
> login throttle) collapse into one shared bucket for the **whole
> installation**, not per user. `docker-compose.yml` sets this for you
> automatically: the `flackyness` network is pinned to `172.28.0.0/16` and
> the `dashboard` service gets the fixed address `172.28.0.10`, which the
> `api` service trusts by default (`TRUSTED_PROXY_IPS=172.28.0.10`). If you
> run behind your own reverse proxy instead, set `TRUSTED_PROXY_IPS` to
> *that* proxy's address — and **never** a whole subnet: with a published
> port, Docker's userland proxy can present external traffic as a bridge
> address, so trusting the range would let an internet client spoof
> `X-Forwarded-For` and evade the login throttle entirely. Unset (or
> misconfigured), the API only logs a warning at boot rather than refusing
> to start, since an unset value is still correct for a genuinely
> network-isolated deployment.

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
- **Set up alerts** for new flaky tests with a webhook — point `webhookUrl` at
  your chat tool's incoming-webhook endpoint (or any HTTP receiver) and
  Flackyness POSTs a JSON payload whenever a report ingest finds a test that
  just became flaky or just resolved:

  ```bash
  curl -X PATCH http://localhost:8080/api/v1/admin/projects/<project-id> \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"webhookUrl": "https://your-endpoint.example.com/hooks/flackyness"}'
  ```

  See [Flaky-Test Transition Webhooks](API.md#flaky-test-transition-webhooks)
  for the payload schema and delivery semantics (no retries, no signing —
  v1 assumes a trusted, admin-set URL).
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
