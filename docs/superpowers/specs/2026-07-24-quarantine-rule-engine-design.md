# Quarantine Rule Engine (Roadmap 4b) — Design

**Status:** Design approved (scope + all core semantics locked; see "Locked
decisions"). Awaiting spec review before planning.

**Roadmap:** STRATEGY.md #4 — "rule engine de seuils + UI admin". #4 splits into
**4a (admin console UI — shipped, plan 053)** and **4b (this spec — the rule
engine)**. This covers **4b only**. The **console UI for managing rules is a
deliberate fast-follow** (its own spec/plan), mirroring how plan 051
(auto-quarantine engine + API) preceded plan 053 (its config UI).

**Goal:** Replace plan 051's single per-project `quarantineThreshold` with an
ordered set of **scoped rules** — matched by branch / tag / file, carrying a
richer condition (a flake-rate threshold **or** a consecutive-failure counter) —
that drive the existing auto-quarantine machinery. Ship the evaluation engine +
admin API; leave base flaky *measurement* untouched.

---

## Why

Auto-quarantine (plan 051) can express exactly one policy per project: "mute a
test whose global flake-rate crosses a single threshold." That is too blunt for
real repos:

- **Different branches deserve different strictness.** A team wants a strict bar
  on `main` (protect the trunk) but tolerance on `release/*` or throwaway feature
  branches — impossible with one global number.
- **Some tests must never be auto-muted.** A `@critical` smoke test should stay
  loud even when flaky; there is no way to carve it out today.
- **A flat percentage misses "broken right now."** A test failing five times in a
  row on `main` today can still sit below a 14-day global flake-rate threshold, so
  the current model won't catch it. A **consecutive-failure counter** does.

The roadmap names exactly this — "règles par branche/tag/fichier, compteurs
consécutifs." The plumbing downstream (promote → `ignored`, TTL, clean-slate
release, `quarantine_events` audit, `grepInvert` skip-list) already exists; 4b
only makes the *decision* that feeds it richer and scoped.

The design is constrained by three existing facts:

1. **The matching data is already ingested.** `test_runs.branch`,
   `test_results.test_file`, and `test_results.tags` (jsonb `string[]`) all exist
   today and the Playwright/JUnit parsers already populate them — so per-branch /
   per-file / per-tag matching needs **no parser, schema, or ingest change** for
   the input data.

2. **Auto-quarantine is opt-in and reversible (plan 051).** Rules live *inside*
   the existing `auto_quarantine_enabled` gate and reuse its promote/release/TTL/
   audit machinery. A project that enables auto-quarantine but writes no rules
   keeps today's single-threshold behavior byte-for-byte.

3. **Base flaky measurement stays neutral.** `computeFlakiness` /
   `flaky_tests` — the always-on numbers the dashboard shows — are **not** touched
   by rules. Rules decide *policy* (what to quarantine), never *measurement* (the
   flake-rate stat). This keeps the visible dashboard numbers stable and un-gamed
   by policy.

---

## Locked decisions

1. **Rules govern the auto-quarantine decision only** — not base flaky detection.
   The dashboard's flake-rate stat is the neutral, always-on measurement; rules
   are policy layered on top.
2. **Selectors: `branch`, `testFile`, `tag`.** `branch`/`testFile` match by
   **glob** (`main`, `release/*`, `e2e/**`, `**/checkout.spec.ts`); `tag` matches
   by **membership** (the result's `tags[]` contains the selector). A rule matches
   a slice when **all** its provided selectors match (AND); an omitted selector is
   a wildcard. **Globs only — no regex** (add later if a real need appears).
3. **Two condition types, one per rule:** `flake_rate` (`flakeRate ≥ X` over
   `≥ minRuns` within `windowDays`) and `consecutive` (`≥ K` failing runs in a row).
   Consecutive semantics: a `failed` result increments the streak; a `passed`
   **or** `flaky` (passed-on-retry) resets it; `skipped` is ignored.
4. **Resolution: ordered list, first-matching-rule wins** (firewall/CSS-style,
   most-specific first). The first rule whose selectors match **owns the decision**
   and evaluation stops. A rule's `action` is `quarantine` (condition fires →
   quarantine; else leave active) or `exempt` (never auto-quarantine this slice —
   the carve-out that makes ordering worth having). **If no rule matches**, fall
   through to the project's existing single `quarantineThreshold` (plan 051) —
   making 4b strictly additive and backward-compatible.
5. **MVP scope = engine + admin API.** The console UI to manage rules is a
   fast-follow (own spec/plan).
6. **Storage: typed relational columns** (not JSONB) — one column per concept,
   zod-validated per field, matching the repo's Drizzle + decimal-as-string
   conventions (plan 051) and its mutation-provable-assertion standard.

---

## Architecture

Neutral shape: **`quarantine_rules` table → pure `evaluateRules` (first-match,
slice-measured) → `reconcileQuarantine` promote path → existing
`ignored`/TTL/audit machinery.** Admin CRUD+reorder over the table; no change to
`grepInvert` or base measurement.

### 1 · Data model — `quarantine_rules`

New project-child table, `onDelete: 'cascade'` (project deletion relies on FK
cascades):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK→projects, cascade | |
| `position` | int, notNull | ordering; **lower = higher priority** (evaluated first) |
| `name` | varchar(255) null | optional human label |
| `enabled` | bool, notNull, default `true` | |
| `selector_branch` | varchar(255) null | glob; null = any branch |
| `selector_file` | varchar(500) null | glob; null = any file |
| `selector_tag` | varchar(255) null | tag membership; null = any tag |
| `action` | varchar(16) notNull | `quarantine` \| `exempt` |
| `condition_type` | varchar(16) null | `flake_rate` \| `consecutive`; **null iff** `action = exempt` |
| `flake_threshold` | decimal(5,4) null | `flake_rate` only, [0,1], written `.toFixed(4)`, compared `Number(...)` |
| `min_runs` | int null | `flake_rate` only, [1,100]; null → project/global default |
| `window_days` | int null | [1,90]; null → project/global default |
| `consecutive_failures` | int null | `consecutive` only, [1,100] |
| `ttl_days` | int null | quarantine TTL, [1,365]; null → inherit project `quarantine_ttl_days` |
| `created_at` / `updated_at` | timestamptz notNull default now | |

Index on `(project_id, position)`. Additive migration only.

**zod cross-field validation** (mirrors the API's existing bound style):
- `action = exempt` ⇒ `condition_type` **and every condition param** must be null.
- `action = quarantine` ⇒ `condition_type` required.
- `condition_type = flake_rate` ⇒ `flake_threshold` required; `min_runs` /
  `window_days` optional (null → inherit project → global default).
- `condition_type = consecutive` ⇒ `consecutive_failures` required;
  `window_days` optional (bounds the lookback; null → inherit).
- Bounds: `flake_threshold` ∈ [0,1]; `min_runs` ∈ [1,100]; `window_days` ∈
  [1,90]; `consecutive_failures` ∈ [1,100]; `ttl_days` ∈ [1,365].

### 2 · Evaluation engine — `services/rules.ts` (pure + slice-measured)

Two mutation-tested pure pieces plus the slice queries:

- **Glob matcher** — a small in-house `globToRegExp` (`*` = within-segment, `**` =
  cross-segment, `?` = one char; everything else literal, anchored full-string).
  **No new dependency** (pnpm `minimumReleaseAge` friction; the grammar is tiny).
- **`evaluateRules(rules, testContext)`** — first-match-wins resolution returning
  one of `{ quarantine, ttlDays }` | `exempt` | `no-match`. Pure over already-
  fetched data.

**"A rule matches a test"** ⇔ the test has ≥1 result within the rule's window
whose `run.branch` matches `selector_branch`, `test_file` matches `selector_file`,
and `selector_tag` ∈ `tags[]` (each null selector is a wildcard). The **first**
matching rule (lowest `position`) **owns the decision**; evaluation stops:

- `exempt` → never rule-quarantine this test.
- `quarantine` + condition **fires over exactly the matching slice** → quarantine
  with `ttl_days` (or the project TTL).
- `quarantine` + condition does not fire → leave the test active.

**Condition on the slice** (results for this test in the window matching the
rule's selectors):
- `flake_rate`: `(failed + flaky) / total ≥ flake_threshold`, requiring
  `total ≥ min_runs`.
- `consecutive`: order the slice by `run.created_at` descending; count `failed`
  from newest until a non-`failed` non-`skipped` result; fire iff the count
  `≥ consecutive_failures`.

**No rule matches** → fall through to the project single-threshold decision
(plan 051), unchanged.

### 3 · Integration — `reconcileQuarantine` (`services/quarantine.ts`)

Runs in the same post-ingest reconcile, still gated by `auto_quarantine_enabled`
(chained on the ingest promise; awaited under `?wait=true` within the same
`withTimeout`):

- **Promote:** if the project has ≥1 **enabled** rule, take the rule path (§2)
  over the candidate set (below); otherwise the legacy single-threshold path runs
  exactly as today — **zero behavior change for rule-less projects**.
- **Release** (expired auto-mutes → `active`): **unchanged and unconditional**
  (plan 051's clean-slate guarantee holds; manual/`NULL` mutes never auto-release).
- **Provenance & audit:** rule-driven mutes keep `mute_source = 'auto'` +
  `quarantine_expires_at`; the `quarantine_events` row additionally records **which
  rule fired** via a new nullable `rule_id` column (FK→`quarantine_rules`,
  `onDelete: set null` so deleting a rule preserves history). The audit trail
  (auto **and** manual transitions) stays complete.
- **Invariants untouched:** `buildGrepInvert` still derives from `ignored` (muted)
  rows only; the `projects.ts:191-193` invariant holds — rules add a machine
  *writer* of `ignored`, not a new `active`/`flaky` source in `grepInvert`.

**Candidate set (the one non-obvious call — approved).** A `consecutive` rule is
meant to catch a test that is *hard-broken right now* even when its long-window
global flake-rate is below the project `flakeThreshold` — i.e. a test **not**
currently `active` in `flaky_tests`. Therefore, **when rules are present,
"quarantined" is no longer strictly a subset of globally-flaky tests**: the engine
evaluates every test with ≥1 result inside the project's rule-evaluation window
(= the max `window_days` across the project's enabled rules, capped at 90), not
just the active flaky set. Cost is a bounded N+1 (candidate tests × rules, each a
slice check) — acceptable at operator scale and consistent with plan 051's
accepted N+1; a batched-query optimization and a Stryker-gate entry are noted as
follow-ups.

### 4 · Admin API (ADMIN_TOKEN-gated) — `/api/v1/admin/projects/:id/rules`

Reuses the existing admin router (real security boundary stays `ADMIN_TOKEN`;
per-user auth is roadmap #6):

- `GET /admin/projects/:id/rules` — list, ordered by `position`.
- `POST /admin/projects/:id/rules` — create (appended to the end, or at a given
  `position`).
- `PATCH /admin/projects/:id/rules/:ruleId` — edit (partial; re-runs cross-field
  validation on the merged row).
- `DELETE /admin/projects/:id/rules/:ruleId`.
- `POST /admin/projects/:id/rules/reorder` — body is the full ordered id list;
  rewrites `position` transactionally (rejects if the id set doesn't match).

All zod-validated, rate-limited (the admin limiter already fronts the admin
router), `docs/API.md` updated, route tests added. **Route-count guard:** confirm
whether `routes-auth-coverage.test.ts` counts `/admin` GETs; if so, bump its
hard-coded count deliberately for the new `GET .../rules`.

---

## Error handling

- **Invalid rule (bounds / cross-field):** API returns `400` with the zod error;
  the future UI surfaces it inline. The API is authoritative.
- **Reorder id mismatch:** `400` (the submitted id set must equal the project's
  current rule ids) — no partial reorder.
- **Rule referencing a project it doesn't own / unknown rule id:** `404`, scoped
  by `project_id` so a cross-project `ruleId` never leaks or mutates.
- **Evaluation robustness:** a malformed glob is rejected at write time (validated
  as compilable), so evaluation never throws on a stored selector; an empty rule
  list ⇒ legacy path.

---

## Testing

- **`services/rules.ts`** (glob matcher + `evaluateRules`) → node-env `*.test.ts`,
  **mutation-provable**: every branch of first-match / exempt-owns / condition-
  fires / no-match bites a mutant; glob edge cases (`*` vs `**`, anchoring). Added
  to the Stryker per-file floor set.
- **Slice measurement + `reconcileQuarantine` rule path** → DB integration tests
  (disposable Postgres via `docker run`): per-branch flake_rate, consecutive on a
  slice, exempt override, first-match ordering, no-match fallback to the project
  threshold, Release-unchanged, and the "consecutive catches a not-globally-flaky
  test" case. Poll for the reconcile to land (never `sleep`).
- **Admin CRUD + reorder** → route tests (create→list→patch→reorder→delete),
  including provenance (`mute_source='auto'`, `rule_id` set) and audit-row
  assertions; cross-project 404s.

---

## Scope boundaries (YAGNI)

**In:** the `quarantine_rules` table + migration; the pure evaluation engine
(glob + first-match) and slice measurement; integration into
`reconcileQuarantine` (promote path, provenance, `rule_id` audit); admin CRUD +
reorder; docs + tests.

**Out (deliberately):**
- The **console UI** for managing rules — the sanctioned fast-follow (own
  spec/plan), reusing 4a's server-only `adminApi` + form-action machinery.
- **Regex** matching — globs only.
- A **third condition type** (absolute failure count, "failing across ≥ N
  branches", etc.).
- **Per-rule notification routing** — rule-driven mutes flow through the existing
  quarantine webhook path unchanged.
- Additional **selector axes** (pipeline, commit author, time-of-day).
- A **batched-query optimization** of the candidate-set N+1 (follow-up).
- Changes to **base flaky measurement** or the API auth model (roadmap #6).

---

## Open questions

None blocking. The one soft call — the broadened candidate set in §3 — is resolved
in favor of "evaluate all tests active in the window" so `consecutive` rules can
catch not-yet-flaky tests (the roadmap's stated intent); the bounded N+1 is
accepted at operator scale with a batching follow-up noted.
