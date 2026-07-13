# Plan 023: Adopt TypeScript 7 in the API, fence the dashboard off until svelte-check catches up

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 74468af..HEAD -- apps/api/package.json apps/dashboard/package.json tsconfig.json .github/dependabot.yml AGENTS.md .agent/CONTEXT.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW–MED (toolchain change; the safety net is that CI already
  *proved* the API half works — see below)
- **Depends on**: none
- **Category**: dependencies / migration
- **Planned at**: commit `74468af`, 2026-07-13

## Why this matters

Dependabot has opened three PRs bumping TypeScript 6.0.3 → 7.0.2 (#60, #61,
#62). They cannot simply be merged, and they cannot simply be ignored either —
left alone, Dependabot will re-propose them every Monday forever.

The interesting part is that **the three PRs disagree with each other**, and that
disagreement is the whole finding:

| PR | Scope | CI result |
|---|---|---|
| #61 | `apps/api` **only** | ✅ **every check passes** — tsc, tests, build, Docker build |
| #62 | `apps/dashboard` only | ❌ `Type Check` **crashes** |
| #60 | api **and** dashboard | ❌ `Type Check` crashes (the dashboard drags it down) |

So the API is TypeScript-7-ready *today* — CI has already proven it. Only the
dashboard is blocked, and it's blocked by an upstream bug we cannot fix here.
This plan takes the half that works and puts a documented fence around the half
that doesn't.

## Current state

### The real blocker is svelte-check, NOT our tsconfig

**This corrects a claim in `AGENTS.md` and `.agent/CONTEXT.md`.** Both currently
say, in effect: *"TS 6 bridge: root tsconfig sets `ignoreDeprecations: "6.0"`;
migrate the deprecated options before any TS 7 upgrade."* That is **not what
breaks**. PR #61 typechecks the API clean under TS 7 with `ignoreDeprecations`
still in place.

What actually happens is that `svelte-check` crashes on startup. Verbatim from
PR #62's CI log:

```
$ svelte-kit sync && svelte-check --tsconfig ./tsconfig.json
node_modules/.pnpm/svelte-check@4.7.2_…_typescript@7.0.2/node_modules/svelte-check/dist/src/index.js:9013
    constructor(useCaseSensitiveFileNames = typescript_1$r.default.sys.useCaseSensitiveFileNames) {
                                                                       ^
TypeError: Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')
    at new FileMap (…/svelte-check/dist/src/index.js:9013:72)
    at new ConfigLoader (…/svelte-check/dist/src/index.js:34078:28)
```

TypeScript 7 is the native (Go) rewrite; it no longer exposes the CommonJS
default-export shape (`ts.default.sys`) that svelte-check 4.7.2 reaches into.
svelte-check's own peer range is `typescript: ">=5.0.0"`, which is simply wrong —
pnpm therefore installs TS 7 without complaint and the tool explodes at runtime.

**We cannot fix this in this repo.** It is svelte-check's bug. The only lever we
have is which TypeScript version the dashboard resolves.

### Manifests today

`apps/api/package.json` — devDependencies (abridged):
```json
    "typescript": "^6.0.3",
```

`apps/dashboard/package.json` — devDependencies (abridged):
```json
    "svelte-check": "^4.7.2",
    "typescript": "^6.0.3",
```

The **root** `package.json` has NO typescript at all — its only devDependency is
`oxlint`. (This is why PR #60, despite its root-looking title, actually edits both
app manifests.)

`apps/dashboard/package.json` scripts:
```json
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
```

### Which tsconfig affects what (load-bearing — read carefully)

- `apps/api/tsconfig.json` **extends `../../tsconfig.json`** (the root one, which
  holds `ignoreDeprecations: "6.0"`). So the root tsconfig governs the API.
- `apps/dashboard/tsconfig.json` **extends `./.svelte-kit/tsconfig.json`** — NOT
  the root. The root tsconfig's `ignoreDeprecations` does not affect the dashboard
  at all.

Root `tsconfig.json` as it exists today:
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    // TS 6.0 errors on options slated for removal in 7.0 (e.g. baseUrl injected
    // by tsup's d.ts builder). Acknowledge until those are migrated out.
    "ignoreDeprecations": "6.0",
    …
  }
}
```

### Dependabot config, and why a naive `ignore` won't work

`.github/dependabot.yml` currently has ONE npm entry covering both apps:

```yaml
  - package-ecosystem: "npm"
    directories:
      - "/"
      - "/apps/*"
    …
    ignore:
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
```

**Dependabot `ignore` rules apply to the whole `updates` entry — they cannot be
scoped to one directory inside it.** So adding `typescript` to that ignore list
would also freeze the API at TS 6, which is exactly what we don't want. The entry
must be **split**: one for `/` + `/apps/api` (no TS ignore), one for
`/apps/dashboard` (TS majors ignored). Note the existing `@types/node` ignore must
be preserved in **both** new entries.

## Design decisions (advisor — do not relitigate)

1. **Split TypeScript versions across the workspace**: `apps/api` → `^7.0.2`,
   `apps/dashboard` stays `^6.0.3`. pnpm isolates per-package devDependencies, so
   two majors coexist fine. This is normal in a pnpm workspace; it is not a hack.
2. **Do the API bump in this plan's own commit** rather than merging Dependabot's
   #61. Reason: this plan also has to change `dependabot.yml`, docs, and possibly
   the root tsconfig; keeping it as one reviewable commit beats coordinating with
   a bot branch. **PRs #60, #61 and #62 are then closed as superseded** (the
   operator does this — see Maintenance notes; you, the executor, do NOT touch
   GitHub).
3. **Fence the dashboard in `dependabot.yml`**, don't just close #62 — otherwise
   the same broken PR returns every Monday. The ignore rule must carry a comment
   naming the crash and the exact condition for removing it.
4. **Test whether `ignoreDeprecations` can now be dropped** (Step 3). It only
   affects the API, and the API is moving to TS 7. If the API typechecks *and
   builds* without it, delete it — the bridge has served its purpose. If it
   doesn't, keep it and fix the stale comment. **Let the compiler decide; do not
   guess.**
5. **Correct the docs.** `AGENTS.md` and `.agent/CONTEXT.md` both claim the
   deprecated-options bridge is what blocks TS 7. It isn't. A wrong sharp-edge
   note is worse than none — it sends the next person at the wrong problem.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Bump api TS | `CI=true pnpm --filter api add -D typescript@^7.0.2` | manifest + lockfile updated |
| Frozen install | `CI=true pnpm install --frozen-lockfile` | exit 0 |
| Typecheck API | `pnpm --filter api exec tsc --noEmit` | exit 0, no output |
| Typecheck dashboard | `pnpm --filter dashboard check` | 0 errors, 0 warnings |
| Build (incl. tsup d.ts) | `pnpm build` | exit 0 |
| Tests | `pnpm test` | all pass |
| Lint | `rtk proxy pnpm lint` (plain `pnpm lint` is garbled by a hook) | exit 0 |

Note `pnpm add --frozen-lockfile` does NOT exist (it is an install-only flag) —
use `pnpm add`, then verify with a separate `CI=true pnpm install --frozen-lockfile`.
pnpm 11's `minimumReleaseAge: 1440` means a version published <24h ago won't
install; TS 7.0.2 is old enough (Dependabot already resolved it in CI), so this
should not bite.

## Scope

**In scope**:
- `apps/api/package.json` + `pnpm-lock.yaml` — TypeScript → `^7.0.2`
- `tsconfig.json` — only if Step 3 proves `ignoreDeprecations` is removable
- `.github/dependabot.yml` — split the npm entry; ignore TS majors for the dashboard
- `AGENTS.md` — correct the "TS 6 bridge" sharp edge
- `.agent/CONTEXT.md` — correct the same claim in its toolchain section

**Out of scope** (do NOT touch):
- `apps/dashboard/package.json` — the dashboard stays on TypeScript 6. Do not
  bump it "to see if it works": CI already proved it crashes.
- `svelte-check` — do not try to patch, pin around, or replace it. It is the only
  Svelte typechecker; the fix belongs upstream.
- Any application source code. If TS 7 surfaces a *real* type error in the API,
  that is a STOP condition, not a licence to start editing `src/`.
- GitHub PRs #60/#61/#62 — the operator closes those, not you.

## Git workflow

Branch `advisor/023-typescript-7-split-adoption`; single-line conventional-commit
subject (e.g. `chore(deps): adopt TypeScript 7 in the API, hold the dashboard on 6`);
**no `Co-Authored-By` trailer**; do not push or open a PR unless the operator
instructed it.

## Steps

### Step 1: Bump the API to TypeScript 7

```bash
CI=true pnpm --filter api add -D typescript@^7.0.2
CI=true pnpm install --frozen-lockfile
```

Confirm `apps/dashboard/package.json` still says `"typescript": "^6.0.3"` — if the
bump leaked into the dashboard, undo it.

**Verify**:
- `pnpm --filter api exec tsc --noEmit` → exit 0, no output.
- `pnpm --filter dashboard check` → **0 errors, 0 warnings** (proves the dashboard
  still resolves TS 6 and svelte-check still runs).
- `pnpm test` → all pass. `pnpm build` → exit 0 (this exercises tsup's d.ts
  builder, the thing the old tsconfig comment blamed).

**STOP** if `tsc` reports real type errors in `apps/api/src/**` — that means TS 7
found genuine bugs, which is a separate piece of work. Report them; do not fix
them here.

### Step 2: Fence the dashboard in Dependabot

Split the single npm entry in `.github/dependabot.yml` into two, preserving
`schedule`, `cooldown`, `open-pull-requests-limit`, `commit-message`, `groups`,
**and the existing `@types/node` major ignore, in BOTH entries**:

- Entry 1 — `directories: ["/", "/apps/api"]`. No typescript ignore (the API is
  on 7 and should keep getting updates).
- Entry 2 — `directories: ["/apps/dashboard"]`, with the extra ignore:

```yaml
    ignore:
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
      # TypeScript 7 (the native rewrite) breaks svelte-check 4.x: it reads
      # `ts.default.sys.useCaseSensitiveFileNames`, which TS 7 no longer
      # exposes, so `svelte-check` crashes on startup (see PR #62). Its peer
      # range claims `typescript: ">=5.0.0"`, so nothing stops the install —
      # only this rule does. The API is already on TS 7; only the dashboard is
      # pinned. REMOVE THIS once svelte-check ships TS 7 support, then bump the
      # dashboard to match the API.
      - dependency-name: "typescript"
        update-types: ["version-update:semver-major"]
```

**Verify**: the YAML parses —
`node -e "console.log(require('yaml').parse(require('fs').readFileSync('.github/dependabot.yml','utf8')).updates.length)"`
prints `3` (two npm entries + the github-actions entry). If the `yaml` package
isn't available, use `python3 -c "import yaml,sys;print(len(yaml.safe_load(open('.github/dependabot.yml'))['updates']))"`.
Do **not** hand-wave this — a malformed `dependabot.yml` fails silently (Dependabot
just stops running).

### Step 3: Decide `ignoreDeprecations` empirically

The root `tsconfig.json` carries `"ignoreDeprecations": "6.0"` with a comment
blaming tsup's injected `baseUrl`. The API is now on TS 7, and the root tsconfig
governs **only** the API (the dashboard extends `.svelte-kit/tsconfig.json`).

Delete the `ignoreDeprecations` line (and its now-stale comment), then run:

```bash
pnpm --filter api exec tsc --noEmit
pnpm build            # exercises tsup's d.ts builder
```

- If **both pass** → leave it deleted. The bridge is gone; say so in your report.
- If **either fails** → restore the line, and replace the comment with what the
  failure actually says (quote the real error). Do not leave a comment that blames
  the wrong thing.

Either outcome is a success; the point is that the compiler decides, not a guess.

### Step 4: Correct the docs

Both files currently state that migrating deprecated tsconfig options is the
prerequisite for TS 7. That is **false** — CI proved the API typechecks clean
under TS 7 with the bridge in place. Replace with the real constraint.

`AGENTS.md`, in "Sharp edges", replace the **TS 6 bridge** bullet with something
like:

> - **TypeScript is split across the workspace**: `apps/api` is on **TS 7**;
>   `apps/dashboard` is pinned to **TS 6** because `svelte-check` 4.x crashes
>   under TS 7 (it reads `ts.default.sys`, which the native rewrite removed).
>   `.github/dependabot.yml` ignores TS majors for the dashboard only — lift that
>   pin when svelte-check supports TS 7.

Make the equivalent correction in `.agent/CONTEXT.md`'s toolchain section (it has
a matching "TS 6" line). Keep both terse; state the *reason*, not just the rule.

**Verify**: `grep -rn "ignoreDeprecations" AGENTS.md .agent/CONTEXT.md` returns
nothing that still claims it blocks TS 7.

## Test plan

No new unit tests — this is a toolchain change, and the existing suites plus the
typecheckers *are* the test. What must hold after the change:

- API typechecks under TS 7 (`pnpm --filter api exec tsc --noEmit`).
- Dashboard still typechecks under TS 6 (`pnpm --filter dashboard check` → 0/0).
  This is the regression that matters: if svelte-check crashes, the pin failed.
- `pnpm test` unchanged: API and dashboard suites both green.
- `pnpm build` green — including tsup's `.d.ts` emit, which is what the old
  tsconfig comment was worried about.

## Done criteria

- [ ] `apps/api/package.json` says `"typescript": "^7.0.2"`; `apps/dashboard/package.json` still says `"^6.0.3"`
- [ ] `CI=true pnpm install --frozen-lockfile` exits 0; lockfile committed
- [ ] `pnpm --filter api exec tsc --noEmit` exits 0
- [ ] `pnpm --filter dashboard check` → 0 errors, 0 warnings (svelte-check still runs)
- [ ] `pnpm test` all green; `pnpm build` exits 0; `rtk proxy pnpm lint` exits 0
- [ ] `.github/dependabot.yml` parses and has exactly 3 `updates` entries; the dashboard entry ignores `typescript` majors AND keeps the `@types/node` ignore
- [ ] `AGENTS.md` + `.agent/CONTEXT.md` no longer claim `ignoreDeprecations` blocks TS 7
- [ ] Your report states plainly whether `ignoreDeprecations` was removable (Step 3)
- [ ] `git status` clean outside the in-scope list

## STOP conditions

Stop and report (do not improvise) if:

- TS 7 surfaces **real type errors** in `apps/api/src/**`. Report them; do not
  start editing application source to appease a compiler upgrade — that is a
  separate plan with a separate risk profile.
- `pnpm --filter dashboard check` fails **after** you've confirmed the dashboard
  still resolves TypeScript 6. That would mean the pin didn't hold (e.g. pnpm
  hoisted a single TS version), which changes the whole approach — report before
  attempting workarounds.
- You find yourself wanting to touch `svelte-check`, patch it, or swap the
  dashboard's typechecker. Out of scope — the fix is upstream.
- `tsup`'s d.ts build breaks under TS 7 in a way Step 3 can't resolve by restoring
  `ignoreDeprecations`.

## Maintenance notes

- **The pin is temporary and must be revisited.** The trigger for lifting it is a
  `svelte-check` release that supports TypeScript 7 (watch for the `ts.sys` /
  native-TS-API issue upstream). When that lands: bump the dashboard's TypeScript,
  delete the `typescript` ignore rule from the dashboard's Dependabot entry, and
  the two workspace halves converge again. Until then the split is deliberate.
- **For the operator (not the executor)**: after this lands, close Dependabot PRs
  **#60, #61 and #62** as superseded. #61 was correct-but-partial (it did exactly
  the API half of this plan); #60 and #62 will keep failing until svelte-check is
  fixed, and the new ignore rule stops #62's kind from being re-opened.
- A reviewer should check the `dependabot.yml` split most carefully: an `ignore`
  rule silently dropped from one of the two entries (especially `@types/node`,
  which must stay in both) fails *quietly* — the only symptom is a bad PR appearing
  weeks later.
