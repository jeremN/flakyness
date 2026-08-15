import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirrors playwright.config.ts's own BASE_URL computation (that file defines
// it independently too, for the same reason: the config's webServer plugin
// task runs BEFORE this global setup — see Playwright's
// createGlobalSetupTasks — so by the time this file runs, the built
// dashboard is already up and reachable here).
const DASHBOARD_PORT = process.env.E2E_DASHBOARD_PORT ?? '4173';
const BASE_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

// Where the shared, already-signed-in storageState is written — wired into
// playwright.config.ts's `use.storageState` as 'e2e/.auth/user.json'
// (relative to this same directory). Gitignored: see .gitignore.
export const AUTH_STORAGE_STATE_PATH = resolve(__dirname, '.auth/user.json');

// Not a real secret: this account only ever exists inside a throwaway E2E
// database, recreated fresh on every run. Only needs to satisfy the API's
// MIN_PASSWORD_LENGTH (12) and differ from whatever temporary password the
// admin-users endpoint issues.
const NEW_PASSWORD = 'e2e-suite-storage-state-password';

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

  // Carry READ_TOKEN when the API has one. This poll is the only request in
  // this file that sends no credential at all, which is fine on the default
  // deployment (readAuth returns early when READ_TOKEN is unset) but 401s
  // forever on a hardened one — the suite then fails here, in setup, with a
  // "flakiness detection is broken" message that blames the wrong thing.
  // Sending it makes `READ_TOKEN=… pnpm --filter dashboard test:e2e` a usable
  // way to exercise the hardened posture, which is where the dashboard's
  // send-both-credentials contract ($lib/server/api.ts) actually matters.
  const readHeaders: Record<string, string> = process.env.READ_TOKEN
    ? { Authorization: `Bearer ${process.env.READ_TOKEN}` }
    : {};

  while (Date.now() < deadline) {
    const res = await fetch(`${API_URL}/api/v1/projects/${projectId}/flaky-tests?status=active`, {
      headers: readHeaders,
    });
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

/**
 * Provision one global-admin user and sign in through the REAL dashboard
 * `/login` + forced `/change-password` flow — not a raw API call — so the
 * resulting storageState carries the dashboard's own `fk_session` cookie on
 * the dashboard's own origin. The API's `Set-Cookie` from a direct API login
 * would be useless here: it's consumed server-side by
 * `$lib/server/session.ts`'s `fetchMe` and never reaches a browser. A real
 * Chromium page (rather than a raw fetch) also sidesteps having to hand-craft
 * an `Origin` header for SvelteKit's CSRF check — the browser sets it exactly
 * the way a real sign-in would.
 *
 * Every spec written before plan 059 reuses the resulting storageState via
 * playwright.config.ts's `use.storageState`, so it never sees /login.
 */
async function seedAuthenticatedUser(adminToken: string): Promise<void> {
  const email = `e2e-dogfood-admin-${Date.now()}@example.test`;

  const createRes = await fetch(`${API_URL}/api/v1/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, displayName: 'E2E Admin', isGlobalAdmin: true }),
  });
  if (createRes.status !== 201) {
    throw new Error(
      `Failed to create the E2E global-admin user (${createRes.status}): ${await readBodyForError(createRes)}`
    );
  }
  const { temporaryPassword }: { temporaryPassword: string } = await createRes.json();

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: BASE_URL });
    // Task 8 fix round 1 (BLOCKING #2): the dashboard runs with
    // ADDRESS_HEADER=x-forwarded-for (playwright.config.ts's webServer.env),
    // so event.getClientAddress() reads this header on EVERY request and
    // THROWS if it's absent (verified directly against a built dashboard: a
    // request with no x-forwarded-for 500s). This context's login flow goes
    // through the real dashboard, so it needs the header too — a fixed
    // identity distinct from every per-worker one (see ./fixtures.ts), since
    // this runs once in the main process, never inside a worker.
    await context.setExtraHTTPHeaders({ 'x-forwarded-for': '10.99.0.0' });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(temporaryPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // A freshly provisioned user is ALWAYS forced here (see
    // $lib/session.ts's redirectTargetFor) — never straight to '/'. Waiting
    // for the exact path surfaces a broken forced-reset redirect here, with a
    // clear error, instead of timing out generically on the next step.
    await page.waitForURL((url) => url.pathname === '/change-password');
    await page.getByLabel('Current password', { exact: true }).fill(temporaryPassword);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();

    // The re-issued-cookie property from Task 5: a broken re-issue would
    // strand this on /change-password (or bounce back to /login) instead of
    // landing on '/'.
    await page.waitForURL((url) => url.pathname === '/');

    mkdirSync(dirname(AUTH_STORAGE_STATE_PATH), { recursive: true });
    await context.storageState({ path: AUTH_STORAGE_STATE_PATH });
  } finally {
    await browser.close();
  }
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

  // Independent of the project/report seeding above — see seedAuthenticatedUser's
  // own doc comment for why this needs a real browser flow, not a fetch.
  await seedAuthenticatedUser(ADMIN_TOKEN);
}
