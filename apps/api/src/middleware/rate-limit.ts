import { rateLimiter } from 'hono-rate-limiter';
import type { Context } from 'hono';

/**
 * Rate limiter for report ingestion endpoint.
 * Prevents CI loops and accidental spam.
 * 
 * Limit: 60 requests per minute per project token
 */
export const reportRateLimit = rateLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 60,
  standardHeaders: 'draft-7', // RateLimit-* headers
  keyGenerator: (c: Context) => {
    const project = c.get('project');
    return project?.id || 'anonymous';
  },
  handler: (c: Context) => {
    return c.json(
      { 
        error: 'Too many report uploads. Please wait before retrying.',
        retryAfter: 60,
      },
      429
    );
  },
});

/**
 * Rate limiter for general API read endpoints.
 * Prevents dashboard API abuse and scraping.
 * 
 * Limit: 100 requests per minute per IP
 */
export const apiRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => {
    // Try to get real IP from proxy headers
    return (
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.req.header('x-real-ip') ||
      'unknown'
    );
  },
  handler: (c: Context) => {
    return c.json(
      {
        error: 'Rate limit exceeded. Please slow down.',
        retryAfter: 60,
      },
      429
    );
  },
});

/**
 * Rate limiter for admin endpoints.
 * More restrictive to prevent brute force.
 * 
 * Limit: 20 requests per minute per IP
 */
export const adminRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => {
    return (
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.req.header('x-real-ip') ||
      'unknown'
    );
  },
  handler: (c: Context) => {
    return c.json(
      {
        error: 'Admin rate limit exceeded.',
        retryAfter: 60,
      },
      429
    );
  },
});
