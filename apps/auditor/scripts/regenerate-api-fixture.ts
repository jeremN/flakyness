/**
 * Regenerates apps/api/fixtures/audit-report.json — REAL auditor output that
 * the API's route tests ingest, keeping runner and API in contract.
 *
 *   AUDIT_CHROMIUM_PATH=/path/to/chrome pnpm --filter auditor fixture:api
 *
 * The ephemeral fixture-server origin is rewritten to a stable fake host so
 * the committed file does not churn on port numbers (perf numbers still will;
 * that is expected — they are measurements).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAudit } from '../src/browser';
import { parseConfig } from '../src/config';
import { startFixtureServer } from '../src/test-support/fixture-server';

const STABLE_ORIGIN = 'https://fixture.flackyness.test';
const OUT = join(import.meta.dirname, '../../api/fixtures/audit-report.json');

const server = await startFixtureServer();
try {
  const config = parseConfig({
    urls: ['/good.html', '/bad.html', '/noindex.html', '/missing'].map((p) => `${server.origin}${p}`).concat(
      'http://127.0.0.1:1/unreachable'
    ),
    devices: ['mobile', 'desktop'],
    settleMs: 1000,
  });
  const report = await runAudit(config, { executablePath: process.env.AUDIT_CHROMIUM_PATH });
  const json = JSON.stringify(report, null, 2).replaceAll(server.origin, STABLE_ORIGIN);
  await writeFile(OUT, `${json}\n`);
  console.log(`Wrote ${OUT} (${report.pages.length} pages).`);
} finally {
  await server.close();
}
