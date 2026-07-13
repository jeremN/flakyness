import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The real reporter output the API's own parser is built against — using a
// hand-written fixture would only prove the parser handles what we imagined,
// not what Playwright actually emits.
const FIXTURE_PATH = resolve(__dirname, '../../api/fixtures/real-report.json');

// Read by every spec (via ./seed.ts) and by the specs' assertions. NOT
// committed — see .gitignore. Contains no secret: the project's ingest
// token is used once, in-memory, right here, and never written to disk.
export const SEED_PATH = resolve(__dirname, '.artifacts/seed.json');

const API_URL = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// DEFAULT_CONFIG.minRuns in apps/api/src/services/flakiness.ts is 3 — fewer
// ingests and no test ever crosses the threshold to become "flaky", so
// /flaky would have nothing to assert. If that default ever changes, this
// must change with it (see plan 026 maintenance notes).
const INGEST_COUNT = 3;

// Distinct-but-fixed 40-char commit shas, one per ingest, so /runs shows
// three genuinely distinct rows rather than one repeated three times. The
// differentiating digit sits right after the prefix (not at the far end) so
// the UI's 7-char truncated display (`commitSha.slice(0, 7)`) still shows
// three different values.
const COMMIT_SHAS = [
  'e2e1000000000000000000000000000000000000', // 40 chars
  'e2e2000000000000000000000000000000000000', // 40 chars
  'e2e3000000000000000000000000000000000000', // 40 chars
];

interface CreateProjectResponse {
  project: { id: string; name: string };
  token: string;
}

interface FlakyTestsResponse {
  flakyTests: unknown[];
}

async function readBodyForError(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Poll a real, observable condition (an active flaky test appearing) rather
 * than guessing a fixed delay. Report ingestion triggers flaky-test
 * detection asynchronously and fire-and-forget (see
 * apps/api/src/routes/reports.ts `updateFlakyTests(...).then(...)`), so
 * there is a genuine, unbounded-in-principle gap between "ingest returned
 * 201" and "the flaky_tests table reflects it". This bounds that gap with a
 * real, condition-based check instead of a fixed blind delay.
 */
async function waitForActiveFlakyTest(projectId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const res = await fetch(`${API_URL}/api/v1/projects/${projectId}/flaky-tests?status=active`);
    if (res.ok) {
      const body = (await res.json()) as FlakyTestsResponse;
      lastCount = body.flakyTests.length;
      if (lastCount > 0) return;
    }
    await new Promise((done) => setTimeout(done, 250));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for an active flaky test to appear ` +
      `for project ${projectId} (last observed count: ${lastCount}). ` +
      'Either flakiness detection is broken, or DEFAULT_CONFIG.minRuns changed ' +
      'without updating this seed (see plan 026 maintenance notes).'
  );
}

export default async function globalSetup(): Promise<void> {
  if (!ADMIN_TOKEN) {
    throw new Error(
      'ADMIN_TOKEN must be set for the E2E global setup to create its seed project.'
    );
  }

  const projectName = `e2e-dogfood-${Date.now()}`;

  const createRes = await fetch(`${API_URL}/api/v1/admin/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: projectName }),
  });
  if (createRes.status !== 201) {
    throw new Error(
      `Failed to create seed project (${createRes.status}): ${await readBodyForError(createRes)}`
    );
  }
  const { project, token }: CreateProjectResponse = await createRes.json();

  const fixture = readFileSync(FIXTURE_PATH, 'utf-8');

  for (let i = 0; i < INGEST_COUNT; i++) {
    const commit = COMMIT_SHAS[i];
    const url = `${API_URL}/api/v1/reports?branch=main&commit=${commit}&pipeline=${i + 1}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: fixture,
    });
    if (res.status !== 201) {
      throw new Error(
        `Seed ingest ${i + 1}/${INGEST_COUNT} failed (${res.status}): ${await readBodyForError(res)}`
      );
    }
  }

  await waitForActiveFlakyTest(project.id, 20_000);

  mkdirSync(dirname(SEED_PATH), { recursive: true });
  writeFileSync(
    SEED_PATH,
    JSON.stringify({ projectId: project.id, projectName }, null, 2)
  );
}
