# ==============================================================================
# API Dockerfile
# Build from the repository root: docker build -f apps/api/Dockerfile .
# Or use docker compose which handles context correctly
# ==============================================================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy package files and lockfile for reproducible installs
COPY package.json pnpm-lock.yaml* ./
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY drizzle.config.ts ./

# Install all dependencies (including dev for build) — uses lockfile if present
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Build the application
RUN pnpm run build

# ==============================================================================
# Stage 2: Production
# ==============================================================================
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 hono

# Install pnpm for production install
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy package files and lockfile
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile 2>/dev/null || pnpm install --prod

# Copy built output
COPY --from=builder /app/dist ./dist

# Copy Drizzle migrations (needed at runtime for db:migrate)
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./

# Set ownership
RUN chown -R hono:nodejs /app

USER hono

# Environment
ENV NODE_ENV=production
ENV API_PORT=8080
ENV API_HOST=0.0.0.0

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
