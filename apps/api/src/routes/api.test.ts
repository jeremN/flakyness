import { describe, it, expect, beforeAll } from 'vitest';

// These tests require the database to be running
// Skip if DATABASE_URL is not set
const hasDatabase = !!process.env.DATABASE_URL;
const describeWithDb = hasDatabase ? describe : describe.skip;

// Import app only if we have a database connection
// to avoid the DATABASE_URL error on import
let app: typeof import('../index').default;

beforeAll(async () => {
  if (hasDatabase) {
    const module = await import('../index');
    app = module.default;
  }
});

describeWithDb('API Integration Tests', () => {
  describe('Health Check', () => {
    it('GET /health should return status ok', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('API Info', () => {
    it('GET /api/v1 should return API info', async () => {
      const res = await app.request('/api/v1');
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.name).toBe('Flackyness API');
      expect(body.version).toBeDefined();
    });
  });

  describe('CORS', () => {
    // The allowed origin is `process.env.DASHBOARD_URL || 'http://localhost:5173'`
    // (index.ts:26), read at module load. DASHBOARD_URL is set only in
    // docker-compose.yml and never in CI, so the literal below is what the
    // suite sees. Asserting the expression itself would mirror the
    // implementation and survive any mutation of it.
    const ALLOWED_ORIGIN = 'http://localhost:5173';

    it('echoes the configured origin back to an allowed origin', async () => {
      const res = await app.request('/health', {
        headers: { Origin: ALLOWED_ORIGIN },
      });

      expect(
        res.headers.get('access-control-allow-origin'),
        `expected the CORS middleware to allow ${ALLOWED_ORIGIN}; if DASHBOARD_URL is exported in your shell, unset it`
      ).toBe(ALLOWED_ORIGIN);
    });

    it('sends no allow-origin header for a foreign origin', async () => {
      const res = await app.request('/health', {
        headers: { Origin: 'https://evil.test' },
      });

      // Absent, not '*'. A wildcard here would let any site read authenticated
      // responses from a browser.
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await app.request('/api/v1/unknown-route');
      expect(res.status).toBe(404);
    });
  });

  describe('Projects Endpoint', () => {
    it('GET /api/v1/projects should return projects array', async () => {
      const res = await app.request('/api/v1/projects');
      
      // May return 200 with empty array or error if DB not connected
      if (res.status === 200) {
        const body = await res.json();
        expect(body.projects).toBeDefined();
        expect(Array.isArray(body.projects)).toBe(true);
      }
    });
  });
});

describeWithDb('Reports Route Authentication', () => {
  // reports.ts:62 mounts `reports.use('*', projectAuth())` ahead of the
  // handler, so an unauthenticated request is rejected before query validation
  // or JSON parsing runs. Real input-validation coverage lives in
  // reports.test.ts:120-174, which sends a valid project token.
  //
  // The two tests below are NOT redundant, though they look it — both assert
  // 401 and differ only in their input. They pin the guard's *position* in the
  // chain, and each covers a different half:
  //
  //   test 1 sends an INVALID query (no `commit`) -> 401 proves auth runs
  //          before zValidator('query', ...)
  //   test 2 sends a VALID query and an unparseable body -> 401 proves auth
  //          runs before JSON.parse
  //
  // Verified by mutation: moving projectAuth() to after the zValidator in the
  // route chain makes test 1 fail with 400 while test 2 still passes. Deleting
  // either one silently drops half of that ordering guarantee.
  describe('POST /api/v1/reports', () => {
    it('rejects an unauthenticated request before validating the query', async () => {
      const res = await app.request('/api/v1/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated request before parsing the body', async () => {
      const res = await app.request('/api/v1/reports?project=test&branch=main&commit=abc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // Deliberately unparseable, behind a deliberately VALID query string —
        // so a 401 can only mean auth preceded the body parse. (The old
        // assertion here also admitted 500; that branch was unreachable —
        // reports.ts wraps JSON.parse in a try/catch that returns 400.)
        body: 'invalid json',
      });

      expect(res.status).toBe(401);
    });
  });
});

describeWithDb('Security Headers', () => {
  it('should include security headers', async () => {
    const res = await app.request('/health');
    
    // Check for common security headers added by secureHeaders middleware
    const headers = res.headers;
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });
});
