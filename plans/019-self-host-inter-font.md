# Plan 019: Self-host the Inter font (drop the Google Fonts CDN dependency)

> **Executor instructions**: Follow step by step; run every verification
> command. On any STOP condition, stop and report. Update your row in
> `plans/README.md` when done — unless a reviewer dispatched you and said
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7609d55..HEAD -- apps/dashboard/src/app.css apps/dashboard/svelte.config.js apps/dashboard/package.json`
> If `app.css` line 2 no longer imports fonts.googleapis.com, this plan may
> already be done — STOP and report.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (styling-only; CSP tightening is the only behavior change)
- **Depends on**: none. Low-conflict — can land anytime; only touches
  dashboard styling files.
- **Category**: hardening/self-containment
- **Planned at**: commit `7609d55`, 2026-07-10

## Why this matters

A **self-hosted** tool for private CI data phones home to Google on every
page load. `apps/dashboard/src/app.css:2`:

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
```

Consequences: dashboards inside air-gapped/locked-down networks render with
fallback fonts after a blocking-request delay; every viewer's IP hits
Google's CDN; and the CSP (added in the plan-009 hardening pass,
`apps/dashboard/svelte.config.js:16-22`) had to be widened with two
third-party hosts just for this:

```js
'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
'font-src': ['self', 'https://fonts.gstatic.com'],
```

Vendoring the font removes the external dependency and lets the CSP shrink
back to `self`.

## Current state

- `apps/dashboard/src/app.css` — line 1 imports tailwindcss; line 2 the
  Google Fonts URL above; the file then declares theme vars (`--font-sans`
  or a Tailwind v4 `@theme` referencing `Inter` — read lines 1–40 and find
  where the family is referenced).
- `apps/dashboard/svelte.config.js` — `kit.csp.directives` includes the two
  Google entries (lines 21–22).
- Dashboard bundling: Vite + Tailwind v4 CSS-first (`@tailwindcss/vite`) —
  CSS `@import` of a node_modules package resolves through Vite, and font
  assets referenced by that CSS are emitted/hashes into the build.
- Weights used per the Google URL: 400, 500, 600, 700.
- Workspace rules for adding the dep:
  `CI=true pnpm --filter dashboard add @fontsource/inter --no-frozen-lockfile`
  (pnpm 11 no-TTY quirks; `minimumReleaseAge: 1440`). Commit the lockfile.

## Design decisions (advisor — do not relitigate)

1. Use `@fontsource/inter` (versioned, npm-audited, latin+extended subsets
   prebuilt as WOFF2 with proper `@font-face` + `unicode-range`) instead of
   hand-downloading WOFF2 files — reproducible installs, updatable by
   Dependabot like everything else.
2. Runtime dependency (`add`, not `add -D`): it ships CSS+fonts consumed by
   the build. (Vite inlines/emits them at build time either way, but
   runtime-deps is the semantically honest slot and matches how reviewers
   audit prod deps.)
3. Import the four weights explicitly — no variable-font or full-family
   import (keeps the built CSS/asset payload minimal).
4. After removal, tighten the CSP in the SAME change: drop
   `https://fonts.googleapis.com` from `style-src` and
   `https://fonts.gstatic.com` from `font-src` (leaving `'self'` — and
   `'unsafe-inline'` in style-src stays; it belongs to Svelte/Tailwind, not
   fonts).

## Commands you will need

`CI=true pnpm --filter dashboard add @fontsource/inter --no-frozen-lockfile`;
check `pnpm --filter dashboard check`; tests `pnpm --filter dashboard test`;
build `pnpm --filter dashboard build` (garbled output → `rtk proxy pnpm …`);
preview: `npx vite preview --port 4179` from `apps/dashboard/` (the
`pnpm --filter … preview -- --port` form does NOT forward the flag); lint
`pnpm lint`. No database needed for this plan; the preview smoke works
without the API (pages render their error state — fine for font checks).

## Scope

**In scope**: `apps/dashboard/package.json` + `pnpm-lock.yaml`,
`apps/dashboard/src/app.css`, `apps/dashboard/svelte.config.js` (the two
CSP directive entries ONLY).

**Out of scope**: every other CSP directive (`script-src`, `connect-src`,
etc.); Tailwind theme values; any other style change; the API; Docker files
(the dashboard image builds from the lockfile already — verify, don't edit).

## Git workflow

Branch `advisor/019-self-host-inter-font`; single-line conventional commits
(e.g. `feat(dashboard): self-host Inter via fontsource`); NO
`Co-Authored-By` trailers; no push/PR unless the operator instructed it.

## Steps

### Step 1: Swap the import

Add the dependency, then in `app.css` replace line 2 with:

```css
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/inter/700.css';
```

(Keep the tailwind import first if it is currently first — preserve
existing order otherwise; CSS `@import` must precede other rules.) Confirm
the font-family reference elsewhere in the file still says `'Inter'` —
fontsource registers the same family name, so no other CSS changes.

**Verify**: `pnpm --filter dashboard build` → success; grep the build
output for gstatic/googleapis:
`grep -r "googleapis\|gstatic" apps/dashboard/.svelte-kit/output/ | grep -v node_modules` → NO
matches; the output contains emitted `.woff2` assets
(`find apps/dashboard/.svelte-kit/output -name "*.woff2" | head` → non-empty).

### Step 2: Tighten CSP

In `svelte.config.js`, change the two directives to:

```js
'style-src': ['self', 'unsafe-inline'],
'font-src': ['self'],
```

**Verify**: build again → success; `pnpm --filter dashboard check` → 0
errors; `pnpm --filter dashboard test` → pass.

### Step 3: Preview smoke

`npx vite preview --port 4179` (from `apps/dashboard/`). Then:

- `curl -sI http://localhost:4179/ | grep -i content-security-policy` →
  header present, contains `font-src 'self'`, contains NO `googleapis`/`gstatic`.
- `curl -s http://localhost:4179/ | grep -o 'fonts.googleapis[^"]*'` → empty.
- Fetch one emitted woff2 URL found in the served CSS → HTTP 200.

Kill the preview server when done.

## Done criteria

- [ ] `@fontsource/inter` in dashboard `dependencies`; lockfile committed; frozen install green
- [ ] Zero references to googleapis/gstatic anywhere in `apps/dashboard/src` or the build output
- [ ] CSP header serves `font-src 'self'` and a Google-free `style-src`
- [ ] WOFF2 assets emitted by the build and fetchable from preview
- [ ] Gates: dashboard check + tests + build, `pnpm lint`; `git status` clean outside the four files

## STOP conditions

- `@fontsource/inter`'s current release is <24h old and pnpm refuses it
  (`minimumReleaseAge`) → pin the previous version; if that fails, STOP.
- The Tailwind v4 pipeline rejects the fontsource `@import`s (plugin
  ordering error mentioning `@import` position) → try moving the fontsource
  imports ABOVE the tailwind import; if still failing, STOP with the exact
  error — do NOT fall back to copying font files by hand.
- The CSP in `svelte.config.js` has grown other font/style hosts since the
  excerpt → tighten only the two Google entries; anything else unknown → STOP.

## Maintenance notes

- Dependabot now owns font updates like any dep. `@fontsource/inter` majors
  track upstream Inter versions; visual diffs on major bumps are possible —
  eyeball the dashboard after such a bump.
- Anyone re-adding a third-party asset host must widen the CSP consciously —
  which is exactly the friction this plan is buying.
- If the dashboard ever adds a second font, prefer another `@fontsource/*`
  package for the same reasons.
