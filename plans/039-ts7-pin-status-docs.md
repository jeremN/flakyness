# Plan 039: Sharpen the "dashboard TS 6 pin" docs with the dated, sourced blocker status

> **Executor instructions**: doc-only change. Follow exactly, honor STOP conditions. Do not update
> `plans/README.md` (the reviewer maintains it).
>
> **Drift check**: `git rev-parse --short HEAD` at or after `ca0002b`. Confirm the three docs still
> carry the vague "lift when svelte-check supports TS 7" phrasing (see anchors below). If already
> updated with a TS 7.1 / Oct-2026 status, STOP.

## Status
- **Priority**: P4 (docs precision; captures the plan-#7 investigation so it isn't repeated)
- **Effort**: XS
- **Risk**: NONE — comments/prose only; no config key/value, no code, no dependency, no behavior.
- **Category**: docs
- **Planned at**: commit `ca0002b`, 2026-07-15

## Why
Follow-up #7 (lift the dashboard TS 6 pin) was investigated 2026-07-15 and is **still blocked** —
but the three places that document the pin say only "lift when `svelte-check` supports TS 7," which
is vague and invites someone to re-investigate or try (and break the dashboard typecheck). The
investigation found the precise, dated status; encode it so the next contributor / `reconcile` knows
exactly what's true and when to recheck.

## The facts to encode (verified 2026-07-15)
- **TypeScript 7.0 GA (July 2026) ships no stable *programmatic* API.** Svelte's template
  type-checking (what `svelte-check` does) reaches into the compiler; without that API it cannot run
  against the Go (`tsgo`) implementation. So **Svelte/Vue/Astro/MDX cannot type-check on TS 7.0 at
  all** — this is the real blocker; the older `ts.default.sys.useCaseSensitiveFileNames` crash was a
  symptom of the same "no public API" problem.
- The programmatic API is expected in **TypeScript 7.1 (~Oct 2026)**; official Svelte guidance is
  **stay on TS 6 until 7.1**.
- `svelte-check` latest is still **4.7.2** (no TS-7-compatible release exists yet).
- Tracking issue: **`sveltejs/language-tools#2733`** ("TypeScript Go support (at least in CLI)").
- **Recheck trigger**: BOTH (a) TS 7.1 GA and (b) a `svelte-check` release that supports it — not
  before. Frame the date as an upstream *estimate* ("~Oct 2026, per upstream"), not a promise.

Keep the existing accurate detail (the `ts.sys` symptom, the dashboard-only Dependabot ignore) —
just add the root cause, the TS 7.1 / ~Oct 2026 timeline, the "stay on TS 6" guidance, and the
tracking issue, and replace the bare "when svelte-check supports TS 7" with the two-part recheck
trigger.

## Scope
**In scope (comments/prose only — do NOT change any config key/value or code):**
1. `AGENTS.md` — the "TypeScript is split across the workspace" sharp-edge bullet (currently lines
   ~32-36), ending "lift that pin when svelte-check supports TS 7."
2. `.agent/CONTEXT.md` — the matching "TypeScript is split across the workspace" bullet (~line 33)
   ending "lift it once svelte-check supports TS 7." Keep AGENTS.md and CONTEXT.md **consistent**
   (they are deliberately kept in sync). Also the roadmap line (~579) ending "until `svelte-check`
   supports TS 7" — a light touch is fine (e.g. "until svelte-check supports TS 7 — blocked on TS
   7.1, ~Oct 2026; see AGENTS.md").
3. `.github/dependabot.yml` — the `typescript` majors `ignore` comment (~lines 70-76) ending
   "REMOVE THIS once svelte-check ships TS 7 support, then bump the dashboard to match the API."
   Update the COMMENT only; the `ignore` rule itself stays exactly as-is. (The upper comment at
   ~50-52 may get a one-word touch for consistency but isn't required.)

**Out of scope**: any `.yml` key/value, the `ignore` rule, `package.json` versions, any code, the
`docs/API.md`, `plans/README.md`.

## Steps
1. Edit the three files' prose per "facts to encode." Keep each doc's existing voice/format
   (AGENTS.md terse sharp-edge; CONTEXT.md fuller; dependabot.yml `#` comments).
2. **Verify no config/code changed**: `rtk proxy git diff main -- .github/dependabot.yml` shows only
   `#`-comment lines changed (no `-`/`+` on any key like `directories`, `ignore`, `dependency-name`,
   `update-types`). `git diff --name-only main` = exactly the three files above.
3. Sanity gate (a doc PR won't exercise much, but run them): `rtk proxy pnpm lint` → 0 (unaffected);
   optionally `rtk proxy pnpm --filter dashboard exec svelte-kit sync` is NOT needed. No test changes.

## Done criteria
- [ ] All three docs state: TS 7.0 has no programmatic API → Svelte can't typecheck on TS 7.0;
      unblocks at TS 7.1 (~Oct 2026, upstream estimate); stay on TS 6 until then; recheck needs BOTH
      TS 7.1 GA and a supporting svelte-check; tracking `sveltejs/language-tools#2733`.
- [ ] AGENTS.md and `.agent/CONTEXT.md` remain consistent with each other.
- [ ] `.github/dependabot.yml`: comment-only change; the `ignore` rule and all keys/values byte-for-
      byte unchanged.
- [ ] `git diff --name-only main` = `AGENTS.md`, `.agent/CONTEXT.md`, `.github/dependabot.yml`; `pnpm
      lint` exit 0.

## STOP conditions
- You find yourself changing any YAML key/value (not just a `#` comment) → STOP; this is docs-only.
- You're tempted to actually bump the dashboard's TypeScript or remove the ignore → STOP; the pin
  stays (the whole point is that it's still blocked).
- A doc already has the dated TS 7.1 status → it was done; STOP and report.

## Maintenance notes
- This note's date (~Oct 2026) is an upstream estimate; the real trigger is the two-part condition.
  A future `/improve reconcile` after Oct 2026 should re-run the "is svelte-check TS-7-ready?" check
  before touching the pin.
