# Plan 038: Make the Dependabot per-app coverage gap loud (a guard test), not silent

> **Executor instructions**: follow the plan, run every verification, honor the STOP conditions.
> Do not update `plans/README.md` — the reviewer maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `38544ef`. Confirm
> `.github/dependabot.yml` lists npm `directories` explicitly (`"/"`, `"/apps/api"` in the first
> `npm` entry; `"/apps/dashboard"` in the second) and does NOT use a `/apps/*` glob. If it already
> globs or already has a coverage test, STOP.

## Status
- **Priority**: P3 (low — closes open follow-up #6)
- **Effort**: S
- **Risk**: LOW — adds one test + a comment line; no runtime code, no new dependency, no config
  behavior change.
- **Category**: DX / tooling (fail-loud guard)
- **Planned at**: commit `38544ef`, 2026-07-15

## The gap (follow-up #6)
`.github/dependabot.yml` deliberately lists each npm package directory **explicitly** rather than
using a `/apps/*` glob. This is a *correct* decision, not a bug: Dependabot's `ignore` rules are
per-`updates`-entry, and `apps/dashboard` needs an extra `typescript`-major ignore (the TS 6 pin —
svelte-check 4.x crashes under TS 7) that the root/api entry must NOT inherit. A `/apps/*` glob in
the first entry would overlap the dashboard entry, double-open its PRs, and defeat that ignore.

The **cost** of listing explicitly is stated in the config's own comment: a NEW workspace package
(e.g. a third app under `apps/`, or a real `packages/*` package) "must be added to this list by
hand, or it silently gets no dependency updates." That silent-by-default failure mode is the
follow-up: adding an app and forgetting Dependabot leaves its dependencies unwatched with no signal.

**Do NOT "fix" this by switching to a glob** — that reintroduces the dashboard double-PR / defeated-
ignore problem the explicit list exists to avoid. The fix is to make the gap **loud**: a test that
fails CI when a workspace package directory isn't covered by `.github/dependabot.yml`. This matches
the repo's existing fail-loud static-scan guard precedent
(`apps/dashboard/src/lib/components/chart-registration.test.ts`, and the `.github/`-reaching
`apps/api/src/action-partition.test.ts`).

## Current facts (verified at `38544ef`)
- Workspace globs (`pnpm-workspace.yaml`): `apps/*`, `packages/*`.
- Real npm packages on disk: `apps/api`, `apps/dashboard`, and root `/`. `packages/shared/` exists
  but has **no `package.json`** (only stale `dist/` + `node_modules/`), so it is not an npm package
  and Dependabot correctly doesn't list it.
- `.github/dependabot.yml` npm `directories`: `"/"`, `"/apps/api"` (entry 1) and `"/apps/dashboard"`
  (entry 2). So current coverage is complete — the guard must PASS on the current tree.
- `apps/api` has vitest; tests at `apps/api/src/*.test.ts` run in the CI "Tests" job and — like
  `action-partition.test.ts` — do NOT self-skip without a DB (this test touches only the filesystem).
- No YAML parser dependency is available in `apps/api`, and none is needed (see below).

## The fix: a filesystem-scanning coverage guard

Add `apps/api/src/dependabot-coverage.test.ts` that:
1. Resolves the repo root from `import.meta.dirname` (`apps/api/src` → `../../..`), mirroring
   `action-partition.test.ts`'s `path.resolve(import.meta.dirname, '../../../.github/...')`.
2. Reads `.github/dependabot.yml` as **text** (no YAML parse — a substring check on the quoted
   directory token is enough and dependency-free; the config quotes every path as `- "/apps/api"`).
3. Enumerates every workspace package directory that actually has a `package.json` on disk: scan the
   immediate children of `apps/` and `packages/` (both exist; guard each with `existsSync`), keeping
   only child dirs containing a `package.json`. Produce paths like `/apps/api`, `/packages/foo`.
4. For each such path, assert the **quoted** token appears in the dependabot text, e.g.
   `expect(dependabotText).toContain('"' + dir + '"')`. Use the quoted form (not a bare substring)
   so `/apps/api` cannot spuriously match inside `/apps/apiv2`.
5. Also assert root `/` is covered (`expect(dependabotText).toContain('"/"')`) — trivially true
   today, but it belongs in the invariant.
6. A short header comment explaining: this is a **static scan**, not a Dependabot-behavior test — it
   catches the common "added a package, forgot to list it in dependabot.yml" case; it deliberately
   does not verify ecosystem/schedule/ignore correctness of each entry. Reference follow-up #6.

Prefer a table-driven `it.each(packageDirs)('… covers <dir>')` so a miss names the offending
directory. If `packageDirs` is empty (should never happen — api/dashboard always exist), fail
loudly rather than passing vacuously.

Then update the comment in `.github/dependabot.yml`'s first npm entry: change the trailing
"…must be added to this list by hand, or it silently gets no dependency updates." to note the
guard now enforces it (e.g. "…must be added to this list by hand — enforced by
`apps/api/src/dependabot-coverage.test.ts`, which fails CI if a workspace package dir is missing").
Change ONLY that comment; do not touch any actual config key/value.

## Scope
**In scope:**
- `apps/api/src/dependabot-coverage.test.ts` (new).
- `.github/dependabot.yml` — the one comment sentence only.

**Out of scope (do NOT touch):**
- The dependabot `directories` lists, ecosystems, `ignore`/`groups`/`cooldown`/schedule — no
  behavior change. Do NOT switch to a `/apps/*` glob.
- Any runtime source, `pnpm-workspace.yaml`, `packages/shared`, adding a `package.json` anywhere.
- Any new dependency (no `yaml`/`js-yaml`; text scan only).

## Steps
1. Write the test. **Verify** it PASSES on the current tree (coverage is complete today):
   `rtk proxy pnpm --filter api exec vitest run dependabot-coverage.test.ts` → green, not skipped.
2. **Prove it bites** (the whole point of #6): create a throwaway `apps/_bite_app/package.json`
   (any minimal `{ "name": "_bite_app", "private": true }`), rerun the test, confirm it FAILS
   naming `/apps/_bite_app` as uncovered, then delete the throwaway dir. (Alternatively: temporarily
   remove `- "/apps/dashboard"` from dependabot.yml, confirm fail, restore.) Paste what you saw, and
   confirm the throwaway/edit is fully reverted (`git status` clean except the two in-scope files).
3. Update the dependabot.yml comment.
4. **Full gate**: `rtk proxy pnpm --filter api exec tsc --noEmit` → 0; `rtk proxy pnpm lint` → 0;
   full API suite green (the new test runs without a DB — prove it's not skipped);
   `git diff --name-only main` = exactly `apps/api/src/dependabot-coverage.test.ts` and
   `.github/dependabot.yml`.

## Done criteria
- [ ] `dependabot-coverage.test.ts` scans on-disk `apps/*` + `packages/*` package dirs and asserts
      each (quoted) + root `/` appears in `.github/dependabot.yml`; passes on the current tree.
- [ ] Shown to **fail** for an uncovered package dir (bite-proof pasted); throwaway reverted.
- [ ] dependabot.yml comment updated to reference the guard; no config key/value changed.
- [ ] tsc 0, lint 0, full API suite green (test not skipped); scope = the two in-scope files only.

## STOP conditions
- The guard FAILS on the current tree (before any bite) → there's a real uncovered package now;
  STOP and report which dir (do not silently add it to dependabot without flagging — it may be
  intentional, like a package with no deps).
- Making it pass seems to require a YAML parser or a new dependency → it does not; a quoted-token
  text scan suffices. STOP if you think otherwise.
- You're tempted to switch dependabot to a `/apps/*` glob → don't; that reintroduces the dashboard
  double-PR/defeated-ignore problem. STOP.

## Maintenance notes
- When a real `packages/*` package or a third app is added, this test fails until it's listed in
  `.github/dependabot.yml` — decide at that point which `updates` entry it belongs to (root/api-style
  vs. the dashboard's extra-ignore style).
- This is a static scan; it cannot verify each entry's ecosystem/ignore correctness — only presence.
  If the TS 6 pin is ever lifted (dashboard follow-up #7), the dashboard entry can fold back into the
  first, and this guard keeps passing as long as `/apps/dashboard` is still listed somewhere.
