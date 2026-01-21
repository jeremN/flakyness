# ==============================================================================
# Dashboard Dockerfile
# Build from repository root: docker build -f apps/dashboard/Dockerfile .
# Or use docker compose which handles context correctly
# ==============================================================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy package files
COPY package.json ./
COPY tsconfig.json ./
COPY svelte.config.js ./
COPY vite.config.ts ./
COPY postcss.config.js ./
COPY tailwind.config.js ./
COPY src ./src

# Install dependencies
RUN pnpm install

# Build the application
RUN pnpm run build

# ==============================================================================
# Stage 2: Production
# ==============================================================================
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 sveltekit

# Install pnpm for production install
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy package file
COPY package.json ./

# Install production dependencies
RUN pnpm install --prod

# Copy built output (node adapter output)
COPY --from=builder /app/build ./build

# Set ownership
RUN chown -R sveltekit:nodejs /app

USER sveltekit

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Public env var for API URL (can be overridden at runtime)
ENV PUBLIC_API_URL=http://api:8080

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

CMD ["node", "build"]
