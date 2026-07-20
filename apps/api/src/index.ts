import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import 'dotenv/config';

// Custom middleware
import { requestLogger, logError, logger } from './middleware/logger';
import { extractBearerToken, tokensMatch } from './middleware/auth';
import { closeDb } from './db';
import { renderMetrics } from './metrics';

// Routes
import reports from './routes/reports';
import projectsRouter from './routes/projects';
import testsRouter from './routes/tests';
import adminRouter from './routes/admin';

const app = new Hono<{ Variables: { requestId: string } }>();

// Middleware
app.use('*', requestLogger());
app.use('*', cors({
  origin: process.env.DASHBOARD_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use('*', secureHeaders());

// Body size limit - uses Hono's built-in stream-aware middleware (prevents chunked encoding bypass)
app.use('*', bodyLimit({
  maxSize: 10 * 1024 * 1024, // 10MB
  onError: (c) => {
    return c.json({ error: 'Payload too large. Maximum size: 10MB' }, 413);
  },
}));

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    logger.warn('HTTP exception', {
      status: err.status,
      message: err.message,
      requestId: c.get('requestId'),
    });
    return c.json({ error: err.message }, err.status);
  }

  logError(err, c);
  return c.json({ error: 'Internal server error' }, 500);
});

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Prometheus scrape endpoint. Off by default: unset METRICS_TOKEN makes the
// route 404 (feature invisible), matching how self-hosters opt in to admin
// features. Mounted on the root app (Prometheus convention), not /api/v1.
app.get('/metrics', async (c) => {
  const metricsToken = process.env.METRICS_TOKEN;
  if (!metricsToken) {
    return c.json({ error: 'Not found' }, 404);
  }

  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token || !tokensMatch(token, metricsToken)) {
    throw new HTTPException(401, { message: 'Invalid or missing metrics token' });
  }

  c.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return c.body(await renderMetrics());
});

// API routes
app.get('/api/v1', (c) => {
  return c.json({
    name: 'Flackyness API',
    version: '0.0.1',
  });
});

// Fires once, at module evaluation (server start), not per-request — loud
// enough that an operator cannot miss it in the boot log, without spamming
// every request. Mirrors the DASHBOARD_PASSWORD warning in the dashboard's
// hooks.server.ts, and follows the same reasoning (plan 041, D1): leaving
// reads open is a legitimate choice for a network-isolated deployment, so we
// warn rather than hard-fail.
if (!process.env.READ_TOKEN) {
  logger.warn(
    'READ_TOKEN is not set — all read endpoints are unauthenticated, and ' +
      'GET /api/v1/projects enumerates every project on this instance. Anyone ' +
      'who can reach this API can read every project\'s stats, runs, flaky ' +
      'tests and quarantine list. Set READ_TOKEN to require a Bearer token on ' +
      'read endpoints, or confirm this deployment is genuinely network-isolated. ' +
      'See docs/API.md.'
  );
}

// Mount routes
app.route('/api/v1/reports', reports);
app.route('/api/v1/projects', projectsRouter);
app.route('/api/v1/tests', testsRouter);
app.route('/api/v1/admin', adminRouter);

// Only start the HTTP server outside of tests (tests use app.request() directly)
if (!process.env.VITEST) {
  const port = parseInt(process.env.API_PORT || '8080', 10);
  const host = process.env.API_HOST || '0.0.0.0';

  logger.info('Server starting', { host, port, env: process.env.NODE_ENV || 'development' });

  // @hono/node-server v2 returns its own ServerType (http/http2 union); let it
  // infer rather than forcing node:http's Server. It still exposes .close().
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  // Graceful shutdown
  function shutdown(signal: string) {
    logger.info(`${signal} received, shutting down gracefully...`);
    server.close(async () => {
      logger.info('HTTP server closed');
      await closeDb();
      logger.info('Database connections closed');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
