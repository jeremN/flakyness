# Plan 040: Stop Dependabot's root `/` entry from re-opening the dashboard TypeScript-7 bump

> **Executor instructions**: config-comment change to ONE file (`.github/dependabot.yml`).
> Follow exactly, honor the STOP conditions. Do not touch `plans/README.md` (the reviewer maintains
> it). Do NOT restructure the config, do NOT switch to a `/apps/*` glob, do NOT touch code or the
> other two `updates` entries beyond what Step 1 specifies.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `6663266`. Open
> `.github/dependabot.yml` and confirm the FIRST `npm` `updates` entry has
> `directories: ["/", "/apps/api"]` and an `ignore:` list that contains **only** `@types/node`
> (`version-update:semver-major`) — i.e. it does NOT already ignore `typescript` majors. If entry 1
> already ignores `typescript` majors, this is already done → STOP and report.

## Status
- **Priority**: P3 (low — CI already blocks a bad merge; this stops the noise at the source)
- **Effort**: XS
- **Risk**: LOW — adds one `ignore` rule + a comment to one existing `updates` entry. No code, no new
  dependency, no directory/ecosystem/schedule/group change. Reversible by deleting the added rule.
  **Caveat**: Dependabot behaviour cannot be verified locally (it runs server-side) — see Verification.
- **Category**: DX / tooling (CI hygiene)
- **Planned at**: commit `6663266`, 2026-07-15

## The bug (confirmed diagnosis)
Dependabot PR **#86** proposed bumping **`apps/dashboard`**'s `typescript` from `^6.0.3` to `^7.0.2`
— exactly the bump the dashboard's TS-6 pin exists to prevent (svelte-check 4.x can't run under TS 7;
see the dashboard entry's own comment and `AGENTS.md`). CI's Type Check job went red, proving the pin
matters. #86 has been closed and a persistent `@dependabot ignore this major version` comment posted,
but the config that *opened* it is still live and will keep trying.

**Why it happened (two independent proofs):**

1. **Branch-name provenance.** #86's branch was `dependabot/npm_and_yarn/typescript-7.0.2` — **no
   directory suffix**. Dependabot names a branch for a `directory: "/"` update with no suffix, but a
   scoped directory gets one (historically `dependabot/npm_and_yarn/apps/dashboard/typescript-7.0.2`
   for the old dashboard-scoped PR #62). So #86 came from a **`/` root entry**, i.e. the FIRST `npm`
   entry (`directories: ["/", "/apps/api"]`) — *not* the second, dashboard-scoped entry.
2. **The `/` root fans out across the whole pnpm workspace.** The root `package.json` declares **no**
   `typescript` (only `oxlint`) — verified at `6663266`. So a `/` update touching the dashboard's
   `typescript` can only be the root entry resolving the pnpm workspace and reaching *into*
   `apps/dashboard` (^6 → ^7). This matches Dependabot's own pnpm-workspace guidance: a root `/`
   entry updates dependencies across all workspace members.

**The control that clinches it:** `@types/node` majors are ignored in **both** `npm` entries and have
**never** leaked; `typescript` majors are ignored in **only** the second (dashboard) entry and DID
leak. Same mechanism, opposite outcome — the difference is precisely the missing ignore on entry 1.
The dashboard entry's `typescript`-major ignore is real but **bypassed**, because entry 1's root
fan-out already covers the dashboard and entry 1 has no such ignore.

## The fix (minimal, surgical)
Make entry 1 symmetric with entry 2 for `typescript`, exactly as it already is for `@types/node`:
**add a `typescript` `version-update:semver-major` ignore to the FIRST `npm` entry's `ignore` list.**

Why this is the right fix and not a restructure:
- It plugs the leak **regardless** of the exact pnpm fan-out / dedup semantics (which are murky and
  untestable locally): after this, *no* `npm` entry will ever propose a `typescript` **major**, for
  the root, `apps/api`, `apps/dashboard`, or any future workspace member. Robust to what we can't test.
- It does **not** touch `apps/api`'s ability to receive `typescript` **minor/patch** updates
  (`^7.0.2` → `^7.1.x` still flows — that's the very release we're waiting on for the dashboard pin).
  Only **majors** (7 → 8) become manual — which is already the repo's policy: TS majors are adopted
  deliberately by hand (plan 023 moved `apps/api` to TS 7 manually), never auto-merged.
- It keeps `apps/api` and `apps/dashboard` listed as directories, so plan 038's coverage guard
  (`apps/api/src/dependabot-coverage.test.ts`) keeps passing **unchanged** — no test edit needed.

### Alternatives considered (and why deferred)
- **Collapse to a single root `/` npm entry** (the "recommended pnpm-workspace" shape) carrying both
  `@types/node` and `typescript` major-ignores. Cleaner in principle and would auto-cover future apps
  (dissolving follow-up #6). **Deferred**, because: (a) it restructures the config and would force a
  rewrite of plan 038's coverage guard (which asserts per-app-dir listing); (b) it relies on pnpm
  root-fan-out *lockfile* behaviour that dependabot-core has open bugs around
  (dependabot-core#11135, #10203); and (c) none of that can be validated locally — a restructure you
  can't test is the wrong place to be bold. Revisit only if we want new-app auto-coverage AND can run
  a Dependabot dry-run to confirm the collapsed entry still updates every member. Record this as a
  new/kept open follow-up; do not do it here.
- **Switch entry 1 to a `/apps/*` glob** — explicitly rejected in plan 038; reintroduces the
  dashboard double-PR / defeated-ignore problem. Do not.

## Scope
**In scope — ONE file, `.github/dependabot.yml`:**
1. The FIRST `npm` `updates` entry's `ignore:` list — add the `typescript` semver-major rule.
2. A short comment above/beside that new rule explaining *why entry 1 needs it* (the root `/`
   fan-out), pointing at the dashboard entry for the full TS-7.1/svelte-check rationale so the
   detailed explanation isn't duplicated. Optionally tighten the `directories:` comment (lines ~11–16)
   to mention that `/` fans out across the workspace — a light touch, not required.

**Out of scope (do NOT touch):**
- The second (dashboard) `npm` entry — its `typescript` ignore, comment, and everything else stay
  byte-for-byte. The `github-actions` entry. Any `directories`, `schedule`, `cooldown`,
  `commit-message`, `groups`, `open-pull-requests-limit` value in any entry.
- Any code, any test (the plan-038 guard stays green as-is), `package.json` versions, `AGENTS.md` /
  `.agent/CONTEXT.md` (the TS-pin docs were just sharpened in plan 039 and remain accurate), any
  other file. `git diff --name-only main` MUST be exactly `.github/dependabot.yml`.

## The exact edit
Entry 1's `ignore:` block currently reads (verified at `6663266`):

```yaml
    ignore:
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
```

Change it to (add the second rule + a brief comment; keep the `@types/node` rule and its existing
comment above the block unchanged):

```yaml
    ignore:
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
      # TypeScript majors are ignored HERE too, not just in the apps/dashboard
      # entry below. This entry's "/" root fans out across the whole pnpm
      # workspace — including apps/dashboard — so without this rule, "/" re-opens
      # the dashboard's TS 6->7 bump that the dashboard entry's ignore is meant
      # to block (exactly what happened in PR #86). apps/api's TS major is
      # adopted manually anyway (see plan 023 / AGENTS.md). See the apps/dashboard
      # entry below for the full TS 7.1 / svelte-check rationale and recheck trigger.
      - dependency-name: "typescript"
        update-types: ["version-update:semver-major"]
```

Match the file's existing 2-space YAML indentation and `#`-comment style. Do not reflow or reorder
the `@types/node` rule.

## Steps
1. Make the edit above in `.github/dependabot.yml` (entry 1 only).
2. **Validate the YAML parses and the structure is intact.** Use a parser, not eyeballing:
   `python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/dependabot.yml')); e=d['updates'][0]; print('entry0 dirs:', e['directories']); print('entry0 ignores:', [i['dependency-name'] for i in e['ignore']]); print('entry1 dirs:', d['updates'][1]['directories']); print('entry1 ignores:', [i['dependency-name'] for i in d['updates'][1]['ignore']])"`
   Expect: `entry0 dirs: ['/', '/apps/api']`, `entry0 ignores: ['@types/node', 'typescript']`,
   `entry1 dirs: ['/apps/dashboard']`, `entry1 ignores: ['@types/node', 'typescript']`. (If `pyyaml`
   isn't importable, any YAML validator or `node -e` with a yaml lib is fine — the point is a real
   parse, and that entry 0 now lists both `@types/node` and `typescript` while entry 1 is unchanged.)
3. **Confirm the plan-038 guard still passes** (dirs are unchanged, so it must):
   `rtk proxy pnpm --filter api exec vitest run dependabot-coverage.test.ts` → green, not skipped.
4. **Confirm scope**: `git diff --name-only main` = exactly `.github/dependabot.yml`. `git diff main --
   .github/dependabot.yml` shows only the added `typescript` ignore rule + its comment (and, if you
   did the optional touch, the `directories` comment) — no `-`/`+` on any other key or on entry 2.
5. Sanity gate (a config PR exercises little, but run it): `rtk proxy pnpm lint` → 0.

## Done criteria
- [ ] Entry 1 (`directories: ["/", "/apps/api"]`) now ignores BOTH `@types/node` and `typescript`
      `version-update:semver-major`; entry 2 (dashboard) is byte-for-byte unchanged.
- [ ] YAML parses; the Step-2 parser output matches exactly.
- [ ] `dependabot-coverage.test.ts` passes unchanged (not skipped); no test file was modified.
- [ ] `git diff --name-only main` = `.github/dependabot.yml` only; `pnpm lint` exit 0.

## Verification limits (READ THIS)
This changes Dependabot's server-side behaviour, which **cannot be exercised locally** — there is no
unit test that proves Dependabot will now skip the dashboard TS-major PR. The local gates above only
prove the config is well-formed and in-scope. Real confirmation comes from:
- The **next weekly Dependabot run** (Mondays) NOT re-opening a `typescript` 6→7 PR for the dashboard;
  and/or a maintainer manually triggering "Check for updates" in the repo's Dependabot dependency
  graph and confirming no such PR appears.
- Belt-and-suspenders: the `@dependabot ignore this major version` comment already posted on #86 adds
  `typescript@7` to Dependabot's persistent ignore list independently of this config change, so the
  specific 6→7 PR won't return even before this lands. This plan removes the *root cause* so the
  ignore-list hack isn't the only thing holding the line, and so a future `typescript@8` doesn't leak
  the same way.

State both facts plainly in the PR description; do not claim the fix is "verified" — claim the config
is corrected and explain how it will be confirmed.

## STOP conditions
- Entry 1 already ignores `typescript` majors → already done; STOP and report.
- Applying the edit seems to require touching entry 2, a directory list, or any code → you've drifted;
  STOP. The fix is a single added `ignore` rule (+comment) in entry 1.
- The plan-038 guard FAILS after your edit → you changed a directory list you shouldn't have; STOP and
  revert.
- You're tempted to collapse the two entries into one root `/` entry, or to switch to a `/apps/*`
  glob → don't (see "Alternatives considered"); STOP.

## Maintenance notes
- When TS 7.1 ships and svelte-check supports it (dashboard follow-up #7 / plan 039), the dashboard
  pin lifts. At that point the `typescript`-major ignores in BOTH entries can be removed together (or
  the config collapsed to a single root entry — the deferred Option A). Until then, both must stay.
- The "collapse to a single root `/` npm entry" idea (auto-covers new apps, dissolves follow-up #6)
  remains a valid future direction but needs a Dependabot dry-run to de-risk; keep it as an open
  follow-up, not a silent TODO.
