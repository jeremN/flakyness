import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { db, auditRuns, auditResults } from '../db';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeWithDb = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
let adminToken: string;

// Real apps/auditor output against the fixture site in apps/auditor/fixtures/site
// (regenerate with `pnpm --filter auditor fixture:api`). Ingesting the real
// thing, not a hand-written body, is what keeps runner and API in contract.
const realAuditReport = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/audit-report.json'), 'utf-8')
);

type Issue = { id: string; severity: string; message: string; count?: number };

function report(pages: Array<{
  url?: string;
  device?: string;
  error?: string;
  checks?: Array<{ category: string; score: number | null; metrics?: Record<string, number>; issues?: Issue[] }>;
}>) {
  return {
    version: 1,
    tool: { name: 'flackyness-auditor', version: 'test' },
    startedAt: '2026-09-26T08:00:00.000Z',
    finishedAt: '2026-09-26T08:01:00.000Z',
    pages: pages.map((p) => ({
      url: p.url ?? 'https://example.com/',
      device: p.device ?? 'mobile',
      ...(p.error ? { error: p.error } : {}),
      checks: (p.checks ?? []).map((c) => ({ ...c, issues: c.issues ?? [] })),
    })),
  };
}

async function createProject(name: string): Promise<{ id: string; token: string }> {
  const res = await app.request('/api/v1/admin/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return { id: body.project.id, token: body.token };
}

async function deleteProject(id: string) {
  const res = await app.request(`/api/v1/admin/projects/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status).toBe(200);
}

function upload(token: string, body: unknown, query = 'branch=main') {
  return app.request(`/api/v1/audits?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function read(path: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${adminToken}` } });
}

describeWithDb('Audits API (plan 060)', () => {
  let project: { id: string; token: string };
  let other: { id: string; token: string };

  beforeAll(async () => {
    const module = await import('../index');
    app = module.default;
    adminToken = process.env.ADMIN_TOKEN!;
    project = await createProject(`audits-test-${Date.now()}`);
    other = await createProject(`audits-other-${Date.now()}`);
  });

  afterAll(async () => {
    if (project) await deleteProject(project.id);
    if (other) await deleteProject(other.id);
  });

  describe('POST /api/v1/audits', () => {
    it('401s without a project token', async () => {
      const res = await app.request('/api/v1/audits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report([{ checks: [{ category: 'a11y', score: 1 }] }])),
      });
      expect(res.status).toBe(401);
    });

    it('400s on a non-JSON body', async () => {
      const res = await upload(project.token, 'not json');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/JSON/);
    });

    it('400s on an invalid report and names the offending path', async () => {
      const res = await upload(project.token, report([{ checks: [{ category: 'a11y', score: 2 }] }]));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/pages\.0\.checks\.0\.score/);
    });

    it('ingests the real auditor fixture and stores one row per check', async () => {
      const res = await upload(other.token, realAuditReport, 'branch=fixture');
      expect(res.status).toBe(201);
      const body = await res.json();

      const expectedChecks = realAuditReport.pages.reduce(
        (n: number, p: { checks: unknown[] }) => n + p.checks.length,
        0
      );
      expect(expectedChecks).toBeGreaterThan(0);
      expect(body.auditRun.summary.checks).toBe(expectedChecks);
      expect(body.previousRunId).toBeNull();
      expect(body.regressions).toEqual([]);

      const rows = await db.select().from(auditResults).where(eq(auditResults.auditRunId, body.auditRun.id));
      expect(rows).toHaveLength(expectedChecks);
      // Stored as the decimal column's 4dp string.
      for (const row of rows) {
        if (row.score !== null) expect(row.score).toMatch(/^[01]\.\d{4}$/);
      }
    });

    it('records a page that failed to load on the run, not as a result row', async () => {
      const res = await upload(
        project.token,
        report([
          { url: 'https://example.com/ok', checks: [{ category: 'seo', score: 1 }] },
          { url: 'https://example.com/down', error: 'net::ERR_CONNECTION_REFUSED' },
        ]),
        'branch=failures'
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.auditRun.summary).toMatchObject({ pages: 2, failedPages: 1, checks: 1 });

      const [run] = await db.select().from(auditRuns).where(eq(auditRuns.id, body.auditRun.id));
      expect(run.pageErrors).toEqual([
        { url: 'https://example.com/down', device: 'mobile', error: 'net::ERR_CONNECTION_REFUSED' },
      ]);
      expect(run.commitSha).toBeNull(); // commit is optional for audits
    });

    it('reports regressions against the previous run on the SAME branch only', async () => {
      const baseline = report([
        {
          checks: [
            { category: 'a11y', score: 0.95, issues: [{ id: 'region', severity: 'moderate', message: 'm' }] },
            { category: 'perf', score: 0.8, metrics: { lcp: 2000, cls: 0.01 } },
          ],
        },
      ]);
      const worse = report([
        {
          checks: [
            {
              category: 'a11y',
              score: 0.7,
              issues: [
                { id: 'region', severity: 'moderate', message: 'm' },
                { id: 'image-alt', severity: 'critical', message: 'Images must have alternate text' },
              ],
            },
            { category: 'perf', score: 0.8, metrics: { lcp: 3000, cls: 0.01 } },
          ],
        },
      ]);

      const first = await upload(project.token, baseline, 'branch=regress&commit=aaa');
      expect(first.status).toBe(201);
      const firstBody = await first.json();

      // A worse run on ANOTHER branch must not be compared with main's baseline.
      const elsewhere = await upload(project.token, worse, 'branch=feature-x');
      expect((await elsewhere.json()).regressions).toEqual([]);

      const second = await upload(project.token, worse, 'branch=regress&commit=bbb');
      expect(second.status).toBe(201);
      const body = await second.json();
      expect(body.previousRunId).toBe(firstBody.auditRun.id);
      expect(body.regressions).toEqual([
        {
          kind: 'new_issue',
          url: 'https://example.com/',
          device: 'mobile',
          category: 'a11y',
          issueId: 'image-alt',
          severity: 'critical',
          message: 'Images must have alternate text',
        },
        {
          kind: 'score',
          url: 'https://example.com/',
          device: 'mobile',
          category: 'a11y',
          previous: 0.95,
          current: 0.7,
        },
        {
          kind: 'metric',
          url: 'https://example.com/',
          device: 'mobile',
          category: 'perf',
          metric: 'lcp',
          previous: 2000,
          current: 3000,
        },
      ]);
    });
  });

  describe('GET /api/v1/projects/:id/audits', () => {
    let runIds: string[] = [];
    let listProject: { id: string; token: string };

    beforeAll(async () => {
      listProject = await createProject(`audits-list-${Date.now()}`);
      runIds = [];
      for (const [branch, a11y] of [['main', 1], ['main', 0.5], ['dev', 0.25]] as const) {
        const res = await upload(
          listProject.token,
          report([
            { url: 'https://example.com/a', checks: [{ category: 'a11y', score: a11y }, { category: 'perf', score: null }] },
            { url: 'https://example.com/b', checks: [{ category: 'a11y', score: 0 }] },
          ]),
          `branch=${branch}`
        );
        runIds.push((await res.json()).auditRun.id);
      }
    });

    afterAll(async () => {
      if (listProject) await deleteProject(listProject.id);
    });

    it('lists runs newest first with per-category mean scores (null = unmeasured)', async () => {
      const res = await read(`/api/v1/projects/${listProject.id}/audits`);
      expect(res.status).toBe(200);
      const { runs } = await res.json();
      expect(runs.map((r: { id: string }) => r.id)).toEqual([...runIds].reverse());
      expect(runs[0].scores).toEqual({ a11y: 0.125, seo: null, perf: null });
      expect(runs[2].scores).toEqual({ a11y: 0.5, seo: null, perf: null });
      expect(runs[0]).toMatchObject({ branch: 'dev', pageCount: 2, failedPages: 0 });
    });

    it('filters by branch', async () => {
      const { runs } = await (await read(`/api/v1/projects/${listProject.id}/audits?branch=main`)).json();
      expect(runs.map((r: { id: string }) => r.id)).toEqual([runIds[1], runIds[0]]);
    });

    it('clamps limit and falls back to the default on garbage', async () => {
      const one = await (await read(`/api/v1/projects/${listProject.id}/audits?limit=0`)).json();
      expect(one.runs).toHaveLength(1);
      const garbage = await (await read(`/api/v1/projects/${listProject.id}/audits?limit=abc`)).json();
      expect(garbage.runs).toHaveLength(3);
    });

    it('returns an empty list for a project with no audits', async () => {
      const { runs } = await (await read(`/api/v1/projects/${other.id}/audits?branch=never`)).json();
      expect(runs).toEqual([]);
    });

    it('400s on a malformed project id and 404s on an unknown one', async () => {
      expect((await read('/api/v1/projects/not-a-uuid/audits')).status).toBe(400);
      expect((await read('/api/v1/projects/00000000-0000-4000-8000-000000000000/audits')).status).toBe(404);
    });

    describe('GET /api/v1/projects/:id/audits/:runId', () => {
      it('returns results worst-first with regressions against the previous run on the branch', async () => {
        const res = await read(`/api/v1/projects/${listProject.id}/audits/${runIds[1]}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.previousRunId).toBe(runIds[0]);
        expect(body.truncated).toBe(false);
        expect(body.run).not.toHaveProperty('projectId');
        expect(body.run.scores).toEqual({ a11y: 0.25, seo: null, perf: null });
        // Worst first, NULL scores last.
        expect(body.results.map((r: { score: string | null }) => r.score)).toEqual(['0.0000', '0.5000', null]);
        expect(body.regressions).toEqual([
          {
            kind: 'score',
            url: 'https://example.com/a',
            device: 'mobile',
            category: 'a11y',
            previous: 1,
            current: 0.5,
          },
        ]);
      });

      it('has no baseline for the first run on a branch', async () => {
        const body = await (await read(`/api/v1/projects/${listProject.id}/audits/${runIds[2]}`)).json();
        expect(body.previousRunId).toBeNull();
        expect(body.regressions).toEqual([]);
      });

      it("404s a real run id under another project's id (no cross-project read)", async () => {
        const res = await read(`/api/v1/projects/${other.id}/audits/${runIds[0]}`);
        expect(res.status).toBe(404);
      });

      it('400s on a malformed run id', async () => {
        expect((await read(`/api/v1/projects/${listProject.id}/audits/nope`)).status).toBe(400);
      });
    });
  });

  it('deleting a project cascades to its audit runs and results', async () => {
    const temp = await createProject(`audits-cascade-${Date.now()}`);
    const res = await upload(temp.token, report([{ checks: [{ category: 'seo', score: 1 }] }]));
    const runId = (await res.json()).auditRun.id;

    await deleteProject(temp.id);

    expect(await db.select().from(auditRuns).where(eq(auditRuns.id, runId))).toEqual([]);
    expect(await db.select().from(auditResults).where(eq(auditResults.auditRunId, runId))).toEqual([]);
  });
});
