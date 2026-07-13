# Plan 024: Ship a GitHub Action that uploads reports and tells the PR which failures are known-flaky

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 38c1eaf..HEAD -- apps/api/src/routes/projects.ts apps/api/src/routes/reports.ts docs/`
> The action calls two endpoints; if either changed shape, re-read them before
> writing against them.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (new standalone action + docs; **no application source changes**)
- **Depends on**: plan 020 (its `/quarantine` endpoint is what this consumes) — **already landed**
- **Category**: direction (finding D2)
- **Planned at**: commit `38c1eaf`, 2026-07-13

## Why this matters

Flackyness knows which tests are flaky. That knowledge currently lives in a
dashboard nobody opens while a pipeline is red. The developer staring at a failed
CI run has to *already suspect* flakiness, then go look it up.

This plan closes the last few metres: a GitHub Action that uploads the Playwright
report and then **comments on the pull request** saying, in effect: *"7 tests
failed. 5 of them are known-flaky — here they are. 2 are not."* That single
sentence is the difference between "re-run the pipeline and hope" and "look at
these two".

The repo currently ships only `.gitlab-ci.yml.example` — an upload snippet. There
is no GitHub-native integration at all, even though the project lives on GitHub.

## Current state

### The two endpoints the action consumes

**Upload** — `POST /api/v1/reports`, authenticated with the *project token*
(`projectAuth`), with the branch/commit/pipeline supplied as **query params**
(this is easy to get wrong — they are NOT body fields):

```ts
reports.post(
  '/',
  zValidator('query', reportQuerySchema),
  async (c) => {
    const project = c.get('project');
    const { branch, commit, pipeline } = c.req.valid('query');
    const bodyText = await c.req.text();
    // A body starting with '<' is parsed as JUnit XML; anything else as Playwright JSON.
```

So a working upload looks like:

```bash
curl -sX POST "$API/api/v1/reports?branch=$BRANCH&commit=$SHA&pipeline=$RUN_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @report.json
```

It returns **201** with the created run. Both Playwright JSON and JUnit XML are
accepted (the API sniffs the body, not the Content-Type).

**Quarantine** — `GET /api/v1/projects/:id/quarantine` (plan 020, unauthenticated
read). It returns two sets that must never be conflated:

```jsonc
{
  "muted":  [ { "testName": "…", "flakeRate": "0.4200", … } ],  // operator muted it — human judgment
  "flaky":  [ { "testName": "…", "flakeRate": "0.1100", … } ],  // auto-detected — machine judgment
  "grepInvert": "^(?:…)$",   // built from `muted` ONLY; "" when none
  "truncated": false
}
```

`docs/API.md` documents both. Read it before writing the action.

### What exists today for CI integration

`.gitlab-ci.yml.example` at the repo root — a GitLab job that runs Playwright and
curls the report up. That is the entire integration surface. There is no
`action.yml`, no `.github/actions/`, and nothing that posts back into a PR.

## Design decisions (advisor — do not relitigate)

1. **A composite action at the repository root: `action.yml`.** Root placement is
   what makes `uses: jeremN/flakyness@v1` resolve — this is a GitHub requirement,
   not a style choice. Composite (shell steps), **not** a JavaScript action: a JS
   action would need its own `node_modules`, a build step, and committed `dist/`,
   which is a maintenance burden this project does not need.
2. **The action reports; it never skips or retries.** It does not consume
   `grepInvert` and it does not change the exit code of the test step. Deciding to
   skip a test is a human's call (that is exactly why plan 020 built `grepInvert`
   from muted tests only). An action that silently made a red build green would be
   the single worst feature this project could ship.
3. **Comment content — the useful sentence first.** Partition *this run's failures*
   against the quarantine list:
   - failures that are **muted** → known-flaky, operator already signed off
   - failures that are **auto-detected flaky** → suspicious, probably not your fault
   - failures that are **neither** → **these are the ones to look at**
   Lead with the counts. A developer should get the answer from the notification
   preview without opening the PR.
4. **Update one comment; never spam.** Find an existing Flackyness comment on the PR
   (match a hidden marker `<!-- flackyness-report -->`) and edit it in place;
   otherwise create it. A new comment per push turns a busy PR into a wall.
5. **Degrade quietly, never fail the build.** If Flackyness is unreachable, the
   token is wrong, or the report file is missing: log a warning and exit **0**. A
   flaky-test *reporter* that breaks pipelines when it is down would be an
   exquisite irony, and it would get the action ripped out of every repo that
   installed it. The one exception: a malformed *input* to the action itself
   (missing required input) may fail fast, because that is a config bug the user
   must fix.
6. **No new dependency.** Use `curl`, `jq`, and `gh` — all preinstalled on
   GitHub-hosted runners. `gh` authenticates from `GITHUB_TOKEN`.
7. **The token is a secret.** It is passed as an input, consumed via `env:`, and
   **never** echoed, never interpolated into a `run:` string directly. Do not
   `set -x` in a step that touches it.

### Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `api-url` | yes | — | e.g. `https://flackyness.example.com` |
| `token` | yes | — | project token (a secret) |
| `project-id` | yes | — | uuid, for the quarantine lookup |
| `report-path` | no | `playwright-report/report.json` | Playwright JSON or JUnit XML |
| `github-token` | no | `${{ github.token }}` | needs `pull-requests: write` |
| `comment` | no | `true` | set `false` to upload only |

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Lint the repo (must stay green) | `rtk proxy pnpm lint` | exit 0 |
| YAML parse check | `pnpm dlx yaml --json --single --strict < action.yml > /dev/null` | exit 0 |
| Local API for the e2e | see below | 201 on upload |

There is no test runner for a GitHub Action in this repo, so **you must exercise the
action's logic as a shell script against a real API** (see Test plan). "It looks
right" is not verification.

**Disposable Postgres + API** for that e2e:

```bash
docker run -d --name flackyness-test-pg-024 \
  -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test \
  -p 5452:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5452/flackyness_test pnpm db:migrate
DATABASE_URL=... ADMIN_TOKEN=... API_PORT=8098 pnpm --filter api dev   # background
```

**ALWAYS** clean up the container, the temp `.env`, and the server. **NEVER**
`docker compose up`. Note the admin routes are rate-limited to **5/min** — pace your
project-creation calls or you will get a confusing 429 mid-test.

## Scope

**In scope**:
- `action.yml` (NEW, repo root) — the composite action
- `docs/GITHUB_ACTION.md` (NEW) — usage, inputs, permissions, a full example workflow
- `README.md` — one short section pointing at the new doc (keep it to a few lines)
- `.github/workflows/example-consumer.yml.example` (NEW) — a copy-pasteable workflow
  for a *consuming* repo. **The `.example` suffix is mandatory**: a real `.yml` in
  `.github/workflows/` would execute in *this* repo.

**Out of scope** (do NOT touch):
- Any file under `apps/` — this plan changes **no application code**. The endpoints
  it needs already exist.
- `.github/workflows/ci.yml` — do not add this action to Flackyness's own CI here
  (dogfooding is plan 026's job, and touching `ci.yml` would collide with it).
- `.gitlab-ci.yml.example` — leave the GitLab path alone.
- `grepInvert` / any skip-or-retry behavior (design decision 2).

## Git workflow

Branch `advisor/024-github-action-pr-comments`; single-line conventional-commit
subject (e.g. `feat(ci): add GitHub Action that comments known-flaky failures on PRs`);
**no `Co-Authored-By`**; do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: `action.yml`

Composite action with the inputs above. Step order:

1. **Upload the report.** `curl` per the excerpt above, with branch/commit/pipeline
   from the GitHub context (`github.head_ref || github.ref_name`, `github.sha`,
   `github.run_id`). Capture the HTTP status. On non-2xx: `::warning::` and skip to
   the end with exit 0 (design decision 5).
2. **Fetch the quarantine list** for `project-id`. On failure: warn, exit 0.
3. **Extract this run's failures from the report file.** Playwright JSON nests
   attempts under `suites[].specs[].tests[].results[]` (see `apps/api/src/parsers/`
   and AGENTS.md's sharp edges) — a spec is failed when it has no passing result.
   Use `jq`. If the report is JUnit XML instead, skip the comment with a warning
   (parsing XML in shell is not worth it; the upload still happened).
4. **Partition** the failures into muted / auto-flaky / unknown by exact test-name
   match against the quarantine sets.
5. **Render** the markdown comment, leading with the counts, and including the
   hidden marker `<!-- flackyness-report -->` as the first line.
6. **Upsert the comment** with `gh pr comment` / `gh api`: list comments, find one
   containing the marker, edit it if found, otherwise create. Skip entirely when
   `comment: false`, when there is no PR context (e.g. a push to `main`), or when
   there are zero failures **and** no existing comment to update.

**Verify**: the YAML parses (`pnpm dlx yaml --json --single --strict < action.yml`);
`rtk proxy pnpm lint` still exits 0.

### Step 2: Prove the logic against a real API

The action's shell logic must be exercised end-to-end (see Test plan). Extract the
partition + render logic into a small script the action calls
(e.g. `.github/action-scripts/comment.sh`) if that makes it testable — that is
allowed and encouraged, and it keeps `action.yml` readable.

**Verify**: the e2e run in the Test plan produces the expected markdown.

### Step 3: Docs

`docs/GITHUB_ACTION.md`: inputs table; the **`permissions: pull-requests: write`**
requirement (the action cannot comment without it — this is the #1 thing users will
get wrong); a note that the action **never** fails the build and **never** skips
tests, and why; and a complete example workflow. `README.md` gets a few lines
pointing at it.

**Verify**: `rtk proxy pnpm lint` → exit 0.

## Test plan

There is no unit-test harness for a composite action, so verification is a **real
end-to-end run** against a live API. Do all of this and paste the output in your
report:

1. Bring up the disposable Postgres + API. Create a project (admin API) and note its
   token + id. **Mind the 5/min admin rate limit.**
2. Ingest `apps/api/fixtures/real-report.json` a few times so at least one test
   crosses `minRuns: 3` and becomes `active` flaky. Mute one of them via
   `PATCH /api/v1/tests/flaky/:id` so you have **one muted and one auto-flaky** test.
3. Run your action's upload + partition + render logic against a report file that
   contains failures for: the muted test, the auto-flaky test, and a test that is
   neither.
4. Assert the rendered markdown puts all three in the **right buckets**, and that
   the "look at these" section contains **only** the third one.
5. **Failure-mode test (the important one)**: point `api-url` at a dead port and run
   again. The script must print a warning and **exit 0**. Prove it:
   `echo "exit=$?"` → `exit=0`.
6. Confirm the report upload actually landed (`GET /api/v1/projects/:id/runs`).

## Done criteria

- [ ] `action.yml` exists at the repo root and parses as valid YAML
- [ ] E2E: failures partition correctly into muted / auto-flaky / unknown against a real API, with output pasted in the report
- [ ] E2E: with the API unreachable, the action logs a warning and exits **0**
- [ ] The comment body starts with the `<!-- flackyness-report -->` marker and re-running updates the same comment rather than adding a second
- [ ] `docs/GITHUB_ACTION.md` documents inputs, the `pull-requests: write` permission, and the never-fails/never-skips guarantees
- [ ] The example workflow file ends in `.example` and is NOT a live workflow
- [ ] The project token never appears in any log line, `run:` string, or `set -x` output
- [ ] `git status` clean outside scope; **no files under `apps/` modified**
- [ ] `rtk proxy pnpm lint` exits 0

## STOP conditions

- You find yourself wanting the action to skip tests, retry them, or alter the test
  step's exit code. Forbidden by design decision 2 — STOP and report.
- The report parsing needs more than `jq` can reasonably do (deeply irregular
  Playwright output). STOP rather than shipping a parser that quietly mis-partitions
  failures — a wrong "known-flaky" label is worse than no comment.
- You cannot make the action degrade to exit 0 on an unreachable API. That is a
  hard requirement, not a nice-to-have.
- Committing a live workflow under `.github/workflows/` that would run in *this*
  repo. If that seems necessary, STOP.

## Maintenance notes

- **The never-fail guarantee is load-bearing.** Any future change that can make this
  action non-zero-exit on a Flackyness outage will get it deleted from users' repos
  the first time the server hiccups. A reviewer should look for `set -e` interacting
  with the curl steps.
- Test names are matched **exactly** between the report and the quarantine list. A
  renamed test silently drops out of both — same caveat as plan 020's `grepInvert`.
- Deferred: consuming `grepInvert` to auto-retry known-flaky failures. That is a real
  feature, but it needs an explicit opt-in and an expiry policy, and it must never be
  the default. Do not sneak it in here.
- If this action is ever published to the GitHub Marketplace, the `action.yml`
  `branding` block and a tagged `v1` release are prerequisites — out of scope now.
