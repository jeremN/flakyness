# Plan 009: Dashboard quick wins — modular ECharts, dead Tailwind config, CSP

> **Executor instructions**: Follow this plan step by step. The three parts
> are independent — if one hits a STOP condition, report it and continue with
> the others. Run every verification command and confirm the expected result
> before moving on. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- apps/dashboard/src/lib/components/Chart.svelte apps/dashboard/tailwind.config.js apps/dashboard/svelte.config.js apps/dashboard/src/app.css apps/dashboard/package.json`
> On a mismatch with the excerpts below, treat it as a STOP for that part.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (parts 1–2) / MED (part 3 — CSP can block assets; it has its own rollback)
- **Depends on**: none
- **Category**: perf / tech-debt / security
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

1. `Chart.svelte` imports the entire ECharts library (~1MB min, ~330KB gz)
   to render one line chart — modular imports cut the chart bundle by ~70%,
   directly improving first load.
2. `tailwind.config.js` looks like live design config but is never loaded:
   Tailwind v4 runs via `@tailwindcss/vite` and `app.css` has no `@config`
   directive. Its custom `flaky` color, font stacks, and the
   `@tailwindcss/forms` plugin silently do nothing — misleading dead code
   (already noted in `.agent/CONTEXT.md` Known Issues).
3. The dashboard renders attacker-influenceable content (test names, error
   messages from uploaded reports) with no Content-Security-Policy. All sinks
   are Svelte-escaped today, so this is defense-in-depth, not a live hole.

## Current state

- `apps/dashboard/src/lib/components/Chart.svelte` — line 3:
  `import * as echarts from 'echarts';` plus
  `import type { EChartsOption } from 'echarts';`. Uses `echarts.init`,
  `chart.setOption`, `chart.resize`, `chart.dispose`. The ONLY chart in the
  app is the overview trend line (`apps/dashboard/src/routes/+page.svelte:23-90`),
  whose options use: `tooltip` (axis trigger), `grid`, `xAxis`
  (`type:'category'`), `yAxis` (`type:'value'`), one `series` entry
  `type:'line'` with `areaStyle` gradient (plain object literal
  `{type:'linear', colorStops:[...]}` — no `echarts.graphic` import needed).
- `apps/dashboard/tailwind.config.js` — full contents: `content` glob, theme
  extension (`colors.flaky: '#f97316'`, `fontFamily.sans/mono`), plugin
  `@tailwindcss/forms` (imported at top).
- `apps/dashboard/src/app.css` — starts with `@import 'tailwindcss';` then a
  Google Fonts `@import url('https://fonts.googleapis.com/...Inter...')`;
  design tokens live here as CSS custom properties. NO `@config` directive
  anywhere (`grep -n "@config" apps/dashboard/src/app.css` → nothing).
- Verified: no template uses forms-plugin classes (`grep -rn "form-input\|form-select\|form-checkbox" apps/dashboard/src` → nothing). `font-mono` IS used
  in templates but resolves to Tailwind's default mono stack (the config's
  custom stack never applied).
- `apps/dashboard/package.json` — devDeps include `"@tailwindcss/forms": "^0.5.11"`.
- `apps/dashboard/svelte.config.js` — full contents:

```js
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: 'build' }),
    alias: { $lib: './src/lib', $components: './src/lib/components' },
  },
};
export default config;
```

- External origins the CSP must allow: `fonts.googleapis.com` (stylesheet via
  the `app.css` `@import`) and `fonts.gstatic.com` (font files). ECharts
  renders to canvas and sets inline styles → `style-src` needs
  `'unsafe-inline'`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm --filter dashboard check` | 0 errors, 0 warnings |
| Build | `pnpm --filter dashboard build` | exit 0 |
| Preview (prod server) | `pnpm --filter dashboard preview` | serves on :4173 |
| Tests (if plan 007 landed) | `pnpm --filter dashboard test` | pass |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope** (the only files you should modify/delete):
- `apps/dashboard/src/lib/components/Chart.svelte`
- `apps/dashboard/tailwind.config.js` (delete)
- `apps/dashboard/package.json` (remove `@tailwindcss/forms`) + `pnpm-lock.yaml` via `pnpm install`
- `apps/dashboard/svelte.config.js` (CSP)
- `.agent/CONTEXT.md` (ONLY the Known Issues line about tailwind.config.js — remove it once resolved)

**Out of scope** (do NOT touch):
- `apps/dashboard/src/routes/+page.svelte` chart options — the options object
  is compatible with modular imports as-is.
- `app.css` — do NOT self-host the Google font in this plan (bigger change;
  noted in maintenance).
- The API's `secureHeaders()` config.

## Git workflow

- Branch: `advisor/009-dashboard-quick-wins`
- One conventional commit per part, single-line subjects (e.g.
  `perf(dashboard): import echarts modularly`). Do NOT add any
  `Co-Authored-By` trailer. Do not push or open a PR unless the operator
  instructed it.

## Steps

### Part A — Modular ECharts

In `Chart.svelte`, replace the import block:

```ts
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';   // type-only: no runtime cost

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);
```

Everything else (`echarts.init`, `setOption`, `resize`, `dispose`, the
`echarts.ECharts` type annotation — which also exists on `echarts/core`)
stays. Record the bundle delta: run `pnpm --filter dashboard build` BEFORE
and AFTER and note the size of the largest client chunk from vite's output
in your report.

**Verify**: `pnpm --filter dashboard build` → exit 0 and the largest chunk shrinks by ≥ 300KB (uncompressed); `pnpm --filter dashboard check` → 0 errors. Then `pnpm --filter dashboard preview` + open the overview with seeded data (see plan 008 Step 6.2 for stack startup) → the trend chart renders with tooltip on hover. If you cannot run a browser, state so and rely on the build/check gates plus maintenance note.

### Part B — Remove the inert Tailwind config

1. Pre-check (must both be empty, else STOP):
   `grep -n "@config" apps/dashboard/src/app.css` and
   `grep -rn "bg-flaky\|text-flaky\|border-flaky" apps/dashboard/src`.
2. `git rm apps/dashboard/tailwind.config.js`
3. Remove `"@tailwindcss/forms"` from `apps/dashboard/package.json` devDeps;
   `pnpm install`.
4. Remove the tailwind.config.js Known-Issues line from `.agent/CONTEXT.md`
   (it's in the toolchain section, ~line 32: "tailwind.config.js is currently
   not loaded…" — delete or mark resolved).

**Verify**: `pnpm --filter dashboard build` → exit 0; `pnpm --filter dashboard check` → 0 errors; `grep -rn "tailwindcss/forms" apps/dashboard` → no matches. Visually (or via the preview HTML) the pages are unchanged — the config never applied, so NO visual diff is expected; any visible change is a STOP.

### Part C — Content-Security-Policy

In `svelte.config.js`, add to `kit`:

```js
csp: {
  mode: 'auto',
  directives: {
    'default-src': ['self'],
    'script-src': ['self'],
    'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
    'font-src': ['self', 'https://fonts.gstatic.com'],
    'img-src': ['self', 'data:'],
    'connect-src': ['self'],
    'object-src': ['none'],
    'base-uri': ['self'],
    'frame-ancestors': ['none'],
  },
},
```

(`mode: 'auto'` lets kit add nonces/hashes for its own inline scripts;
`'unsafe-inline'` in style-src is required by ECharts' inline styles and
Svelte transitions — an accepted trade-off, documented here.)

**Verify**: `pnpm --filter dashboard build` → exit 0. Then
`pnpm --filter dashboard preview` and:
`curl -sI http://localhost:4173/ | grep -i content-security-policy` → header
present containing `script-src 'self'`. Load the overview in a browser with
the API running: the chart renders AND the browser console shows zero CSP
violation reports. If any resource is blocked, add ONLY its specific origin
to the relevant directive and re-verify; if the chart itself breaks and one
directive addition doesn't fix it, REVERT part C (git checkout the file) and
report the violation messages verbatim.

## Test plan

No new unit tests (component/visual behavior). Gates: build + check + the
curl header check + browser verification of chart render and console
cleanliness. If plan 007's suite exists, it must stay green
(`pnpm --filter dashboard test`).

## Done criteria

ALL must hold:

- [ ] `grep -n "from 'echarts'" apps/dashboard/src/lib/components/Chart.svelte` → only the `import type` line
- [ ] Largest client chunk shrank ≥ 300KB (record before/after numbers in the report)
- [ ] `apps/dashboard/tailwind.config.js` deleted; `@tailwindcss/forms` gone from package.json and lockfile
- [ ] `curl -sI` on the preview server shows a `content-security-policy` header (or part C reverted + reported)
- [ ] `pnpm --filter dashboard build`, `pnpm --filter dashboard check`, `pnpm lint` all exit 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop (that part only) and report if:

- Part A: the chart renders blank after the modular swap and adding a missing
  component registration (check the exact console error — ECharts names the
  missing module) doesn't fix it on the second attempt.
- Part B: either pre-check grep is non-empty (the config IS referenced), or
  any visual change appears after deletion.
- Part C: violations persist after one targeted directive addition (revert
  part C, keep parts A/B, report).

## Maintenance notes

- Part A: any NEW chart type (bar, pie, dataZoom, legend…) must be registered
  in `Chart.svelte`'s `echarts.use([...])` or it renders blank — reviewer
  checklist for future chart work.
- Part C interacts with the Google Fonts `@import` in `app.css`; if fonts are
  later self-hosted (recommended for a self-hosted tool — removes the
  external dependency entirely), tighten `style-src`/`font-src` back to
  `'self'`.
- Deferred: self-hosting the Inter font; a stricter style-src via hashed
  styles (blocked on ECharts' inline styles).
