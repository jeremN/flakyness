import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';
import { HTTPException } from 'hono/http-exception';
import 'dotenv/config';

// Custom middleware
import { requestLogger, logError, logger } from './middleware/logger';

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

// Body size limit - prevent memory exhaustion
app.use('*', async (c, next) => {
  const contentLength = c.req.header('content-length');
  const maxSize = 10 * 1024 * 1024; // 10MB
  
  if (contentLength && parseInt(contentLength) > maxSize) {
    throw new HTTPException(413, { 
      message: 'Payload too large. Maximum size: 10MB' 
    });
  }
  
  await next();
});

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

serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

export default app;

