# Auto-quarantine (roadmap #2) — design

**Status:** approved 2026-07-22. Implements **roadmap #2** in `docs/STRATEGY.md`.
Base `c759cf8` (main). Plan lands as `plans/051-*`.

## Purpose

Today Flackyness *detects* flaky tests (marks `flaky_tests.status='active'`, which
the GitHub Action annotates on the PR) but **never skips them in CI**. A test is
skipped only when a human manually mutes it (`PATCH /tests/flaky/:id` → `status=
'ignored'`), and `buildGrepInvert()` is deliberately derived from `ignored`
(muted) tests **only** — `routes/projects.ts:191-193` carries a load-bearing
comment: *"Auto-skipping a machine-detected test without human sign-off would
silently hide a real regression."*

"Real auto-quarantine" (roadmap #2) therefore means **relaxing a considered
safety guarantee**, not filling a gap. This change adds an automatic path *into*
the existing `ignored` state, gated so the default posture is unchanged. All
downstream plumbing — the quarantine endpoint, `grep-invert`, the Action that
consumes it — already exists and is untouched.

## Decisions (locked)

The four product decisions (from brainstorming):

1. **Policy = C + B hybrid.** Auto-quarantine is **opt-in per project**
   (`auto_quarantine_enabled`, default **false** ⇒ every existing project keeps
   today's behavior exactly). When enabled, a qualifying test **auto-mutes**
   (becomes skip-eligible) with a **mandatory TTL** and an **entry/exit
   notification**.
2. **Trigger = separate, stricter threshold.** A new per-project
   `quarantine_threshold` (default 0.20), **≥ the detection `flakeThreshold`**
   (default 0.05). This creates a band: `flakeThreshold ≤ rate <
   quarantine_threshold` = reported-only (`active`); `rate ≥ quarantine_threshold`
   = auto-quarantined. Same flake-rate formula as detection.
3. **Exit = fixed TTL → release + clean slate.** Quarantine lasts
   `quarantine_ttl_days` (default 7). At expiry the test auto-releases (un-mutes,
   back to `active`) and runs normally again; it can only **re-quarantine on
   runs recorded AFTER release** — stale pre-quarantine flakes never instantly
   re-trigger it.
4. **Scope = API/engine only.** #2 ships the schema, admin-API config, the
   reconcile-integrated engine, notifications, and a traceability trail.
   Auto-quarantined tests already appear in the **existing** dashboard quarantine
   view (they are `ignored`). The **config UI** (toggle + threshold/TTL fields)
   and per-branch/tag/file rules are **roadmap #4** (which the STRATEGY doc says
   depends on #2). Slack *formatting* is **roadmap #3**.

Derived engineering decisions (mine, presented and approved):

5. **Promotion targets the existing `ignored` state**, so `buildGrepInvert()` is
   unchanged and the `projects.ts:191-193` invariant ("grepInvert from muted
   only") stays literally true — we add a machine path *into* `muted`, we do not
   add `flaky`/`active` to `grepInvert`.
6. **Release runs inside the reconcile** (`updateFlakyTests`, post-ingest) — no
   app-level scheduler (the repo has none). Since every CI run both reads the
   quarantine list and ingests, an expired test is released within one CI run of
   TTL expiry. A project that stops ingesting keeps its (harmless, unused)
   quarantine until its next ingest — accepted trade-off.
7. **Traceability = an append-only `quarantine_events` table**, written on every
   transition including manual mute/unmute, so the trail is complete (the doc's
   "traçabilité du mute"). No UI in #2.

## Schema changes (additive migration; all nullable / default-safe)

**`projects`** — 4 columns, set via the existing admin PATCH (`routes/admin.ts`),
NULL = use default (same pattern as `flakeThreshold`/`windowDays`/`minRuns`):
- `auto_quarantine_enabled boolean NOT NULL DEFAULT false`
- `quarantine_threshold decimal(5,4)` — default 0.20; validated `≥` resolved
  `flakeThreshold` and `≤ 1.0`
- `quarantine_min_runs integer` — default = resolved `minRuns` (3); `≥ 1`
- `quarantine_ttl_days integer` — default 7; `1 ≤ n ≤ 365`

**`flaky_tests`** — 3 columns carrying mute provenance + TTL:
- `mute_source varchar(10)` — `'manual'` | `'auto'` | NULL (only meaningful while
  `status='ignored'`)
- `quarantine_expires_at timestamp` — set for auto-mutes; NULL for manual
  (indefinite) and for non-muted rows
- `quarantine_released_at timestamp` — set on auto-release; anchors the
  clean-slate rule

**`quarantine_events`** (new, append-only audit):
```
id uuid pk
project_id uuid  -> projects.id  ON DELETE CASCADE   (per the cascade convention)
test_name varchar(500) NOT NULL
event varchar(20) NOT NULL      -- 'entered' | 'released' | 'manual_mute' | 'manual_unmute'
source varchar(10) NOT NULL     -- 'auto' | 'manual'
flake_rate decimal(5,4)         -- snapshot at the transition (nullable for manual)
threshold decimal(5,4)          -- the quarantine_threshold in effect (nullable for manual)
ttl_days integer                -- nullable (only for 'entered')
created_at timestamp NOT NULL DEFAULT now()
```
Indexed on `(project_id, created_at)`. No UI in #2 — this is the record for #4's
audit view and for `GET` inspection.

## Config resolution + validation

Extend `resolveConfig()` (or a sibling `resolveQuarantineConfig()`) to merge the
new NULL-able overrides over the quarantine defaults, exactly like the existing
flakiness config. Admin PATCH validation (zod, in `routes/admin.ts`), mirroring
the existing knob bounds:
- `quarantine_threshold`: number in `[resolvedFlakeThreshold, 1.0]` — rejecting
  `< flakeThreshold` (a quarantine bar below the detection bar is nonsensical).
- `quarantine_min_runs`: integer `≥ 1`.
- `quarantine_ttl_days`: integer in `[1, 365]`.
- `auto_quarantine_enabled`: boolean.

## Engine flow (inside `updateFlakyTests`, order is load-bearing)

The reconcile already sweeps **every** `flaky_tests` row for the project. Add
three ordered phases:

1. **Release** (always, even if the project later disabled the feature — expiry
   must still fire so nothing is stuck skipped): for each row with
   `status='ignored' AND mute_source='auto' AND now > quarantine_expires_at` →
   set `status='active'`, `mute_source=NULL`, `quarantine_expires_at=NULL`,
   `quarantine_released_at=now`; append `quarantine_events('released','auto')`;
   emit a `quarantine_released` webhook. **Manual mutes
   (`mute_source='manual'`) are never auto-released.**
2. **Detect** flakiness exactly as today (compute `flakeRate`/`totalRuns`, set
   `active`/`resolved`). Unchanged.
3. **Promote** — only if `auto_quarantine_enabled`: for each `active` row where
   `flakeRate ≥ quarantine_threshold` **AND** the test has `≥ quarantine_min_runs`
   `test_results` rows with `created_at > quarantine_released_at` (or no release
   on record) → set `status='ignored'`, `mute_source='auto'`,
   `quarantine_expires_at = now + ttl_days`; append
   `quarantine_events('entered','auto')`; emit a `quarantine_entered` webhook.

The **"runs after `quarantine_released_at`"** predicate is the clean slate: a
just-released test cannot instantly re-quarantine on its stale record — it must
flake again on genuinely fresh runs.

**Interaction with manual mute:** a human PATCHing an `auto`-quarantined test to
`ignored` flips `mute_source` to `'manual'` and clears `quarantine_expires_at`
→ it becomes indefinite and immune to auto-release (the operator's escape hatch
to "keep it muted"). PATCH `active` on an auto-muted test releases it (clean
slate). Both manual transitions append `quarantine_events('manual_mute'|
'manual_unmute','manual')`.

## Notifications

Reuse `services/notifications.ts`. Extend `FlakyTransitionPayload` (or add a
discriminated `type` field) to carry `quarantine_entered` / `quarantine_released`
events (payload: `projectId, testName, flakeRate, quarantineThreshold, ttlDays,
expiresAt|releasedAt`). Fired best-effort from the engine phases; a project with
no `webhookUrl` ⇒ logged no-op, never blocks or fails the reconcile. Slack
formatting is **out of scope** (#3).

## Behavior preservation / safety

- **Default off = zero change.** `auto_quarantine_enabled` defaults false, so
  Promote never runs for un-opted-in projects; `grepInvert` stays exactly
  today's manual-mute-only set. This is provable: ingest a test above
  `quarantine_threshold` into a non-opted-in project → it stays `active`, absent
  from `grepInvert`.
- **`buildGrepInvert` and `projects.ts:191-193` are unchanged** — the invariant
  holds; we only added a machine writer of the `ignored` status it already reads.
- Migration is additive + nullable/defaulted — existing rows and installs are
  untouched (`mute_source`/expiry NULL for every current mute ⇒ treated as
  `manual`/indefinite, matching today's semantics).

## Testing (all against disposable Postgres; mutation-quality assertions)

- **Default-off:** flaky-above-threshold test in a non-opted-in project stays
  `active`, out of `grepInvert`, no `quarantine_events`.
- **Promotion:** opted-in project, test crosses `quarantine_threshold` with
  `≥ quarantine_min_runs` → becomes `ignored`/`auto` with a future
  `quarantine_expires_at`, enters `grepInvert`, writes an `entered` event, fires
  the webhook (assert via a stub/captured call).
- **Reported-only band:** rate in `[flakeThreshold, quarantine_threshold)` stays
  `active` (detected, not quarantined).
- **TTL release:** an `auto` mute past `quarantine_expires_at` → back to
  `active`, `quarantine_released_at` set, `released` event + webhook, leaves
  `grepInvert`.
- **Clean slate:** a just-released test with `< quarantine_min_runs` fresh runs
  is NOT re-quarantined even though its windowed `flakeRate` is still high; once
  `quarantine_min_runs` fresh runs flake, it re-quarantines.
- **Manual precedence:** a `manual` mute is never auto-released; PATCH `auto`→
  `manual` clears the expiry; audit rows written for manual transitions.
- **Config validation:** `quarantine_threshold < flakeThreshold`, ttl/min-runs
  out of bounds → 400.

## Success criteria

1. Additive migration; every existing project behaves identically until it opts
   in (default-off test green).
2. Opting a project in makes tests crossing `quarantine_threshold` auto-mute with
   a TTL, flow into `grepInvert`, and notify — provably, in the reconcile.
3. TTL expiry auto-releases with a clean slate; manual mutes are untouched by the
   engine.
4. Every quarantine transition (auto + manual) is recorded in
   `quarantine_events`.
5. `buildGrepInvert` / `projects.ts:191-193` invariant unchanged; existing suites
   green; new endpoints/config validated + documented in `docs/API.md`; new read
   surface (if any) mounts `readAuth()`.

## Out of scope (deferred)

Config UI + per-branch/tag/file rules (#4); non-blocking "runs while quarantined"
exit lane; Slack/Teams formatting (#3); multi-tenant scoping (#5).

## Constraints (non-negotiables)

- New `projects` child table (`quarantine_events`) uses `onDelete: 'cascade'`.
- Time-series/`null`-not-`0` conventions unaffected. Structured logger, never
  `console.log`. zod-validate every input; Drizzle query builder only.
- New read endpoints (if any) mount `readAuth()` and bump the route-count guard
  deliberately; new endpoints update `docs/API.md` + add a route test + rate
  limiting.
- The un-awaited-reconcile race is real (AGENTS.md): tests reading `flaky_tests`
  after an ingest must poll, never `sleep`.
- Commits: single-line conventional subject, **NO `Co-Authored-By`**. `main`
  branch-protected — PR needs green CI + explicit user approval.
