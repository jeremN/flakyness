import { describe, it, expect, beforeAll } from 'vitest';
import { SESSION_COOKIE } from '../services/auth/session';
import { withAdvisoryLock, GLOBAL_ADMIN_LOCK_KEY } from '../test-support/advisory-lock';
import { clearMustChangePassword } from '../test-support/onboard-provisioned-user';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeScope = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
});
const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

async function json(res: Response) {
  return res.json();
}

/**
 * A minimal but REAL Playwright report — one spec, one passing execution.
 * Ingesting it is what gives the fixture a genuine `test_runs` row, which
 * `/:id/runs/:runId` needs (see the note above READ_PATHS for why a
 * fabricated run id would make the cross-team assertion vacuous).
 */
function buildReport() {
  const startTime = new Date().toISOString();
  return {
    config: { version: '1.40.0' },
    suites: [
      {
        title: 'scope.spec.ts',
        file: 'scope.spec.ts',
        specs: [
          {
            title: 'a test',
            ok: true,
            tags: [],
            location: { file: 'scope.spec.ts', line: 1, column: 1 },
            tests: [
              { results: [{ workerIndex: 0, status: 'passed', duration: 10, retry: 0, startTime }] },
            ],
          },
        ],
      },
    ],
  };
}

/** Create a team, a project inside it, and a user with the given role. */
async function fixture(role: 'team_admin' | 'member') {
  const team = (await json(await app.request('/api/v1/admin/teams', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: uniq('t') }),
  }))).team;

  const created = await json(await app.request('/api/v1/admin/projects', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ name: uniq('p'), teamId: team.id }),
  }));

  const user = (await json(await app.request('/api/v1/admin/users', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ email: `${uniq('u')}@example.test` }),
  })));
  // This suite is about team scoping, not the password lifecycle — onboard
  // the user past the forced first-time change before it logs in below.
  await clearMustChangePassword(user.user.id);

  await app.request(`/api/v1/admin/teams/${team.id}/members`, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ userId: user.user.id, role }),
  });

  // Ingest one report so the project owns a REAL test_runs row. `branch` and
  // `commit` are QUERY params (reports.ts's zValidator('query', …)); the body
  // is the raw report. The run row is committed before the 201, so there is no
  // reconcile race to wait on here — `?wait=true` is not needed.
  const ingest = await json(await app.request(
    `/api/v1/reports?branch=main&commit=${'a'.repeat(40)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.token}` },
      body: JSON.stringify(buildReport()),
    }
  ));

  const loginRes = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.user.email, password: user.temporaryPassword }),
  });
  const cookie = (loginRes.headers.get('set-cookie') ?? '')
    .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];

  return {
    team,
    project: created.project,
    projectToken: created.token,
    runId: ingest.testRun.id as string,
    user: user.user,
    cookie: cookie!,
  };
}

const as = (cookie: string) => ({ headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });

// Every project-scoped read route in projects.ts — all SEVEN — so a new one
// cannot be added without a deliberate decision about whether it belongs here.
//
// `/:id/runs/:runId` takes a REAL run id, created by the fixture's ingest, and
// that is load-bearing rather than tidiness: with a fabricated id the route
// 404s because the run does not exist, so the cross-team assertion below would
// pass identically whether or not resolveAccess is mounted. It would assert
// nothing. Passing the other team's real run id is what makes the 404 mean
// "hidden" instead of "absent" — without the guard that request returns 200.
const READ_PATHS = (id: string, runId: string) => [
  `/api/v1/projects/${id}/stats`,
  `/api/v1/projects/${id}/flaky-tests`,
  `/api/v1/projects/${id}/quarantine`,
  `/api/v1/projects/${id}/runs`,
  `/api/v1/projects/${id}/runs/${runId}`,
  `/api/v1/projects/${id}/analysis`,
  `/api/v1/projects/${id}/trend`,
];

describeScope('per-team read scoping', () => {
  it('a member reads their own team\'s project on every read route', async () => {
    const f = await fixture('member');
    for (const path of READ_PATHS(f.project.id, f.runId)) {
      const res = await app.request(path, as(f.cookie));
      expect(res.status, `${path} should be readable by its own team`).toBe(200);
    }
  });

  it('a member gets 404 — NOT 403 — for another team\'s project, on every read route', async () => {
    const mine = await fixture('member');
    const theirs = await fixture('member');

    for (const path of READ_PATHS(theirs.project.id, theirs.runId)) {
      const res = await app.request(path, as(mine.cookie));
      expect(res.status, `${path} must hide another team's project`).toBe(404);
    }
  });

  it('a global admin reads any team\'s project', async () => {
    const theirs = await fixture('member');

    // The whole create → assert window runs under the SAME advisory lock
    // admin-users.test.ts's withSoleGlobalAdmin() takes (see
    // GLOBAL_ADMIN_LOCK_KEY's doc comment) — not just the create call.
    // withSoleGlobalAdmin snapshots the ambient `isGlobalAdmin` set, demotes
    // ALL of it (including any admin this test has already created), runs
    // its own assertion, then restores it — so a concurrent
    // snapshot-demote-restore cycle landing anywhere between this test's
    // create and its final `expect` would transiently flip this user's
    // `isGlobalAdmin` back to false, and the GET below would 404 instead of
    // 200. The lock must stay held until this test no longer depends on the
    // flag being true, which is the entire body, not just the POST.
    await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
      const adminUser = await json(await app.request('/api/v1/admin/users', {
        method: 'POST', headers: adminHeaders(),
        body: JSON.stringify({ email: `${uniq('ga')}@example.test`, isGlobalAdmin: true }),
      }));
      // Onboard past the forced first-time change — see
      // clearMustChangePassword's doc comment.
      await clearMustChangePassword(adminUser.user.id);
      const loginRes = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminUser.user.email, password: adminUser.temporaryPassword }),
      });
      const cookie = (loginRes.headers.get('set-cookie') ?? '')
        .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];

      const res = await app.request(`/api/v1/projects/${theirs.project.id}/stats`, as(cookie!));
      expect(res.status).toBe(200);
    });
  });

  it('a user in no team sees nothing', async () => {
    const theirs = await fixture('member');
    const loner = await json(await app.request('/api/v1/admin/users', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ email: `${uniq('lone')}@example.test` }),
    }));
    // Onboard past the forced first-time change — see
    // clearMustChangePassword's doc comment.
    await clearMustChangePassword(loner.user.id);
    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loner.user.email, password: loner.temporaryPassword }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '')
      .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];

    const res = await app.request(`/api/v1/projects/${theirs.project.id}/stats`, as(cookie!));
    expect(res.status).toBe(404);
  });
});

// The two /tests/:testName/* reads take `project` as a QUERY param, not a path
// segment like projects.ts's routes — they don't fit READ_PATHS's shape, so
// this is a small dedicated list, but the same own-team-200 / other-team-404
// pattern as READ_PATHS above. `'a test'` is the spec title `buildReport()`
// ingests via `fixture()` — `scope.spec.ts` is a file-level suite title (ends
// in `.ts`) and is skipped from the joined name (parsers/playwright.ts:176-181,
// :203-204), so the stored testName is exactly `'a test'`, no prefix.
const TEST_SCOPED_READ_PATHS = (projectId: string) => [
  `/api/v1/tests/${encodeURIComponent('a test')}/history?project=${projectId}`,
  `/api/v1/tests/${encodeURIComponent('a test')}/trend?project=${projectId}`,
];

describeScope('per-team read scoping — /tests/:testName/* routes', () => {
  it('a member reads their own team\'s project on both /tests/:testName/* routes', async () => {
    const f = await fixture('member');
    for (const path of TEST_SCOPED_READ_PATHS(f.project.id)) {
      const res = await app.request(path, as(f.cookie));
      expect(res.status, `${path} should be readable by its own team`).toBe(200);
    }
  });

  it('a member gets 404 — NOT 403 — for another team\'s project, on both /tests/:testName/* routes', async () => {
    const mine = await fixture('member');
    const theirs = await fixture('member');
    for (const path of TEST_SCOPED_READ_PATHS(theirs.project.id)) {
      const res = await app.request(path, as(mine.cookie));
      expect(res.status, `${path} must hide another team's project`).toBe(404);
    }
  });
});

describeScope('flaky-test mute authorization', () => {
  const FLAKY_TEST_NAME = 'always flaky test';

  /**
   * Ingest one report so the project has a flaky_tests row to mute, and return
   * that row's id.
   *
   * `?wait=true` awaits the reconcile (plan 032). Without it the ingest returns
   * 201 BEFORE updateFlakyTests has run and this helper would race it —
   * the exact bug plan 027 chased in this repo's own suite. Never sleep here.
   *
   * Three things here are load-bearing and were each got wrong in the plan's
   * first draft; do not "simplify" any of them back:
   *
   *  1. `branch` and `commit` are QUERY params — `reports.ts:93` is
   *     `zValidator('query', reportQuerySchema)`. The body is the raw report,
   *     not `{branch, commitSha, report}`. (`commit`, not `commitSha`.)
   *  2. `config` is REQUIRED by `PlaywrightReportSchema`
   *     (`parsers/playwright.ts:124` — the object is optional-fielded but not
   *     itself optional). Omitting it is a 400.
   *  3. There are THREE executions, not one. `DEFAULT_CONFIG.minRuns` is 3
   *     (`services/flakiness.ts:16`) and `computeFlakiness` skips any test with
   *     `totalRuns < minRuns` — so a single flaky execution ingests fine and
   *     silently produces NO flaky_tests row, and the caller then reads
   *     `undefined.id`. Three flaky executions give flakeRate 1.0, far above
   *     the 5% default threshold.
   *
   * `status: 'flaky'` on a test entry is NOT how flakiness is decided — the
   * parser derives it from the results (`determineStatus`, playwright.ts:211:
   * failed on some attempts, passed on retry). Which is why each execution
   * below carries a failed attempt and a passing retry.
   */
  async function seedFlaky(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
    const startTime = new Date().toISOString();
    // Real reporter nesting: suites[].specs[].tests[].results[] (AGENTS.md).
    const flakyExecution = () => ({
      results: [
        { workerIndex: 0, status: 'failed', duration: 10, retry: 0, startTime },
        { workerIndex: 0, status: 'passed', duration: 10, retry: 1, startTime },
      ],
    });

    const report = {
      config: { version: '1.40.0' },
      suites: [
        {
          title: 'flaky.spec.ts',
          file: 'flaky.spec.ts',
          specs: [
            {
              title: FLAKY_TEST_NAME,
              ok: true,
              tags: [],
              location: { file: 'flaky.spec.ts', line: 1, column: 1 },
              tests: [flakyExecution(), flakyExecution(), flakyExecution()],
            },
          ],
        },
      ],
    };

    const res = await app.request(
      `/api/v1/reports?wait=true&branch=main&commit=${'b'.repeat(40)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.projectToken}` },
        body: JSON.stringify(report),
      }
    );
    expect(res.status).toBe(201);

    // Look the row up by NAME rather than taking [0]. The fixture's own ingest
    // already put a second test in this project, and an index would quietly
    // mute whichever row happened to sort first — a test that passes while
    // asserting something other than what it claims.
    const list = await json(
      await app.request(`/api/v1/projects/${f.project.id}/flaky-tests`, as(f.cookie))
    );
    const row = list.flakyTests.find(
      (t: { testName: string }) => t.testName === FLAKY_TEST_NAME
    );
    expect(row, `seedFlaky: no flaky_tests row for "${FLAKY_TEST_NAME}"`).toBeDefined();
    return row.id as string;
  }

  it('a team_admin may mute a test in their own team', async () => {
    const f = await fixture('team_admin');
    const flakyId = await seedFlaky(f);

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(200);
  });

  it('a member gets 403 — they can SEE the project, so hiding it would be a lie', async () => {
    const f = await fixture('member');
    const flakyId = await seedFlaky(f);

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(403);
  });

  it('a team_admin of ANOTHER team gets 404 — they cannot see it at all', async () => {
    const mine = await fixture('team_admin');
    const theirs = await fixture('team_admin');
    const flakyId = await seedFlaky(theirs);

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(404);
  });

  it('ADMIN_TOKEN still mutes anything (break-glass unchanged)', async () => {
    const f = await fixture('member');
    const flakyId = await seedFlaky(f);

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH', headers: adminHeaders(), body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(200);
  });

  it('a project (ingest) token gets 401 muting a test in its OWN project — mute is a management action, not a per-project write (docs/API.md)', async () => {
    const f = await fixture('member');
    const flakyId = await seedFlaky(f);

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.projectToken}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /tests/flaky/:id hides another team\'s row', async () => {
    const mine = await fixture('member');
    const theirs = await fixture('member');
    const flakyId = await seedFlaky(theirs);

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, as(mine.cookie));
    expect(res.status).toBe(404);
  });
});

describeScope('GET /api/v1/projects list filtering', () => {
  it('lists only the caller\'s teams\' projects', async () => {
    const mine = await fixture('member');
    const theirs = await fixture('member');

    const body = await json(await app.request('/api/v1/projects', as(mine.cookie)));
    const ids = body.projects.map((p: { id: string }) => p.id);

    expect(ids).toContain(mine.project.id);
    expect(ids).not.toContain(theirs.project.id);
  });

  it('is unfiltered for a caller with no session (open deployment unchanged)', async () => {
    // Only meaningful when READ_TOKEN is unset, which is the default in the
    // test environment. This is the backward-compatibility seam: teams must
    // not silently close a deployment the operator left open.
    if (process.env.READ_TOKEN) return;

    const a = await fixture('member');
    const b = await fixture('member');
    const body = await json(await app.request('/api/v1/projects'));
    const ids = body.projects.map((p: { id: string }) => p.id);

    expect(ids).toContain(a.project.id);
    expect(ids).toContain(b.project.id);
  });

  // Task 3's review found the DoD's "an orphaned project is invisible to
  // every non-global-admin" line was proven only at unit level
  // (services/auth/access.test.ts's canReadProject cases) and never over
  // HTTP, even though both the list filter (scopesProjectList/canReadProject
  // above) and the per-route guard (resolveAccess -> canReadProject) share
  // the same predicate. This closes that gap end-to-end: create a project
  // with NO teamId (POST /admin/projects omits it — team_id IS NULL, per
  // canReadProject's 'user' branch in services/auth/access.ts, which requires
  // project.teamId !== null before it even checks membership), then assert
  // both the single-project read AND the list are consistent for a member vs
  // a global admin.
  it('an orphaned project (no teamId) is invisible to a member but visible to a global admin', async () => {
    const orphan = (await json(await app.request('/api/v1/admin/projects', {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: uniq('orphan') }),
    }))).project;
    expect(
      orphan.teamId,
      'fixture assumption: POST /admin/projects without teamId must leave the project unassigned'
    ).toBeNull();

    const member = await fixture('member');

    const singleRead = await app.request(`/api/v1/projects/${orphan.id}/stats`, as(member.cookie));
    expect(singleRead.status, 'a member must not be able to read an orphaned project').toBe(404);

    const memberList = await json(await app.request('/api/v1/projects', as(member.cookie)));
    const memberIds = memberList.projects.map((p: { id: string }) => p.id);
    expect(
      memberIds,
      'an orphaned project must not appear in a member\'s project list'
    ).not.toContain(orphan.id);

    // See the doc comment on the 'a global admin reads any team\'s project'
    // test above for why the lock must span creation through the final
    // assertion, not just the create call.
    await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
      const adminUser = await json(await app.request('/api/v1/admin/users', {
        method: 'POST', headers: adminHeaders(),
        body: JSON.stringify({ email: `${uniq('ga')}@example.test`, isGlobalAdmin: true }),
      }));
      // Onboard past the forced first-time change — see
      // clearMustChangePassword's doc comment.
      await clearMustChangePassword(adminUser.user.id);
      const loginRes = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminUser.user.email, password: adminUser.temporaryPassword }),
      });
      const cookie = (loginRes.headers.get('set-cookie') ?? '')
        .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];

      const adminRead = await app.request(`/api/v1/projects/${orphan.id}/stats`, as(cookie!));
      expect(adminRead.status, 'a global admin must be able to read an orphaned project').toBe(200);

      const adminList = await json(await app.request('/api/v1/projects', as(cookie!)));
      const adminIds = adminList.projects.map((p: { id: string }) => p.id);
      expect(
        adminIds,
        'a global admin must see the orphaned project in their project list too'
      ).toContain(orphan.id);
    });
  });
});

describeScope('admin API accepts a global-admin session', () => {
  async function globalAdminCookie() {
    const created = await json(await app.request('/api/v1/admin/users', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ email: `${uniq('ga')}@example.test`, isGlobalAdmin: true }),
    }));
    // Onboard past the forced first-time change — see
    // clearMustChangePassword's doc comment.
    await clearMustChangePassword(created.user.id);
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: created.user.email, password: created.temporaryPassword }),
    });
    // Split the optional-chain result out of the return statement rather
    // than asserting `?.[1]!` inline — same value, but oxlint's
    // no-non-null-asserted-optional-chain rule (deny-warnings) flags the
    // inline form. Matches the style `fixture()` above already uses.
    const cookie = (res.headers.get('set-cookie') ?? '')
      .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];
    return cookie!;
  }

  // MANDATORY: every test that creates a global admin holds GLOBAL_ADMIN_LOCK_KEY
  // across its ENTIRE body — creation through final assertion — not just around
  // globalAdminCookie(). `admin-users.test.ts`'s withSoleGlobalAdmin demotes every
  // ambient global admin and asserts its target is the sole one; a concurrent
  // creation makes that demote legal and reddens it. Task 3 shipped this bug once
  // and then hit a SECOND variant of it when the first fix released the lock after
  // creation but before the assertion — the freshly-made admin got demoted in that
  // gap. Shrinking the window is not closing it. See `test-support/advisory-lock.ts`.
  it('a global admin session can list projects without ADMIN_TOKEN', async () => {
    await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
      const cookie = await globalAdminCookie();
      const res = await app.request('/api/v1/admin/projects', as(cookie));
      expect(res.status).toBe(200);
    });
  });

  it('a global admin session can administer teams', async () => {
    await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
      const cookie = await globalAdminCookie();
      const res = await app.request('/api/v1/admin/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${cookie}` },
        body: JSON.stringify({ name: uniq('ga-team') }),
      });
      expect(res.status).toBe(201);
    });
  });

  it('a team_admin session is REFUSED on team CRUD (never delegated)', async () => {
    const f = await fixture('team_admin');
    const res = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ name: uniq('nope') }),
    });
    expect(res.status).toBe(403);
  });

  it('a team_admin session is REFUSED on user provisioning', async () => {
    const f = await fixture('team_admin');
    const res = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ email: `${uniq('x')}@example.test` }),
    });
    expect(res.status).toBe(403);
  });

  // The claim is "everywhere", so assert everywhere — one route would leave
  // the other admin surfaces free to admit a member by omission, which is the
  // precise failure the closed gate exists to prevent.
  it('a plain member session is refused everywhere on the admin API', async () => {
    const f = await fixture('member');
    for (const path of ['/api/v1/admin/projects', '/api/v1/admin/teams', '/api/v1/admin/users']) {
      const res = await app.request(path, as(f.cookie));
      expect(res.status, `${path} must refuse a plain member`).toBe(403);
    }
  });

  it('an anonymous caller gets 401 on the admin API, not 403', async () => {
    // 401 and 403 are different facts: 403 means "we know who you are and the
    // answer is no", which is only sayable to someone identified. Telling an
    // anonymous caller 403 also confirms the endpoint exists to anyone.
    const res = await app.request('/api/v1/admin/projects');
    expect(res.status).toBe(401);
  });

  it('a team_admin may NOT create a project (operator act, not a team act)', async () => {
    const f = await fixture('team_admin');
    const res = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ name: uniq('nope') }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /admin/projects is filtered for a team_admin', async () => {
    const mine = await fixture('team_admin');
    const theirs = await fixture('team_admin');
    const body = await json(await app.request('/api/v1/admin/projects', as(mine.cookie)));
    const ids = body.projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(mine.project.id);
    expect(ids).not.toContain(theirs.project.id);
  });

  // Fix round 1, IMPORTANT: the list must filter on ROLE (canReadProject AND
  // canWriteProject — the same bar scopedAdminProject uses), not on plain
  // membership (canReadProject alone). Every row here carries admin-only
  // detail (webhookUrl, hasToken) that GET /api/v1/projects never exposes —
  // a caller who is team_admin in A and only a plain member in B must not
  // get B's admin detail here just because they can read B elsewhere.
  it('a user who is team_admin in A and a plain member in B does not see B\'s project here', async () => {
    const teamAdminInA = await fixture('team_admin');
    const memberInB = await fixture('member');

    await app.request(`/api/v1/admin/teams/${memberInB.team.id}/members`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ userId: teamAdminInA.user.id, role: 'member' }),
    });

    const body = await json(await app.request('/api/v1/admin/projects', as(teamAdminInA.cookie)));
    const ids = body.projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(teamAdminInA.project.id);
    expect(
      ids,
      'plain membership must not surface admin-only detail for another team\'s project'
    ).not.toContain(memberInB.project.id);
  });

  it('a team_admin may PATCH their own project\'s settings but not another team\'s', async () => {
    const mine = await fixture('team_admin');
    const theirs = await fixture('team_admin');

    const ok = await app.request(`/api/v1/admin/projects/${mine.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ minRuns: 7 }),
    });
    expect(ok.status).toBe(200);

    const denied = await app.request(`/api/v1/admin/projects/${theirs.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ minRuns: 7 }),
    });
    expect(denied.status).toBe(404);
  });

  // Fix round 1, CRITICAL: PATCH {teamId} is a reassignment, not a settings
  // tweak — scopedAdminProject alone only proves the caller may touch the
  // project's CURRENT team, not the team they're trying to move it to (or
  // away from). Asserting the PERSISTED value, not just the status: a 403
  // that still wrote the field would pass a status-only check.
  it('a team_admin may NOT reassign their own project to another team via PATCH', async () => {
    const mine = await fixture('team_admin');
    const otherTeam = (await json(await app.request('/api/v1/admin/teams', {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: uniq('t') }),
    }))).team;

    const res = await app.request(`/api/v1/admin/projects/${mine.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ teamId: otherTeam.id }),
    });
    expect(res.status).toBe(403);

    const list = await json(await app.request('/api/v1/admin/projects', { headers: adminHeaders() }));
    const persisted = list.projects.find((p: { id: string }) => p.id === mine.project.id);
    expect(persisted.teamId, 'a 403 must not have written the new teamId').toBe(mine.team.id);
  });

  it('a team_admin may NOT orphan their own project via PATCH {teamId: null}', async () => {
    const mine = await fixture('team_admin');

    const res = await app.request(`/api/v1/admin/projects/${mine.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ teamId: null }),
    });
    expect(res.status).toBe(403);

    const list = await json(await app.request('/api/v1/admin/projects', { headers: adminHeaders() }));
    const persisted = list.projects.find((p: { id: string }) => p.id === mine.project.id);
    expect(persisted.teamId, 'a 403 must not have orphaned the project').toBe(mine.team.id);
  });

  it('a team_admin may NOT delete a project (destructive ops stay global-admin)', async () => {
    const mine = await fixture('team_admin');
    const res = await app.request(`/api/v1/admin/projects/${mine.project.id}`, {
      method: 'DELETE',
      headers: { Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
    });
    expect(res.status).toBe(403);
  });

  it('ADMIN_TOKEN still does everything (break-glass unchanged)', async () => {
    const res = await app.request('/api/v1/admin/projects', { headers: adminHeaders() });
    expect(res.status).toBe(200);
  });

  // Fix round 1 ruling: GET /admin/health is install-wide operator telemetry
  // with no team-scope story, so it stays global-admin only.
  it('a team_admin is REFUSED on GET /admin/health (operator telemetry, global-admin only)', async () => {
    const f = await fixture('team_admin');
    const res = await app.request('/api/v1/admin/health', as(f.cookie));
    expect(res.status).toBe(403);
  });

  // Extra coverage beyond the brief's own set: scopedAdminProject() is one
  // shared helper called from EIGHT routes (rotate-token, PATCH, prune, and
  // all five rules routes: GET, POST, PATCH/:ruleId, DELETE/:ruleId,
  // POST/reorder). Fix round 1 found that the brief's own PATCH test only
  // proves >=1 call site is wired — neutering the shared HELPER (as the
  // original probe 3 did) can't tell you which. Every one of the eight is
  // asserted below with its OWN message, so a single site losing its check
  // reddens alone, not "some assertion in this test failed".
  it('a team_admin is scoped on rotate-token, prune and rules routes too', async () => {
    const mine = await fixture('team_admin');
    const theirs = await fixture('team_admin');

    // Seeded via ADMIN_TOKEN (bypasses scope by design) so PATCH/DELETE/
    // reorder below have a real rule id on theirs.project to target.
    const seededRule = await json(await app.request(
      `/api/v1/admin/projects/${theirs.project.id}/rules`,
      { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ action: 'exempt' }) }
    ));
    const theirsRuleId = seededRule.rule.id as string;

    const rotate = await app.request(`/api/v1/admin/projects/${theirs.project.id}/rotate-token`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
    });
    expect(rotate.status, 'rotate-token must hide another team\'s project').toBe(404);

    const prune = await app.request(`/api/v1/admin/projects/${theirs.project.id}/prune`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
    });
    expect(prune.status, 'prune must hide another team\'s project').toBe(404);

    const rulesList = await app.request(`/api/v1/admin/projects/${theirs.project.id}/rules`, as(mine.cookie));
    expect(rulesList.status, 'GET rules must hide another team\'s project').toBe(404);

    const rulesCreate = await app.request(`/api/v1/admin/projects/${theirs.project.id}/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ action: 'exempt' }),
    });
    expect(rulesCreate.status, 'POST rules must hide another team\'s project').toBe(404);

    const rulesPatch = await app.request(
      `/api/v1/admin/projects/${theirs.project.id}/rules/${theirsRuleId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
        body: JSON.stringify({ enabled: false }),
      }
    );
    expect(rulesPatch.status, 'PATCH rules/:ruleId must hide another team\'s project').toBe(404);

    const rulesReorder = await app.request(
      `/api/v1/admin/projects/${theirs.project.id}/rules/reorder`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
        body: JSON.stringify({ order: [theirsRuleId] }),
      }
    );
    expect(rulesReorder.status, 'POST rules/reorder must hide another team\'s project').toBe(404);

    // DELETE last — it's destructive, and PATCH/reorder above need the
    // seeded rule to still exist when they run.
    const rulesDelete = await app.request(
      `/api/v1/admin/projects/${theirs.project.id}/rules/${theirsRuleId}`,
      { method: 'DELETE', headers: { Cookie: `${SESSION_COOKIE}=${mine.cookie}` } }
    );
    expect(rulesDelete.status, 'DELETE rules/:ruleId must hide another team\'s project').toBe(404);

    // And the same routes succeed against the caller's OWN project, so the
    // 404s above are scope, not "team_admin can never reach these routes".
    const ownRotate = await app.request(`/api/v1/admin/projects/${mine.project.id}/rotate-token`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
    });
    expect(ownRotate.status, 'rotate-token must succeed on own project').toBe(200);

    const ownRulesList = await app.request(`/api/v1/admin/projects/${mine.project.id}/rules`, as(mine.cookie));
    expect(ownRulesList.status, 'GET rules must succeed on own project').toBe(200);
  });
});
