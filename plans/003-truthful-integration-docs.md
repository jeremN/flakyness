# Plan 003: Make the integration docs match the API (GitLab example, API.md, stale agent docs)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- .gitlab-ci.yml.example docs/API.md README.md .agent/CONTEXT.md IMPLEMENTATION_PLAN.md apps/api/src/routes/`
> If `apps/api/src/routes/*` changed, re-read the live route code before
> documenting it (documenting stale routes is this plan's failure mode). If
> the docs files changed, compare against the excerpts before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (docs only — no code changes)
- **Depends on**: none to edit; plan 001 to verify the upload example end-to-end (see Step 6)
- **Category**: docs
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

The docs are the integration contract, and they are actively wrong:

1. `.gitlab-ci.yml.example` — the one documented CI onboarding path — sends
   `branch`/`commit`/`pipeline` with curl `--data-urlencode`, which appends
   them to the request **body** (corrupting the JSON) instead of the query
   string. The required `commit` query param never arrives, so the API
   returns 400 — and the example swallows it with `|| echo "Warning..."`.
2. `docs/API.md` documents a `project` query param the reports route does not
   read (the project comes from the Bearer token), marks `branch` required
   (it defaults to `main`), and documents a response shape
   (`runId`, `testsProcessed`, `flakyDetected`) the API does not return.
3. Four live endpoints are undocumented: `GET /projects/:id/analysis`,
   `GET /projects/:id/trend`, `GET /tests/flaky/:id`, `GET /projects/:id`.
4. `.agent/CONTEXT.md` references three "Key Brain Artifacts" files that do
   not exist anywhere in the repo, and `IMPLEMENTATION_PLAN.md` carries 172
   unchecked `[ ]` boxes while CONTEXT.md declares the project
   "Production-ready (Phase 6 complete)" — two contradicting sources of truth.

## Current state

Ground truth — the actual route contract (verified at `0f8b0cc`):

`apps/api/src/routes/reports.ts:20-24` — query schema (body is the raw
Playwright JSON; the project is derived from the Bearer token by
`projectAuth`, `reports.ts:27`):

```ts
const reportQuerySchema = z.object({
  branch: z.string().min(1).default('main'),   // OPTIONAL, defaults to "main"
  commit: z.string().min(1).max(40),           // REQUIRED
  pipeline: z.string().optional(),             // OPTIONAL
});
```

`apps/api/src/routes/reports.ts:119-135` — the actual 201 response:

```ts
return c.json({
  success: true,
  testRun: {
    id: testRun.id,
    project: project.name,
    branch, commit, pipeline,
    summary: { total, passed, failed, flaky, skipped },
  },
}, 201);
```

Undocumented live routes (all in `apps/api/src/routes/`):

- `GET /api/v1/projects/:id/analysis?days=&threshold=` (`projects.ts:157-180`)
  — real-time flakiness analysis; `days` clamped to [1,90] default 14,
  `threshold` clamped to [0,1] default 0.05; returns
  `{ windowDays, threshold, flakyTests: [...], allTests: [...] }`.
- `GET /api/v1/projects/:id/trend?days=` (`projects.ts:187-243`) — daily flake
  rate; `days` clamped [1,90] default 7; returns `{ days: string[], rates: number[] }`.
- `GET /api/v1/tests/flaky/:id` (`tests.ts:100-117`) — one flaky-test row by
  UUID; returns `{ flakyTest }`, 404 if absent.
- `GET /api/v1/projects/:id` (`projects.ts:39-52`) — currently identical to
  `/stats`. **Do NOT document it**: plan 005 removes it. If plans/README.md
  marks plan 005 REJECTED, document it instead.

The broken example, `.gitlab-ci.yml.example:32-40`:

```yaml
        curl -X POST "${FLACKYNESS_API}/api/v1/reports" \
          -H "Authorization: Bearer ${FLACKYNESS_TOKEN}" \
          -H "Content-Type: application/json" \
          -d @playwright-results.json \
          --data-urlencode "project=${CI_PROJECT_NAME}" \
          --data-urlencode "branch=${CI_COMMIT_REF_NAME}" \
          --data-urlencode "commit=${CI_COMMIT_SHA}" \
          --data-urlencode "pipeline=${CI_PIPELINE_ID}" \
          --fail-with-body || echo "Warning: Failed to upload results"
```

(curl concatenates every `-d`/`--data-urlencode` into one body; there is no
`project` query param in the API at all.)

The wrong API.md section is `docs/API.md:159-192` ("Upload Playwright
Report"): a query-param table listing `project` (Required) and `branch`
(Required), and the response block with `runId`/`testsProcessed`/
`flakyDetected`. The curl example at `docs/API.md:404-419` repeats the
`project=` mistake. `README.md:130-152` has a GitLab snippet that is
structurally correct (params in the URL) — keep it consistent with whatever
you write in the example file.

Stale agent docs:

- `.agent/CONTEXT.md:535-538` — "Key Brain Artifacts" table listing
  `code_review.md`, `phase6_plan.md`, `walkthrough.md`; none exist in the repo.
- `IMPLEMENTATION_PLAN.md` — 19KB phase plan, 172 unchecked `- [ ]` boxes
  (`grep -c "\- \[ \]" IMPLEMENTATION_PLAN.md` → 172), contradicting
  CONTEXT.md line 6 ("Production-ready (Phase 6 complete)").

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Confirm route ground truth | `grep -n "reportQuerySchema" -A 5 apps/api/src/routes/reports.ts` | matches the excerpt above |
| Grep gates in Done criteria | see below | as stated |
| (Optional, Step 6) run API locally | `docker compose up -d && pnpm db:migrate && pnpm --filter api dev` | API on :8080 |

## Scope

**In scope** (the only files you should modify):
- `.gitlab-ci.yml.example`
- `docs/API.md`
- `README.md` (ONLY the GitLab CI snippet + API quick-reference table, if inconsistent)
- `.agent/CONTEXT.md` (ONLY the dead references and the items named in Step 4)
- `IMPLEMENTATION_PLAN.md` (ONLY the banner in Step 5)

**Out of scope** (do NOT touch):
- Any file under `apps/` — this is a docs-only plan. If the docs and code
  disagree in a way not described above, that's a STOP, not a code fix.
- `docs/GETTING_STARTED.md` unless it repeats the `project=` mistake
  (check: `grep -n "project=" docs/GETTING_STARTED.md`; fix only that if found).

## Git workflow

- Branch: `advisor/003-truthful-integration-docs`
- Conventional-commit, single-line subject only (e.g.
  `docs: fix report-upload contract in API.md and CI example`). Do NOT add
  any `Co-Authored-By` trailer. Do not push or open a PR unless the operator
  instructed it.

## Steps

### Step 1: Fix the upload command in `.gitlab-ci.yml.example`

Replace the curl block (lines 29–43) with query params on the URL. Use
curl's `--url-query` (available since curl 7.87; the
`mcr.microsoft.com/playwright` images ship newer curl), which URL-encodes and
appends to the query string for any method:

```yaml
  after_script:
    # Upload results to Flackyness (runs even if tests fail)
    - |
      if [ -f playwright-results.json ]; then
        echo "Uploading test results to Flackyness..."
        curl -X POST "${FLACKYNESS_API}/api/v1/reports" \
          --url-query "branch=${CI_COMMIT_REF_NAME}" \
          --url-query "commit=${CI_COMMIT_SHA}" \
          --url-query "pipeline=${CI_PIPELINE_ID}" \
          -H "Authorization: Bearer ${FLACKYNESS_TOKEN}" \
          -H "Content-Type: application/json" \
          -d @playwright-results.json \
          --fail-with-body || echo "Warning: Failed to upload results"
      fi
```

Notes: `project=` is dropped entirely (the API derives the project from the
token). Keep the surrounding job definition unchanged.

**Verify**: `grep -c "url-query" .gitlab-ci.yml.example` → `3`; `grep -c "data-urlencode" .gitlab-ci.yml.example` → `0`.

### Step 2: Correct `docs/API.md` "Upload Playwright Report"

In the section at lines 159–192:

- Query-param table → exactly three rows: `branch` (string, No, "Git branch
  name; defaults to `main`"), `commit` (string, Yes, "Git commit SHA, max 40
  chars"), `pipeline` (string, No, "CI pipeline ID"). Remove `project` and add
  a sentence: "The target project is identified by the Bearer token — there is
  no `project` parameter."
- Response block → the real shape (copy from the excerpt in "Current state",
  with example values), status 201.
- Fix the curl example at lines ~404–419 the same way as Step 1 (drop
  `project=`, params via `--url-query` or directly in the URL).

**Verify**: `grep -n "runId\|testsProcessed\|flakyDetected" docs/API.md` → no matches; `grep -cn "project=" docs/API.md` → `0`.

### Step 3: Document the missing endpoints in `docs/API.md`

Add sections (match the file's existing endpoint-doc format — heading, method
+ path, param table, example response):

1. `GET /api/v1/projects/:id/analysis` — params `days` (1–90, default 14),
   `threshold` (0–1, default 0.05); response
   `{ windowDays, threshold, flakyTests: [...], allTests: [...] }` where each
   entry is `{ testName, testFile, totalRuns, passCount, failCount, flakyCount, flakeRate, isFlaky, lastSeen }`.
2. `GET /api/v1/projects/:id/trend` — param `days` (1–90, default 7);
   response `{ "days": ["Jul 4", ...], "rates": [1.2, ...] }` (rates are
   percentages).
3. `GET /api/v1/tests/flaky/:id` — flaky-test row by UUID; 404 when absent;
   response `{ "flakyTest": { id, projectId, testName, testFile, firstDetected, lastSeen, flakeCount, totalRuns, flakeRate, status } }`.

Also update the quick-reference endpoint table in `README.md` (lines ~163–171)
if it omits these routes — add `/analysis` and `/trend` rows.

**Verify**: `grep -c "analysis\|trend" docs/API.md` → ≥ 4.

### Step 4: Remove dead references in `.agent/CONTEXT.md`

- Delete the "Key Brain Artifacts" list (lines ~535–538) or replace it with a
  single line: "Historical review artifacts lived outside the repo and are no
  longer available."
- In the same file, do NOT restructure anything else. (Its Known Issues list
  is otherwise accurate and other plans update their own entries.)

**Verify**: `grep -n "code_review.md\|phase6_plan.md\|walkthrough.md" .agent/CONTEXT.md` → no matches.

### Step 5: Mark `IMPLEMENTATION_PLAN.md` as historical

Insert at the very top of the file (before the first heading):

```markdown
> **Status note (2026-07-10):** This is the original build plan, kept for
> history. It is NOT the current roadmap and its checkboxes are not
> maintained. Current status and open items live in `.agent/CONTEXT.md`
> (see "Known Issues & TODOs") and `plans/README.md`.
```

Do not edit the 172 checkboxes themselves.

**Verify**: `head -5 IMPLEMENTATION_PLAN.md | grep -c "Status note"` → `1`.

### Step 6 (conditional): End-to-end check of the example

Only if plan 001 is DONE in `plans/README.md` AND a local Docker/Postgres is
available: start the stack (`docker compose up -d`, `pnpm db:migrate`,
`pnpm --filter api dev`), create a project via the admin API
(README "Admin API"), then run the Step 1 curl against
`http://localhost:8080` with `apps/api/fixtures/real-report.json` as the body
and dummy `branch`/`commit` values. Expect HTTP 201 with
`"testRun"` in the response. If plan 001 is not done, skip this step and note
"E2E deferred pending plan 001" in your report.

**Verify**: HTTP 201 + response contains `"testRun"` — or the documented skip note.

## Test plan

No code tests. The grep gates in each step + Done criteria are the machine
checks; Step 6 is the optional end-to-end validation.

## Done criteria

ALL must hold:

- [ ] `grep -rn "data-urlencode" .gitlab-ci.yml.example docs/ README.md` → no matches
- [ ] `grep -rn "project=" .gitlab-ci.yml.example docs/API.md` → no matches
- [ ] `grep -n "runId\|testsProcessed" docs/API.md` → no matches
- [ ] `docs/API.md` documents `/analysis`, `/trend`, and `/tests/flaky/:id`
- [ ] `grep -n "phase6_plan" .agent/CONTEXT.md` → no matches
- [ ] `IMPLEMENTATION_PLAN.md` starts with the historical status note
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The live route code no longer matches the "ground truth" excerpts (params
  or response shape changed since `0f8b0cc`) — re-documenting requires
  re-reading; report what changed first.
- You find additional endpoints in `apps/api/src/index.ts` route mounts that
  are neither documented nor listed here.
- Step 6 returns anything other than 201 (with plan 001 done) — that's a code
  bug to report, not a doc to fudge.

## Maintenance notes

- Any change to `reportQuerySchema` or the reports response must update
  `docs/API.md` + `.gitlab-ci.yml.example` + README in the same PR — a
  reviewer checklist item.
- Plan 005 removes `GET /projects/:id`; its executor must NOT re-add docs for
  it. Plan 005 also adds a `limit` param to `/flaky-tests` — its plan updates
  API.md for that itself.
- Deferred: `docs/GETTING_STARTED.md` full review (only the `project=` grep
  was in scope here).
