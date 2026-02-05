import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import 'dotenv/config';

// Custom middleware
import { requestLogger, logError, logger } from './middleware/logger';
import { closeDb } from './db';

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

// API routes
app.get('/api/v1', (c) => {
  return c.json({
    name: 'Flackyness API',
    version: '0.0.1',
  });
});

// Mount routes
app.route('/api/v1/reports', reports);
app.route('/api/v1/projects', projectsRouter);
app.route('/api/v1/tests', testsRouter);
app.route('/api/v1/admin', adminRouter);

// Start server
const port = parseInt(process.env.API_PORT || '8080', 10);
const host = process.env.API_HOST || '0.0.0.0';

logger.info('Server starting', { host, port, env: process.env.NODE_ENV || 'development' });

const server: Server = serve({
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

export default app;
