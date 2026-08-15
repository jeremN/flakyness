import { defineConfig, devices } from '@playwright/test';

// The dashboard's own dev port is 5173 (see vite.config.ts) — use a
// different port for the E2E build so a stray `pnpm dev` next to a test run
// can't collide with it.
const DASHBOARD_PORT = process.env.E2E_DASHBOARD_PORT ?? '4173';
const BASE_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

// The API the built dashboard talks to (SSR `load` functions) and the API
// global setup seeds directly. Must already be running before `test:e2e`
// starts — this config does not manage the API process.
const API_URL = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  testDir: './e2e',
  // Seeds one deterministic project (and its runs) via the real API before
  // any spec runs; see e2e/global-setup.ts.
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  // Plan 059, found while writing auth.spec.ts: hooks.server.ts calls
  // GET /api/v1/auth/me on EVERY server-rendered page view (the session
  // gate). A first attempt at fixing the resulting rate-limit pressure tuned
  // `workers` down — that never eliminated the risk (the API's apiRateLimit
  // window is FIXED, not sliding, so lowering concurrency only spreads the
  // same total request volume across more wall-clock time without reliably
  // lowering the peak inside any given 60s slice), it only reduced how often
  // it bit. Task 8 fix round 1 (BLOCKING #2) replaced that with the real
  // fix: every worker now presents its own client IP (see ./e2e/fixtures.ts,
  // and ADDRESS_HEADER below), so the API's per-IP rate limiters key each
  // worker into a separate bucket exactly as they would for separate real
  // users — the same TRUSTED_PROXY_IPS path production uses, not an E2E-only
  // workaround. No `workers` override is needed for this anymore; the
  // suite's own request volume no longer competes for one shared bucket at
  // all, so this is Playwright's own CPU-based default.
  // A test.only left in by accident must fail CI, not silently narrow the run.
  forbidOnly: !!process.env.CI,
  // Non-negotiable: this is a flaky-test tracker. A retry here would hide the
  // exact class of bug the product exists to surface. See AGENTS.md / plan 026.
  retries: 0,
  reporter: [
    ['list'],
    // The JSON report is what gets ingested back into Flackyness (the
    // "dogfood" step) — see .github/workflows/ci.yml's `e2e` job.
    ['json', { outputFile: 'playwright-report/report.json' }],
    // Always generated; CI only uploads this folder as an artifact on
    // failure (see design decision 6 in plan 026).
    ['html', { outputFolder: 'playwright-report/html', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Plan 059: every route now sits behind the session gate
    // (hooks.server.ts), so a spec written before this plan would otherwise
    // redirect to /login on its first navigation. global-setup.ts signs in
    // once, through the real dashboard login + forced change-password flow,
    // and persists the resulting cookie here — every spec starts already
    // authenticated as that global admin. Specs that need to exercise the
    // login flow itself (auth.spec.ts) override this per-test with
    // `test.use({ storageState: { cookies: [], origins: [] } })`.
    storageState: 'e2e/.auth/user.json',
  },
  // Chromium only — no cross-browser matrix, no sharding. Deferred until the
  // suite has been green for a while (see plan 026 maintenance notes).
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Build + serve the REAL production artifact (adapter-node's `build/`,
  // started with plain `node`), not `vite dev` / `vite preview`. Dev-mode SSR
  // has different behavior than what production actually runs, and that gap
  // is exactly what let the SSR crash in plan 008 slip through undetected.
  webServer: {
    command: 'pnpm run build && node build',
    // `port`, not `url`: once ADDRESS_HEADER is set below, EVERY request
    // without an x-forwarded-for header 500s (hooks.server.ts calls
    // event.getClientAddress() unconditionally) — including Playwright's own
    // readiness probe, which sends no custom headers. A `url` check demands
    // a successful response and hangs to its own 120s timeout on that 500;
    // `port` only waits for the TCP port to accept connections, which is all
    // "the server is up" needs to mean here. Verified directly: `url` here
    // reproduces the timeout, `port` doesn't.
    port: Number(DASHBOARD_PORT),
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: DASHBOARD_PORT,
      HOST: '127.0.0.1',
      PUBLIC_API_URL: API_URL,
      // adapter-node's CSRF origin check (SvelteKit core, not app code)
      // rejects same-origin POSTs unless it can resolve the request's real
      // origin. Without ORIGIN (or PROTOCOL_HEADER) set, it *assumes*
      // https — see get_origin() in @sveltejs/adapter-node/files/handler.js
      // — so over this plain-http E2E server every form action 403s with
      // "Cross-site POST form submissions are forbidden" even though
      // browser and server agree on the origin. Discovered by admin.spec.ts
      // (plan 053 Task 7), the first spec to exercise a POST action; no
      // prior spec caught it because every other route is read-only. See
      // the matching docker-compose.yml fix for the same gap in real
      // deployments.
      ORIGIN: BASE_URL,
      // Task 8 fix round 1 (BLOCKING #2). Makes event.getClientAddress()
      // (hooks.server.ts, read on every request) return the value of the
      // x-forwarded-for header instead of the raw socket address — every
      // Playwright browser context otherwise looks identical to the
      // dashboard's Node server (all local loopback). ./e2e/fixtures.ts sets
      // that header per worker; the API must separately trust it via
      // TRUSTED_PROXY_IPS (set where the API process is started — see
      // AGENTS.md and .github/workflows/ci.yml's `e2e` job — not here, this
      // config does not manage the API process). Verified directly against a
      // built dashboard: a request with no x-forwarded-for 500s once this is
      // set, so EVERY browser context this suite creates must send the
      // header — global-setup.ts's own login flow sets a fixed one for
      // itself alongside the per-worker ones from fixtures.ts.
      ADDRESS_HEADER: 'x-forwarded-for',
    },
  },
});
