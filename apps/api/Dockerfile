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

# `pnpm --filter api deploy --prod /out` errors under pnpm 11 with
# ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE ("inject-workspace-packages=true"
# required). Fall back to a strict prod-only reinstall pruned in place,
# and copy the workspace-relative node_modules layout into the runner.
RUN CI=true pnpm --filter api install --prod --frozen-lockfile

# ==============================================================================
# Stage 2: Production
# ==============================================================================
FROM node:24-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 hono

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /repo/apps/api/package.json ./apps/api/package.json
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/api/drizzle ./apps/api/drizzle
COPY --from=builder /repo/apps/api/drizzle.config.ts ./apps/api/drizzle.config.ts

RUN chown -R hono:nodejs /app
USER hono

ENV NODE_ENV=production
ENV API_PORT=8080
ENV API_HOST=0.0.0.0

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "apps/api/dist/index.js"]
