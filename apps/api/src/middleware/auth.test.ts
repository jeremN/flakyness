import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { hashToken, generateToken, adminOrGlobalAdminAuth, projectAuth, readAuth } from '../middleware/auth';
import type { SessionUser } from '../middleware/session';

describe('Auth Utilities', () => {
  describe('hashToken', () => {
    it('should hash a token consistently', () => {
      const token = 'test-token-12345';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const hash1 = hashToken('token-a');
      const hash2 = hashToken('token-b');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce 64-character hex string (SHA-256)', () => {
      const hash = hashToken('any-token');

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle empty string', () => {
      const hash = hashToken('');
      expect(hash).toHaveLength(64);
    });

    it('should handle special characters', () => {
      const hash = hashToken('token!@#$%^&*()_+{}|:"<>?');
      expect(hash).toHaveLength(64);
    });
  });

  describe('generateToken', () => {
    it('should generate token with flackyness prefix', () => {
      const token = generateToken();

      expect(token).toMatch(/^flackyness_/);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set<string>();

      for (let i = 0; i < 100; i++) {
        tokens.add(generateToken());
      }

      expect(tokens.size).toBe(100);
    });

    it('should generate tokens of consistent length', () => {
      const token = generateToken();

      // flackyness_ (11 chars incl. underscore) + 48 hex chars (24 bytes)
      expect(token.length).toBeGreaterThanOrEqual(58);
    });

    it('should generate tokens that can be hashed', () => {
      const token = generateToken();
      const hash = hashToken(token);

      expect(hash).toHaveLength(64);
    });
  });
});

// adminAuth() (ADMIN_TOKEN only) was deleted in backlog #22b; this gate is the
// only admin-API gate. These cases need no database: a session or an unknown
// bearer makes resolveAccessValue query it, and routes/admin.test.ts covers
// those against a real Postgres.
describe('adminOrGlobalAdminAuth middleware (no session)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeApp() {
    const app = new Hono();
    app.onError((err, c) =>
      err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({}, 500)
    );
    app.use('/admin/*', adminOrGlobalAdminAuth());
    app.get('/admin/ping', (c) => c.json({ ok: true }));
    return app;
  }

  it('returns 401 when no Authorization header is provided', async () => {
    vi.stubEnv('ADMIN_TOKEN', 'right-token');
    const res = await makeApp().request('/admin/ping');
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Authorization header required');
  });

  it.each([
    ['a non-Bearer scheme', 'Basic x'],
    ['a Bearer header without a token', 'Bearer'],
  ])('returns 401 for %s', async (_label, header) => {
    vi.stubEnv('ADMIN_TOKEN', 'right-token');
    const res = await makeApp().request('/admin/ping', { headers: { Authorization: header } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid authorization format. Use: Bearer <token>');
  });

  it('returns 200 for the correct ADMIN_TOKEN', async () => {
    vi.stubEnv('ADMIN_TOKEN', 'right-token');
    const res = await makeApp().request('/admin/ping', {
      headers: { Authorization: 'Bearer right-token' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('returns 401, not 500, when ADMIN_TOKEN is not configured', async () => {
    // The trap that got adminAuth() deleted: it answered 500 here. With
    // accounts, an install without a static admin token is a valid setup.
    vi.stubEnv('ADMIN_TOKEN', '');
    const res = await makeApp().request('/admin/ping');
    expect(res.status).toBe(401);
  });
});

describe('projectAuth middleware', () => {
  // Only the pre-DB paths are covered here (they throw before any DB call);
  // the token-lookup path is covered by the route integration suites.
  function makeApp() {
    const app = new Hono();
    app.use('/api/*', projectAuth());
    app.get('/api/ping', (c) => c.json({ ok: true }));
    return app;
  }

  it('should return 401 when no Authorization header is provided', async () => {
    const app = makeApp();

    const res = await app.request('/api/ping');
    expect(res.status).toBe(401);
  });

  it('should return 401 for a non-Bearer authorization scheme', async () => {
    const app = makeApp();

    const res = await app.request('/api/ping', {
      headers: { Authorization: 'Basic x' },
    });
    expect(res.status).toBe(401);
  });

  it('should return 401 for a malformed Bearer header without a token', async () => {
    const app = makeApp();

    const res = await app.request('/api/ping', {
      headers: { Authorization: 'Bearer' },
    });
    expect(res.status).toBe(401);
  });
});

describe('readAuth', () => {
  afterEach(() => {
    delete process.env.READ_TOKEN;
    vi.restoreAllMocks();
  });

  function appWith(mw: ReturnType<typeof readAuth>) {
    const app = new Hono();
    app.get('/p/:id', mw, (c) => c.json({ ok: true }));
    return app;
  }

  it('passe sans credential quand READ_TOKEN est absent (mode ouvert)', async () => {
    const app = appWith(readAuth((c) => c.req.param('id')));
    const res = await app.request('/p/abc');
    expect(res.status).toBe(200);
  });

  it('passe avec un READ_TOKEN valide', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const app = appWith(readAuth((c) => c.req.param('id')));
    const res = await app.request('/p/abc', {
      headers: { Authorization: 'Bearer read-secret' },
    });
    expect(res.status).toBe(200);
  });

  it('rejette en 401 sans header quand READ_TOKEN est défini', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const app = appWith(readAuth((c) => c.req.param('id')));
    const res = await app.request('/p/abc');
    expect(res.status).toBe(401);
  });

  it('rejette en 401 sur un format non-Bearer', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const app = appWith(readAuth((c) => c.req.param('id')));
    const res = await app.request('/p/abc', {
      headers: { Authorization: 'read-secret' },
    });
    expect(res.status).toBe(401);
  });

  it('rejette en 401 un mauvais token sans résolveur de projet', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const app = appWith(readAuth());
    const res = await app.request('/p/abc', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  // Backlog #41: a signed-in user satisfies readAuth on its own. sessionAuth
  // (mounted globally in index.ts) has already validated the session; the
  // read SCOPE is resolveAccess's job, which scopes a user to their teams.
  function appWithSession(mw: ReturnType<typeof readAuth>) {
    const app = new Hono<{ Variables: { sessionUser: SessionUser } }>();
    app.use('*', async (c, next) => {
      c.set('sessionUser', {
        id: 'u1',
        email: 'u1@example.test',
        displayName: null,
        isGlobalAdmin: false,
        isTeamAdmin: false,
        mustChangePassword: false,
        sessionId: 's1',
      });
      await next();
    });
    app.get('/p/:id', mw, (c) => c.json({ ok: true }));
    return app;
  }

  it('lets a validated session through with no bearer when READ_TOKEN is set', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await appWithSession(readAuth((c) => c.req.param('id'))).request('/p/abc');
    expect(res.status).toBe(200);
  });

  it('lets a validated session through on a route with no project resolver', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await appWithSession(readAuth()).request('/p/abc');
    expect(res.status).toBe(200);
  });

  it('marque le middleware retourné pour la garde de couverture', () => {
    expect(readAuth().isReadAuth).toBe(true);
    expect(readAuth((c) => c.req.param('id')).isReadAuth).toBe(true);
  });
});
