# Plan 010: Pin GitHub Actions to commit SHAs (and add build provenance)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- .github/workflows/`
> Plan 002 changes the docker jobs' `context:`/`file:` settings — that is
> expected, not drift. New/removed `uses:` lines beyond the inventory below
> ARE drift: re-inventory with the Step 1 grep before proceeding.

## Status

- **Priority**: P3
- **Effort**: S–M (mechanical)
- **Risk**: LOW
- **Depends on**: none (coordinate with plan 002 — land 002 first to avoid
  merge churn in the same files)
- **Category**: security
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

Every workflow references actions by mutable tag (`@v6`, `@v7`, …). A
compromised action maintainer can repoint a tag at malicious code; in
`docker-publish.yml` that code runs in a job holding `packages: write` and a
GHCR login — i.e. it could publish tampered images. Pinning to full commit
SHAs makes the supply chain content-addressed; Dependabot (already configured
for `github-actions` in `.github/dependabot.yml`) keeps SHA pins updated with
readable version comments. While in the publish workflow, enable provenance
attestations on the pushed images.

## Current state

Action references at `0f8b0cc` (re-inventory with
`grep -rn "uses:" .github/workflows/`):

- `.github/workflows/ci.yml` — `actions/checkout@v6` (×5, one per job),
  `pnpm/action-setup@v6` (×4), `actions/setup-node@v6` (×4),
  `docker/setup-buildx-action@v3` (×1), `docker/build-push-action@v7` (×2).
- `.github/workflows/docker-publish.yml` — `actions/checkout@v6`,
  `docker/setup-buildx-action@v3`, `docker/login-action@v4`,
  `docker/build-push-action@v7` (×2). Job has
  `permissions: contents: read / packages: write`.
- `.github/workflows/dependabot-lockfile.yml` — `actions/checkout@v4`
  (NOTE: older major than ci.yml's v6), `pnpm/action-setup@v6`,
  `actions/setup-node@v4` (older major).
- `.github/dependabot.yml` — already has
  `package-ecosystem: "github-actions"` with weekly schedule and
  `commit-message.prefix: "chore(ci)"` — SHA pins will be maintained
  automatically; no dependabot.yml change needed.
- `docker-publish.yml` build-push steps have no `provenance` key.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Inventory | `grep -rn "uses:" .github/workflows/` | matches the list above |
| Resolve a tag to a SHA | `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` | 40-char SHA |
| YAML sanity | `node -e "['ci','docker-publish','dependabot-lockfile'].forEach(f=>{require('js-yaml')})"` — js-yaml may be absent; use the simpler gate below | — |
| Simple YAML gate | `npx --yes yaml-lint .github/workflows/*.yml` (or `python3 -c "import yaml,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"`) | exit 0 |

If `gh` is unauthenticated, `gh api` still works for public repos
(actions/checkout etc. are public). If it fails entirely, STOP — do not
copy SHAs from memory or third-party sites.

## Scope

**In scope** (the only files you should modify):
- `.github/workflows/ci.yml`
- `.github/workflows/docker-publish.yml`
- `.github/workflows/dependabot-lockfile.yml`

**Out of scope** (do NOT touch):
- `.github/dependabot.yml` (already correct).
- Workflow logic, job structure, permissions, triggers — ONLY the `uses:`
  refs, plus the `provenance` addition in Step 3 and the version alignment in
  Step 4.

## Git workflow

- Branch: `advisor/010-pin-github-actions`
- Conventional-commit, single-line subject only (e.g.
  `ci: pin actions to commit SHAs`). Do NOT add any `Co-Authored-By`
  trailer. Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Inventory and resolve

Run `grep -rn "uses:" .github/workflows/` and list every unique
`owner/repo@tag`. For each, resolve the tag to its full commit SHA:

```bash
gh api repos/actions/checkout/commits/v6 --jq .sha
gh api repos/pnpm/action-setup/commits/v6 --jq .sha
gh api repos/actions/setup-node/commits/v6 --jq .sha
gh api repos/docker/setup-buildx-action/commits/v3 --jq .sha
gh api repos/docker/build-push-action/commits/v7 --jq .sha
gh api repos/docker/login-action/commits/v4 --jq .sha
```

Record each pair in your report.

**Verify**: every command returns a 40-hex-char SHA.

### Step 2: Replace tags with SHAs

For every `uses:` line in the three workflows, rewrite:

```yaml
- uses: actions/checkout@v6
```

to

```yaml
- uses: actions/checkout@<full-sha>  # v6
```

Keep the ` # vN` comment — Dependabot uses it to display versions and will
maintain both the SHA and the comment.

**Verify**: `grep -rEn "uses: [^ ]+@v[0-9]" .github/workflows/` → no matches (every ref is now a SHA; the `# vN` appears only in comments).

### Step 3: Enable provenance on published images

In `docker-publish.yml`, add to BOTH `docker/build-push-action` steps'
`with:` blocks:

```yaml
          provenance: true
```

**Verify**: `grep -c "provenance: true" .github/workflows/docker-publish.yml` → `2`.

### Step 4: Align the lagging majors in `dependabot-lockfile.yml`

That workflow uses `actions/checkout@v4` and `actions/setup-node@v4` while
ci.yml uses v6 of both. Pin them to the SAME v6 SHAs used in Step 2 (behavior
of checkout/setup-node across these majors is compatible with the existing
inputs: `ref`, `token`, `node-version`, `cache`).

**Verify**: `grep -n "checkout@\|setup-node@" .github/workflows/dependabot-lockfile.yml` → both lines show the v6 SHAs with `# v6` comments.

### Step 5: Validate and exercise

- YAML gate: `python3 -c "import yaml,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]; print('ok')"` → `ok`.
- If the operator allows pushing a branch: push and confirm the CI workflow
  runs green with the pinned SHAs (the real gate). Otherwise state that CI
  execution is pending push.

**Verify**: as above.

## Test plan

No unit tests. Gates: the greps in Steps 2–4, YAML parse, and a green CI run
once pushed.

## Done criteria

ALL must hold:

- [ ] `grep -rEn "uses: [^ ]+@v[0-9]" .github/workflows/` → no matches
- [ ] Every pinned line carries a trailing `# vN` comment
- [ ] `provenance: true` present twice in docker-publish.yml
- [ ] dependabot-lockfile.yml uses the same checkout/setup-node SHAs as ci.yml
- [ ] YAML parse gate passes
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `gh api` cannot resolve any tag (no network / rate limit) — never
  substitute a SHA from memory.
- A workflow uses an action not in the Step 1 inventory (drift) — re-inventory
  and extend the same treatment, but report the delta.
- After pushing, CI fails on a pinned action with an error suggesting the SHA
  doesn't match the tag's behavior (wrong SHA resolved) — report the action
  and SHA rather than bisecting majors.

## Maintenance notes

- Dependabot's weekly `github-actions` updates will now bump SHAs — those PRs
  are the intended maintenance path; reviewers should check the `# vN`
  comment matches the PR title.
- If plan 002 lands after this one, its context/file edits to the docker jobs
  will conflict trivially in the same files — rebase keeps both.
- Deferred: egress restriction for workflow jobs (e.g. step-security/harden-runner) — meaningful but adds a new third-party action; maintainer's call.
