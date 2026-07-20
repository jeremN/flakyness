# Test assertion hardening (A1) — design

**Status:** proposed
**Date:** 2026-07-20
**Sub-project:** A1 of the mutation-testing effort (A1 → A2 → A3 → B)

## Context

The question that started this: *are the unit suites complacent?* Rather than
reach for a mutation-testing tool first, we asked whether complacent tests
could be found and proven with no tooling at all. They can. This spec covers
only the tests that **already exist** and **already fail to bite**.

Sequencing for the wider effort, unchanged:

| Phase | Scope |
|-------|-------|
| **A1** (this spec) | Harden existing weak assertions |
| A2 | New tests for `rate-limit.ts` and `logger.ts` |
| A3 | Test the 6 `.svelte` route components (needs new infrastructure) |
| B | Stryker nightly |

Each phase is independently shippable. A1 first because it is the only one
that can be *proven* by source mutation today, and because it establishes the
standard the later phases are held to.

## The governing principle

> **An assertion earns its place only if some plausible mutation of the code
> it covers would make it fail.**

An assertion that cannot fail is not a weak test. It is a **non-test** that
reports as a passing test — strictly worse than no test, because it occupies
the slot where real coverage would otherwise be noticed as missing.

Every fix in this spec ships with a **mutation proof**: the covered code is
deliberately broken, the test is observed going red, the code is restored.
A fix without a recorded proof is not done.

## Findings

Four defect classes, in descending order of severity. All were verified
firsthand against the working tree at `2f51679`, not inferred.

### F1 — Unfalsifiable by type (critical)

```js
// apps/api/src/routes/api.test.ts:50
expect(res.headers.get('access-control-allow-origin')).toBeDefined();
// apps/api/src/routes/api.test.ts:111
expect(headers.get('x-frame-options')).toBeDefined();
```

`Headers.get()` returns `string | null` — **never `undefined`**. `toBeDefined()`
asserts only `!== undefined`. `expect(null).toBeDefined()` passes. No state of
the application can make either assertion fail.

**Proof performed.** Both assertion bodies were replayed against a bare Hono
app with `cors()` and `secureHeaders()` entirely absent:

```
Test Files  1 passed (1)
     Tests  3 passed (3)
```

The third test was a control asserting `toBeNull()` on both headers — it
passed too, confirming the headers were genuinely absent while the two
"security" assertions reported green. The CORS and clickjacking protections
could be deleted from `index.ts` today and both tests would stay green.

Note `api.test.ts:110` gets this right on the immediately preceding line
(`expect(headers.get('x-content-type-options')).toBe('nosniff')`), so the
correct pattern was already present in the same expression list.

### F2 — Mislabeled subject (important)

```js
// api.test.ts:87 — test named "should reject request without required params" (:77)
// Should fail validation - either 400 or 401 (auth required)   <- the source comment
expect([400, 401]).toContain(res.status);

// api.test.ts:99 — test named "should reject invalid JSON body" (:90)
expect([400, 401, 500]).toContain(res.status);
```

`routes/reports.ts:62` mounts `reports.use('*', projectAuth())` **before** the
handler. Neither request carries an `Authorization` header, so both are
rejected with 401 before validation or JSON parsing is ever reached. The test
named "should reject invalid JSON body" never parses JSON.

The multi-value `toContain` sets are what conceal this: by admitting the auth
status alongside the validation status, they pass regardless of which layer
actually responded. The in-source comment shows the original author was aware
of the ambiguity and encoded it rather than resolving it.

This coverage is **not lost** by fixing it — `reports.test.ts` already tests
the real thing with a valid token: `should require commit parameter` (:121),
`should default branch to main` (:133), `should reject invalid JSON body`
(:148), `should reject invalid Playwright report structure` (:160).

### F3 — A crash admitted as a pass (important)

`api.test.ts:99` accepts `500`. "The API cleanly rejected bad input" and "the
API crashed on bad input" are opposite outcomes; a test that accepts both
cannot detect the API losing its ability to reject. This is a specific
instance of F2's over-broad set, called out separately because accepting a
`5xx` is a distinct and worse failure mode than merely conflating `400` with
`401`.

### F4 — Shape asserted, meaning ignored (minor)

```js
// apps/api/src/routes/projects.test.ts:589-592
expect(body.windowDays).toBeDefined();
expect(body.threshold).toBeDefined();
expect(body.flakyTests).toBeDefined();
expect(body.allTests).toBeDefined();
```

Four consecutive existence checks on a response the suite itself provoked.
A handler returning `windowDays: null, threshold: null, flakyTests: null,
allTests: null` satisfies all four. Unlike F1 these *can* fail (on `undefined`),
so they are weak rather than vacuous — hence minor.

The very next test (:597) already does `expect(body.windowDays).toBe(7)`,
so the stronger pattern again exists adjacently.

## Fixes

### F1 — assert the value, and prove the middleware is load-bearing

Hono's `cors()` was probed to establish real behaviour before designing the
assertion:

| Configured `origin` | Request `Origin` | `access-control-allow-origin` |
|---|---|---|
| `http://localhost:5173` | `http://localhost:5173` | `http://localhost:5173` |
| `http://localhost:5173` | `https://evil.test` | *absent* (`null`) |
| `http://localhost:5173` | *(none)* | *absent* (`null`) |
| `*` | `https://evil.test` | `*` |

Both assertions are kept:

- matching origin → `toBe('http://localhost:5173')` — fails if `cors()` is removed
- foreign origin → `toBeNull()` — fails if the allowlist admits a foreign origin

> **Correction (post-review, Task 1).** An earlier draft of this spec justified
> the pair by claiming a matching-origin assertion alone would not catch a
> widening to `origin: '*'`. **That reasoning was wrong**, and the Task 1
> mutation transcript disproves it: under `origin: '*'`, *both* tests failed,
> because `toBe('http://localhost:5173')` rejects `'*'` on strict equality just
> as readily. The bare-wildcard mutation is redundantly covered.
>
> The pair's real non-overlapping value lies elsewhere: an **over-broad
> allowlist** that still echoes the legitimate origin correctly *and* echoes
> the attacker's — `origin: ['http://localhost:5173', 'https://evil.test']`, or
> a regex matcher with a loose anchor. There the matching-origin assertion
> passes and only the foreign-origin assertion bites. That is the case worth
> defending against, and it is a more realistic regression than someone typing
> `'*'`.
>
> The conclusion (keep both) survived; the argument for it did not. Recorded
> rather than quietly rewritten, because a spec is a reasoning record and a
> silently corrected rationale teaches nothing.

`x-frame-options` → `toBe('SAMEORIGIN')` (probed value of bare
`secureHeaders()`), mirroring the correct `nosniff` assertion beside it.

**Environment coupling, stated explicitly.** The allowed origin is
`process.env.DASHBOARD_URL || 'http://localhost:5173'` (`index.ts:26`), read at
module load. `DASHBOARD_URL` is set **only** in `docker-compose.yml:43`, and
nowhere in CI, `.env.example`, or any vitest config — verified repo-wide. The
literal is therefore correct under test. Asserting
`process.env.DASHBOARD_URL ?? '…'` instead would be tautological (it would
mirror the implementation and survive any mutation of it), so the literal is
deliberate. It carries a custom failure message naming `DASHBOARD_URL` so a
developer who has it exported locally gets a diagnosis rather than a puzzle.

### F2 / F3 — name the tests after what they actually assert

The two tests move to `toBe(401)` and are renamed to describe auth rejection.
`api.test.ts` is a smoke suite — eight hardcoded requests confirming the app
wires up — and "the reports route rejects unauthenticated requests" is a
legitimate, deterministic smoke assertion. They are **renamed, not deleted**:
deleting them would lose the smoke check that `projectAuth()` is still mounted,
which is exactly the property their new name claims.

They are **not** given valid tokens to test validation for real. That would
duplicate `reports.test.ts:120-171` and drag a DB dependency into the one API
suite that currently has none.

### F4 — assert invariants, not literals

The defaults derive from per-project `resolvedConfig` (`projects.ts:387-395`),
not a global constant, so hard-coded numbers would be fragile. Assert the
semantic properties instead:

- `windowDays` is a number `> 0`
- `threshold` is a number in `[0, 1]`
- `flakyTests` and `allTests` are arrays
- **`flakyTests` is a subset of `allTests`** — the real invariant of the
  endpoint, and the one a logic mutation would break

> **Outcome (post-implementation, Task 3). The subset invariant was designed
> in, then removed, because it could not be proven.**
>
> The fixture the test uses (`testProjectId`) never ingests a report, so its
> analysis is `[]` — and on an empty array `every(...)` is vacuously true. The
> invariant assertion would have passed with the filter deleted. That is the
> same defect class as F1, one level up: an assertion that looks like a check
> and cannot fail.
>
> The obvious remedy — point the test at the one populated project
> (`runDetailProjectId`, which ingests `mixedReport`) — was tried and also
> fails: `analyzeFlakiness` drops any test with fewer than `minRuns` runs
> (`flakiness.ts:16` sets `minRuns = 3`; the filter is `flakiness.ts:119`), and
> that project ingests a single report, so every test has one run and the
> analysis is empty too. An **anti-vacuity guard** (`allTests.length > 0`) is
> what surfaced this: it failed before any mutation was applied, refusing to
> let the test report green while asserting nothing.
>
> No fixture in the file can prove the invariant without ingesting ≥ 3 reports,
> which is new fixture setup — explicitly excluded by this spec's own rule
> against manufacturing data to fit a proof.
>
> **Shipped instead:** the empty analysis is asserted *outright*
> (`toEqual([])`), which is what is actually provable here and still catches
> the original `null` defect — proven by mutation
> (`expected null to deeply equal []`). The invariant and its `minRuns`
> reasoning are recorded as a code comment and routed to **A2**.
>
> This is the spec's governing principle applied to the spec itself: an
> assertion that cannot be made to fail does not ship, even when it is the one
> the author designed.

## Scope

**In:** the assertions named in F1–F4, in `apps/api/src/routes/api.test.ts` and
`apps/api/src/routes/projects.test.ts`.

**Out:** new test subjects (A2/A3); Stryker (B); the `describeWithDb` self-skip
contract; any change to non-test source. If a mutation proof reveals a real
product bug, it is reported, not fixed here.

**Explicitly not in scope:** a repo-wide sweep for every `toBeDefined()`. The
repo has **40** of them across 8 files (counted at `2f51679`). Most are on
plain object properties, where `toBeDefined()` *can* fail and the assertion is
merely weak — the F4 class. Triaging all 40 is an audit, and audits are what B
(Stryker) exists to automate; doing it by hand here would be slow, unprovable,
and would bury the four defects that actually matter.

The one sub-class that *is* swept exhaustively is F1, because it is mechanical
and greppable: `toBeDefined()` applied to a `Headers.get()` result is vacuous
by type, always. That grep was run repo-wide and returns exactly the two
instances named above — so F1 is closed completely by this spec, not sampled.

## Testing strategy

Each fix follows the same cycle, recorded in the plan per assertion:

1. Apply the tightened assertion.
2. Mutate the covered source (delete `cors()`; widen `origin` to `'*'`; delete
   `secureHeaders()`; remove `projectAuth()` from `reports.ts`; break the
   subset invariant).
3. Observe the specific test go red. **A mutation that leaves the suite green
   means the fix did not work** — the assertion is revised, not the proof.
4. Restore the source with `git checkout --` and confirm green.

Mutations are applied to the working tree and reverted within the same task.
Nothing mutated is ever committed.

## Risks

- **A tightened assertion turns out to be environment-dependent** and reddens
  CI. Mitigated by the `DASHBOARD_URL` analysis above and by custom failure
  messages that name the variable at fault.
- **A mutation proof reveals a genuine product bug.** Reported to the human,
  not silently fixed — a product fix belongs in its own change with its own
  review.
- **The renamed tests read as a coverage reduction** in review. The spec's F2
  section documents that `reports.test.ts` holds the real coverage; the plan
  cites those line numbers in the commit body.

## Success criteria

- No `toBeDefined()` remains on a `Headers.get()` result anywhere in the repo.
- Every assertion changed by A1 has a recorded mutation that makes it fail.
- No test name describes a subject the test does not reach.
- `pnpm test` green, lint and both typechecks clean, no product source changed.
