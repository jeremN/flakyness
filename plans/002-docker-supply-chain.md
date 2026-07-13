# Plan 002: Build Docker images from the lockfile, on pnpm 11 and Node 24

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- apps/api/Dockerfile apps/dashboard/Dockerfile docker-compose.yml .github/workflows/ci.yml .github/workflows/docker-publish.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (build-infra only; app code untouched)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

Production images are currently built with **none** of the repo's dependency
guarantees:

1. The Docker build context is the app directory (`./apps/api`,
   `./apps/dashboard` — see `docker-compose.yml:31,60`,
   `.github/workflows/docker-publish.yml:41,55`), but `pnpm-lock.yaml` only
   exists at the repo root. The Dockerfiles' `COPY package.json pnpm-lock.yaml* ./`
   glob therefore matches nothing, `pnpm install --frozen-lockfile` **always
   fails**, its stderr is swallowed by `2>/dev/null`, and the `|| pnpm install`
   fallback resolves dependencies fresh and unpinned on every build.
2. The images use `corepack prepare pnpm@9` while the repo pins pnpm 11.5.1
   (`package.json#packageManager`). pnpm 9 silently ignores the pnpm-11
   supply-chain hardening in `pnpm-workspace.yaml` (`allowBuilds` build-script
   gating, `minimumReleaseAge: 1440`), so dependency lifecycle scripts that
   pnpm 11 would block can execute during image builds.
3. All four stages run `node:20-alpine`; Node 20 is past EOL (April 2026) and
   the repo requires Node ≥ 24 (`package.json#engines`, CI runs Node 24).

After this plan, images are built from the repo root with pnpm 11.5.1 on
Node 24, strictly from the lockfile, and any install failure is loud.

## Current state

Files:

- `apps/api/Dockerfile` — 2-stage build (builder + runner); pnpm 9 at lines 13
  and 40; swallow-and-fallback installs at lines 23 and 46; `node:20-alpine`
  at lines 8 and 31. Runner creates non-root user `hono` (uid 1001), copies
  `dist/`, `drizzle/`, `drizzle.config.ts`, sets a wget healthcheck on
  `/health`, `CMD ["node", "dist/index.js"]`.
- `apps/dashboard/Dockerfile` — same structure; non-root user `sveltekit`;
  copies adapter-node output `build/`; `CMD ["node", "build"]`; env
  `PORT=3000`, `PUBLIC_API_URL=http://api:8080`.
- `docker-compose.yml:30-32,59-61` — `context: ./apps/api` and
  `context: ./apps/dashboard`, `dockerfile: Dockerfile`.
- `.github/workflows/ci.yml` — `docker` job builds both images with
  `docker/build-push-action@v7`, `context: ./apps/api` / `./apps/dashboard`,
  `push: false`.
- `.github/workflows/docker-publish.yml:41,55` — same contexts, `push: true`
  to GHCR.
- Root `package.json` — `"packageManager": "pnpm@11.5.1"`, engines
  `node >=24`, `pnpm ^11.5.1`.
- `pnpm-workspace.yaml` — workspace globs `apps/*`, `packages/*`; hardening
  keys `minimumReleaseAge: 1440`, `allowBuilds: { esbuild: true }`.

The offending install pattern (both Dockerfiles, both stages):

```dockerfile
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
```

Note the header comment in both Dockerfiles ("Build from the repository
root: docker build -f apps/api/Dockerfile .") does not match reality — with a
root context, `COPY src ./src` would fail. Every real consumer uses the app
dir as context.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build API image | `docker build -f apps/api/Dockerfile -t flackyness-api:test .` (run from repo root) | exit 0 |
| Build dashboard image | `docker build -f apps/dashboard/Dockerfile -t flackyness-dashboard:test .` | exit 0 |
| Node version in image | `docker run --rm flackyness-api:test node --version` | `v24.x.x` |
| API smoke test | see Step 5 | `{"status":"ok",...}` |
| Compose build | `docker compose build` | exit 0 for api + dashboard |

## Scope

**In scope** (the only files you should modify):
- `apps/api/Dockerfile`
- `apps/dashboard/Dockerfile`
- `docker-compose.yml` (ONLY the two `build:` blocks)
- `.github/workflows/ci.yml` (ONLY the `docker` job's two `context:`/`file:` settings)
- `.github/workflows/docker-publish.yml` (ONLY the two `context:`/`file:` settings)

**Out of scope** (do NOT touch):
- Any application source under `apps/*/src`.
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`, any `package.json` — this plan
  changes how images consume them, not their contents.
- Action version tags/SHAs in workflows (plan 010 handles pinning).
- `docker-compose.override.yml`, `.env*`.

## Git workflow

- Branch: `advisor/002-docker-supply-chain`
- Conventional-commit, single-line subject only (e.g.
  `fix(docker): build images from lockfile with pnpm 11 on node 24`). Do NOT
  add any `Co-Authored-By` trailer. Do not push or open a PR unless the
  operator instructed it.

## Steps

### Step 1: Rewrite `apps/api/Dockerfile` for a root build context

Replace the file with the following (keep the non-root user, healthcheck, and
env exactly as shown — they mirror the current runner stage):

```dockerfile
# ==============================================================================
# API Dockerfile — build from the repository root:
#   docker build -f apps/api/Dockerfile .
# (docker-compose.yml and the GitHub workflows set context: . accordingly)
# ==============================================================================

# Stage 1: Build
FROM node:24-alpine AS builder

WORKDIR /repo

# corepack reads packageManager (pnpm@11.5.1) from the root package.json
RUN corepack enable

# Workspace manifests + lockfile first (layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/api/package.json apps/api/

# Strict, reproducible install. No fallback: a failure must fail the build.
RUN pnpm install --frozen-lockfile --filter api...

COPY apps/api/ apps/api/

RUN pnpm --filter api build

# Standalone production bundle (package + prod node_modules) into /out
RUN pnpm --filter api deploy --prod /out

# ==============================================================================
# Stage 2: Production
# ==============================================================================
FROM node:24-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 hono

COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./
COPY --from=builder /repo/apps/api/dist ./dist
COPY --from=builder /repo/apps/api/drizzle ./drizzle
COPY --from=builder /repo/apps/api/drizzle.config.ts ./

RUN chown -R hono:nodejs /app
USER hono

ENV NODE_ENV=production
ENV API_PORT=8080
ENV API_HOST=0.0.0.0

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
```

Notes for you (the executor):
- `--filter api...` installs `api` plus its workspace dependencies (it has
  none today, but the form is future-proof).
- `pnpm deploy` requires the lockfile — it is present because the install
  above succeeded. If `pnpm deploy` errors (see STOP conditions), use the
  fallback documented there.
- `apps/api/drizzle/` and `drizzle.config.ts` are needed at runtime for
  `node dist/db/migrate.js` per the README's production instructions — keep
  copying them.

**Verify**: from the repo root, `docker build -f apps/api/Dockerfile -t flackyness-api:test .` → exit 0, and the build log shows NO `pnpm install` without `--frozen-lockfile`.

### Step 2: Rewrite `apps/dashboard/Dockerfile` the same way

Same structure. Differences from Step 1: copy `apps/dashboard/package.json`
in the manifest layer; build copies `apps/dashboard/` sources; the deploy/out
stage ships the adapter-node output:

```dockerfile
# Stage 1 (builder): as in Step 1 but for apps/dashboard
FROM node:24-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter dashboard...
COPY apps/dashboard/ apps/dashboard/
RUN pnpm --filter dashboard build
RUN pnpm --filter dashboard deploy --prod /out

# Stage 2: Production
FROM node:24-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 sveltekit
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./
COPY --from=builder /repo/apps/dashboard/build ./build
RUN chown -R sveltekit:nodejs /app
USER sveltekit
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV PUBLIC_API_URL=http://api:8080
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1
CMD ["node", "build"]
```

**Verify**: `docker build -f apps/dashboard/Dockerfile -t flackyness-dashboard:test .` → exit 0.

### Step 3: Point docker-compose at the root context

In `docker-compose.yml`, change both build blocks:

```yaml
    build:
      context: .
      dockerfile: apps/api/Dockerfile
```

and

```yaml
    build:
      context: .
      dockerfile: apps/dashboard/Dockerfile
```

**Verify**: `docker compose build` → exit 0 for both services. (If compose
warns about missing env like `DB_PASSWORD`, that's the production profile's
runtime requirement, not a build failure — builds must still succeed.)

### Step 4: Update the two workflows' contexts

In `.github/workflows/ci.yml` (docker job) and
`.github/workflows/docker-publish.yml`, change each `docker/build-push-action`
step from

```yaml
        with:
          context: ./apps/api
```

to

```yaml
        with:
          context: .
          file: ./apps/api/Dockerfile
```

(and the dashboard equivalents). Leave tags, caching, labels, and everything
else untouched.

**Verify**: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(/context: \.\/apps/.test(y)) process.exit(1); console.log('ok')"` → `ok`; same check for `docker-publish.yml`.

### Step 5: Smoke-test the API image

```bash
docker run --rm flackyness-api:test node --version
# → v24.x.x
docker run -d --name flackyness-smoke -p 18080:8080 \
  -e DATABASE_URL=postgres://nouser:nopass@localhost:5432/nodb flackyness-api:test
sleep 2 && curl -s http://localhost:18080/health
# → {"status":"ok","timestamp":"..."}   (the /health route does not touch the DB)
docker rm -f flackyness-smoke
```

**Verify**: both commands produce the expected output above. Also
`docker run --rm flackyness-dashboard:test node --version` → `v24.x.x`.

### Step 6: Add a guard against silent fallback regressions

Confirm no fallback pattern remains:

**Verify**: `grep -rn "|| pnpm install" apps/api/Dockerfile apps/dashboard/Dockerfile` → no matches; `grep -rn "pnpm@9" apps/` → no matches; `grep -rn "node:20" apps/` → no matches.

## Test plan

No unit tests — infra plan. The gates are: both `docker build`s succeed from
the root context, the Step 5 smoke test passes, `docker compose build`
succeeds, and CI's docker job passes when the branch runs through CI.

## Done criteria

ALL must hold:

- [ ] `docker build -f apps/api/Dockerfile .` and `docker build -f apps/dashboard/Dockerfile .` exit 0 from the repo root
- [ ] `docker run --rm <image> node --version` → `v24.*` for both images
- [ ] Step 5 `/health` smoke test returns `{"status":"ok",...}`
- [ ] `grep -rn "|| pnpm install\|pnpm@9\|node:20" apps/*/Dockerfile` → no matches
- [ ] `docker compose build` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm install --frozen-lockfile` fails inside the build with a lockfile
  mismatch — the lockfile may be out of sync with manifests at your commit;
  report it, do NOT "fix" it by regenerating the lockfile inside the image.
- `pnpm --filter <app> deploy --prod /out` errors (some pnpm majors changed
  deploy's workspace requirements). Fallback you may apply WITHOUT stopping:
  replace the deploy line with a second strict install pruned to production
  (`RUN pnpm --filter <app> install --prod --frozen-lockfile` into the same
  workspace, then copy `/repo/node_modules`, `/repo/apps/<app>/node_modules`,
  and the app's package.json into the runner, adjusting `CMD` paths to
  `apps/<app>/...`). If BOTH approaches fail, stop and report.
- The dashboard image starts but SSR crashes with a module-not-found for
  `echarts` — the deploy output didn't include a runtime dep; report which.
- Anything requires modifying files in the out-of-scope list.

## Maintenance notes

- Once contexts point at the repo root, `.dockerignore` at the root becomes
  useful (e.g. exclude `.git`, `node_modules`, `apps/*/node_modules`,
  `plans/`, `docs/`) to keep build contexts small — deferred; a follow-up may
  add it.
- Plan 010 SHA-pins the workflow actions this plan edits — land this first to
  avoid rebase churn, or coordinate.
- Reviewers should check the GHCR publish workflow's first tagged run after
  this merges: image size and the migration command
  `docker compose exec api node dist/db/migrate.js` (README) must still work.
