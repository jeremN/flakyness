import { randomUUID } from 'crypto';
import type { Context, Next } from 'hono';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

const isDev = process.env.NODE_ENV !== 'production';

function formatLog(entry: LogEntry): string {
  if (isDev) {
    // Pretty print for development
    const { timestamp, level, message, method, path, status, duration, error, ...rest } = entry;
    const prefix = `[${timestamp}] ${level.toUpperCase().padEnd(5)}`;
    const route = method && path ? ` ${method} ${path}` : '';
    const statusStr = status ? ` → ${status}` : '';
    const durationStr = duration !== undefined ? ` (${duration}ms)` : '';
    const errorStr = error ? `\n  Error: ${error.message}` : '';
    const extraStr = Object.keys(rest).length > 0 ? `\n  ${JSON.stringify(rest)}` : '';
    
    return `${prefix} ${message}${route}${statusStr}${durationStr}${errorStr}${extraStr}`;
  }
  
  // JSON format for production
  return JSON.stringify(entry);
}

function log(level: LogLevel, message: string, extra?: Partial<LogEntry>): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...extra,
  };
  
  const formatted = formatLog(entry);
  
  switch (level) {
    case 'error':
      console.error(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    default:
      console.log(formatted);
  }
}

export const logger = {
  debug: (message: string, extra?: Partial<LogEntry>) => log('debug', message, extra),
  info: (message: string, extra?: Partial<LogEntry>) => log('info', message, extra),
  warn: (message: string, extra?: Partial<LogEntry>) => log('warn', message, extra),
  error: (message: string, extra?: Partial<LogEntry>) => log('error', message, extra),
};

// Generate unique request ID (cryptographically random, no collisions)
function generateRequestId(): string {
  return randomUUID();
}

// Hono middleware for request logging
export function requestLogger() {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    const requestId = generateRequestId();
    
    // Attach request ID to context for use in error handlers
    c.set('requestId', requestId);
    
    const method = c.req.method;
    const path = c.req.path;
    
    logger.info('Request started', { requestId, method, path });
    
    await next();
    
    const duration = Date.now() - start;
    const status = c.res.status;
    
    const logFn = status >= 500 ? logger.error : status >= 400 ? logger.warn : logger.info;
    logFn('Request completed', { requestId, method, path, status, duration });
  };
}

// Log errors with full context
export function logError(err: Error, c: Context, extra?: Partial<LogEntry>): void {
  const requestId = c.get('requestId') as string | undefined;
  
  logger.error('Unhandled error', {
    requestId,
    method: c.req.method,
    path: c.req.path,
    error: {
      name: err.name,
      message: err.message,
      stack: isDev ? err.stack : undefined,
    },
    ...extra,
  });
}
