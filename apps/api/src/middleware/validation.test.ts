import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { validationErrorBody, validationHook, VALIDATION_FAILED } from './validation';

describe('validationErrorBody (backlog #25)', () => {
  it('keeps `error` a string and lists every issue', () => {
    const body = validationErrorBody(
      {
        issues: [
          { path: ['email'], message: 'Invalid email address', code: 'invalid_format' },
          { path: ['teams', 0, 'role'], message: 'Invalid option', code: 'invalid_value' },
        ],
      },
      'json'
    );
    expect(body).toEqual({
      error: 'Invalid request body: email: Invalid email address (and 1 more)',
      code: VALIDATION_FAILED,
      issues: [
        { path: 'email', message: 'Invalid email address', code: 'invalid_format' },
        { path: 'teams.0.role', message: 'Invalid option', code: 'invalid_value' },
      ],
    });
  });

  it('leaves the path out of the summary for a whole-input issue, and adds no count for one issue', () => {
    const body = validationErrorBody({ issues: [{ path: [], message: 'Expected object', code: 'invalid_type' }] }, 'query');
    expect(body.error).toBe('Invalid query string: Expected object');
    expect(body.issues).toEqual([{ path: '', message: 'Expected object', code: 'invalid_type' }]);
  });

  it('never copies the rejected input into the response', () => {
    // Zod can attach `input` to an issue. A password must not ride along.
    const issue = { path: ['password'], message: 'Too small', code: 'too_small', input: 'hunter2-secret' };
    const body = validationErrorBody({ issues: [issue] }, 'json');
    expect(JSON.stringify(body)).not.toContain('hunter2-secret');
    expect(Object.keys(body.issues[0]).sort()).toEqual(['code', 'message', 'path']);
  });
});

describe('validationHook through zValidator', () => {
  const app = new Hono();
  app.post('/x', zValidator('json', z.object({ n: z.number() }), validationHook), (c) => c.json({ ok: true }));

  it('answers a schema failure with the API shape, not the library default', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.code).toBe(VALIDATION_FAILED);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].path).toBe('n');
    // The library default carries `success: false`; this shape does not.
    expect(body).not.toHaveProperty('success');
  });

  it('lets a valid body through to the handler', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    });
    expect(res.status).toBe(200);
  });
});

describe('the real app answers validation 400s with the API shape', () => {
  // POST /auth/login validates before its handler touches the database, and a
  // request with no cookie skips the session lookup: no Postgres needed.
  it('POST /api/v1/auth/login with a malformed email', async () => {
    const { default: app } = await import('../index');
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'hunter2-secret' }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('hunter2-secret');
    const body = JSON.parse(text);
    expect(body.code).toBe(VALIDATION_FAILED);
    expect(body.error).toMatch(/^Invalid request body: email: /);
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(['email']);
  });
});
