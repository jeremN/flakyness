# ==============================================================================
# Dashboard Dockerfile — build from the repository root:
#   docker build -f apps/dashboard/Dockerfile .
# (docker-compose.yml and the GitHub workflows set context: . accordingly)
# ==============================================================================

# Stage 1: Build
FROM node:24-alpine AS builder

WORKDIR /repo

# corepack reads packageManager (pnpm@11.5.1) from the root package.json
RUN corepack enable

# Workspace manifests + lockfile first (layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/dashboard/package.json apps/dashboard/

# Strict, reproducible install. No fallback: a failure must fail the build.
RUN pnpm install --frozen-lockfile --filter dashboard...

COPY apps/dashboard/ apps/dashboard/

RUN pnpm --filter dashboard build

# `pnpm --filter dashboard deploy --prod /out` errors under pnpm 11 with
# ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE ("inject-workspace-packages=true"
# required). Fall back to a strict prod-only reinstall pruned in place,
# and copy the workspace-relative node_modules layout into the runner.
RUN CI=true pnpm --filter dashboard install --prod --frozen-lockfile

# ==============================================================================
# Stage 2: Production
# ==============================================================================
FROM node:24-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 sveltekit

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=builder /repo/apps/dashboard/package.json ./apps/dashboard/package.json
COPY --from=builder /repo/apps/dashboard/build ./apps/dashboard/build

RUN chown -R sveltekit:nodejs /app
USER sveltekit

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Public env var for API URL (can be overridden at runtime)
ENV PUBLIC_API_URL=http://api:8080

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

CMD ["node", "apps/dashboard/build"]
