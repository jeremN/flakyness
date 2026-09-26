import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { runAudit } from './browser';
import { parseConfig } from './config';
import { startFixtureServer } from './test-support/fixture-server';
import type { AuditReport, Category, PageReport } from './types';

// Real Chromium against the fixture site in fixtures/site. Self-skips when no
// browser is installed — same posture as the API's DB-gated suites. In CI the
// Tests job installs one (`pnpm --filter auditor exec playwright install
// chromium`); locally, point AUDIT_CHROMIUM_PATH at any Chromium.
const executablePath = process.env.AUDIT_CHROMIUM_PATH;
const hasChromium = executablePath ? existsSync(executablePath) : existsSync(chromium.executablePath());
const describeWithBrowser = hasChromium ? describe : describe.skip;

function check(page: PageReport | undefined, category: Category) {
  const found = page?.checks.find((c) => c.category === category);
  if (!found) throw new Error(`no ${category} check on ${page?.url}`);
  return found;
}

describeWithBrowser('runAudit (real Chromium, fixture site)', () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let report: AuditReport;
  const page = (path: string) => report.pages.find((p) => p.url === `${server.origin}${path}`);

  beforeAll(async () => {
    server = await startFixtureServer();
    const config = parseConfig({
      urls: [
        `${server.origin}/good.html`,
        `${server.origin}/bad.html`,
        `${server.origin}/noindex.html`,
        `${server.origin}/missing`,
        // Port 1 is on Chromium's unsafe-port list: fails instantly, no DNS or timeout involved.
        'http://127.0.0.1:1/unreachable',
      ],
      settleMs: 1000,
    });
    report = await runAudit(config, { executablePath });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it('produces a v1 report with one page per url x device, in config order', () => {
    expect(report.version).toBe(1);
    expect(report.tool.name).toBe('flackyness-auditor');
    expect(report.pages.map((p) => p.url.replace(server.origin, ''))).toEqual([
      '/good.html',
      '/bad.html',
      '/noindex.html',
      '/missing',
      'http://127.0.0.1:1/unreachable',
    ]);
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
  });

  it('gives the clean page full a11y and SEO marks', () => {
    expect(check(page('/good.html'), 'a11y')).toEqual({ category: 'a11y', score: 1, issues: [] });
    expect(check(page('/good.html'), 'seo')).toEqual({ category: 'seo', score: 1, issues: [] });
  });

  it('measures real Web Vitals in the page (init script runs before page scripts)', () => {
    const perf = check(page('/good.html'), 'perf');
    expect(perf.score).not.toBeNull();
    expect(perf.metrics).toEqual(
      expect.objectContaining({
        lcp: expect.any(Number),
        fcp: expect.any(Number),
        ttfb: expect.any(Number),
        cls: expect.any(Number),
        tbt: expect.any(Number),
      })
    );
  });

  it('catches the deliberate a11y defects on the bad page', () => {
    const ids = check(page('/bad.html'), 'a11y').issues.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['image-alt', 'label', 'color-contrast', 'html-has-lang']));
  });

  it('catches the deliberate SEO defects on the bad page', () => {
    const ids = check(page('/bad.html'), 'seo').issues.map((i) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'canonical-multiple',
        'title-length',
        'meta-description-missing',
        'h1-multiple',
        'html-lang-missing',
        'viewport-missing',
        'hreflang-invalid-code',
        'hreflang-relative',
        'jsonld-invalid',
      ])
    );
  });

  it('attributes the 400ms long task after first paint to TBT', () => {
    const perf = check(page('/bad.html'), 'perf');
    // 400ms busy loop => ~350ms beyond the 50ms budget; generous bounds for CI jitter.
    expect(perf.metrics?.tbt).toBeGreaterThanOrEqual(250);
    expect(perf.issues.map((i) => i.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^tbt-/)]));
  });

  it('reads noindex from the X-Robots-Tag response header', () => {
    expect(check(page('/noindex.html'), 'seo').issues.map((i) => i.id)).toContain('noindex');
  });

  it('flags a 404 as critical but still audits the error page', () => {
    const seo = check(page('/missing'), 'seo');
    expect(seo.issues[0]).toMatchObject({ id: 'http-status', severity: 'critical' });
  });

  it('records an unreachable page as a page error with no checks, without aborting the run', () => {
    const failed = report.pages.find((p) => p.url === 'http://127.0.0.1:1/unreachable');
    expect(failed?.error).toMatch(/ERR_UNSAFE_PORT/);
    expect(failed?.checks).toEqual([]);
  });
});
