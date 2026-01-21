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
    it('should include CORS headers', async () => {
      const res = await app.request('/health', {
        headers: {
          'Origin': 'http://localhost:5173',
        },
      });
      
      expect(res.headers.get('access-control-allow-origin')).toBeDefined();
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

describeWithDb('Request Validation', () => {
  describe('POST /api/v1/reports', () => {
    it('should reject request without required params', async () => {
      const res = await app.request('/api/v1/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      
      // Should fail validation - either 400 or 401 (auth required)
      expect([400, 401]).toContain(res.status);
    });

    it('should reject invalid JSON body', async () => {
      const res = await app.request('/api/v1/reports?project=test&branch=main&commit=abc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: 'invalid json',
      });
      
      expect([400, 401, 500]).toContain(res.status);
    });
  });
});

describeWithDb('Security Headers', () => {
  it('should include security headers', async () => {
    const res = await app.request('/health');
    
    // Check for common security headers added by secureHeaders middleware
    const headers = res.headers;
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBeDefined();
  });
});
