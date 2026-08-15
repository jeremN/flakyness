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
import { sessionAuth } from './middleware/session';
import { passwordChangeGate } from './middleware/password-change';
import { trustedProxyWarning } from './middleware/rate-limit';
import { closeDb } from './db';
import { renderMetrics } from './metrics';

// Routes
import reports from './routes/reports';
import projectsRouter from './routes/projects';
import testsRouter from './routes/tests';
import adminRouter from './routes/admin';
import adminUsersRouter from './routes/admin-users';
import adminTeamsRouter from './routes/admin-teams';
import authRouter, { isCookieSecure } from './routes/auth';

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

// Resolve the session cookie for every request from here down. It never
// rejects on CREDENTIAL STATE — absent, unknown and expired cookies are all
// simply anonymous — so mounting it globally cannot 401 an unauthenticated
// route. It is NOT unconditionally throw-free: the session-lookup SELECT is
// deliberately left to propagate (plan 056 Task 4, human ruling).
//
// Mounted AFTER /health and /metrics, not before: Hono composes handlers in
// registration order, so a middleware registered here never runs for those
// two paths above. Mounting ahead of them would turn /health into a database
// liveness probe for any request that happens to carry an `fk_session`
// cookie — if Postgres is down, /health starts 500ing and an orchestrator
// restart-loops the container *during* the outage, turning a degraded read
// path into an outage amplifier. Nothing on /health or /metrics needs
// `access`.
app.use('*', sessionAuth());

// API routes
//
// The gate is mounted as ROUTE-LEVEL middleware, not `app.use('/api/v1', ...)`.
// A path-scoped `app.use` here would match every path BELOW /api/v1 too, and
// being registered on the root app it would run ahead of every per-router rate
// limiter — starving all seven of them, which is exactly the hazard the
// mount-point comment in middleware/password-change.ts describes. Route-level
// middleware runs only for this one exact route.
//
// This route is deliberately absent from EXPECTED_GATE_ORDER in
// password-change-coverage.test.ts: no rate limiter covers /api/v1 (it is
// outside every router), so there is no order to assert. That is pre-existing
// and unchanged by gating it — the endpoint returns two static strings and
// touches neither the database nor any credential.
app.get('/api/v1', passwordChangeGate(), (c) => {
  return c.json({
    name: 'Flackyness API',
    version: '0.0.1',
  });
});

// Fires once, at module evaluation (server start), not per-request — loud
// enough that an operator cannot miss it in the boot log, without spamming
// every request. Used to mirror an equivalent DASHBOARD_PASSWORD warning in
// the dashboard's hooks.server.ts; plan 059 removed that counterpart, because
// dashboard authentication is now unconditional (real per-user sessions, not
// an optional shared password) — there is no "unset means no gate" case left
// to warn about there. This warning stands on its own: READ_TOKEN unset is
// still a legitimate choice for a network-isolated deployment (plan 041,
// D1), so the API still warns rather than hard-fails.
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

// Same fires-once-at-boot shape as the READ_TOKEN warning above. The design
// spec mandates `Secure` on the session cookie; isCookieSecure() defaults it
// on in production and off elsewhere (COOKIE_SECURE overrides either way —
// see routes/auth.ts). Plain-HTTP self-hosting is a legitimate deployment
// mode, which is why this warns rather than refusing to boot.
if (!isCookieSecure()) {
  logger.warn(
    'Session cookies are being issued WITHOUT the Secure attribute ' +
      '(NODE_ENV is not "production" and COOKIE_SECURE is not "true"). The ' +
      'fk_session cookie will still be sent by the browser over a plain, ' +
      'unencrypted HTTP connection. This is expected for local development ' +
      'and the default plain-HTTP docker-compose deployment, but any ' +
      'internet-facing deployment behind TLS should set NODE_ENV=production ' +
      'or COOKIE_SECURE=true.'
  );
}

// Same fires-once-at-boot shape as the two warnings above (plan 059 Task 0).
const proxyWarning = trustedProxyWarning(process.env.TRUSTED_PROXY_IPS);
if (proxyWarning) logger.warn(proxyWarning);

// Mount routes
app.route('/api/v1/reports', reports);
app.route('/api/v1/projects', projectsRouter);
app.route('/api/v1/tests', testsRouter);
// Mounted BEFORE /api/v1/admin so the more specific path is matched first —
// Hono tries routes in mount order, and the broader adminRouter would
// otherwise shadow GET /api/v1/admin/users with its own project-list route.
app.route('/api/v1/admin/users', adminUsersRouter);
app.route('/api/v1/admin/teams', adminTeamsRouter);
app.route('/api/v1/admin', adminRouter);
app.route('/api/v1/auth', authRouter);

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
