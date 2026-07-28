import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Per-file floors over the A1–A3b hardened set, plus plan 048's hardening of
// projects.ts/rate-limit.ts and plan 049's promotion of flakiness.ts + the
// parsers. floor = floor(reliableLow) - 5. Baselines recorded 2026-07-21
// (A1-A3b + Phase B); projects.ts/rate-limit.ts re-baselined 2026-07-22
// (plan 048); flakiness.ts/junit.ts/playwright.ts baselined 2026-07-22
// (plan 049). Bump deliberately, like the route-count guard. Broad-run scores
// for non-hardened files are report-only.
//
// The 4 dashboard baselines reproduce exactly run-to-run. The three API
// floors do NOT — each is calibrated off a reliable low (lowest of ≥2 scored
// runs), for different reasons:
//  - logger.ts: an earlier concurrent-load run mis-scored 5 Survived mutants as
//    Timeout (this formula counts Timeout like Killed), inflating it to 79.41%.
//    Reliable isolated timeout-free score = 72.06% (49 killed, reproduced 4x).
//    timeoutMS/timeoutFactor in apps/api's Stryker config now suppress that.
//  - projects.ts: its score is non-deterministic (pre-048: ~54-58%; post-048:
//    ~66-68%) because the projects route tests hit the repo's documented
//    un-awaited reconcile race (AGENTS.md) — post-048, 84+ of 298 mutants swing
//    Killed<->Survived between runs (up from the pre-048 ~12; the wider new
//    coverage surface exposes the race to more mutants), but flips run in
//    both directions and roughly cancel, so the aggregate itself only moves
//    ~1-2pp per run. NOT a timeout artifact; the timeout knob does not fix
//    it. Plan 048 hardened the query-param clamp/fallback, status-filter,
//    and populated-trend branches (projects.test.ts); three post-hardening
//    scored runs came back 67.11%, 68.46%, and 66.44%, of-total. Floor 61 is
//    set below the reliable low (66.44%). Stabilizing the reconcile race is
//    what would let this floor tighten further.
//  - rate-limit.ts: plan 048 hardened the multi-hop/whitespaced XFF parsing,
//    trusted-proxy-list trim, 429 body, and exported-constant branches
//    (rate-limit.test.ts). Three post-hardening scored runs came back
//    88.00%, 86.00%, and 86.00%, of-total — a genuine ~2pp wobble that
//    contradicts the pre-048 assumption that this file "reproduces exactly."
//    Root cause: the one mutant that flips (rate-limit.ts:99, the
//    adminRateLimit message string) is a deliberately-unhardened accepted
//    residual (see plans/README.md #13) whose Killed/Survived status is
//    apparently sensitive to cross-test timing, not a flaw in the new
//    assertions — every mutant the new tests target killed in all three
//    runs. Floor 81 is set below the reliable low (86.00%), same
//    margin-of-safety policy as projects.ts.
// Plan 049 promoted three previously report-only files. Unlike the wobbly
// route/middleware files above, these were hardened to high, stable scores
// (survivor-driven, test-only), each measured across a scoped run + the
// consolidated all-6 run:
//  - flakiness.ts: 92.90%, identical across both runs (deterministic). Its 2
//    Timeouts are the chunks() `i -= size` / `i >= arr.length` infinite-loop
//    mutants — genuine hangs the suite detects, not the false-timeout artifact
//    that hit logger.ts. Floor 87.
//  - junit.ts: 88.38%, identical across both runs (pure parser, no DB). Floor 83.
//  - playwright.ts: reliable low 91.11% (of 91.11/91.37; pure parser). Floor 86.
// Raising real coverage on the coarse route files is the honest way to lift
// these floors further (see plans/README.md #13/#15).
// Plan 054 (quarantine rule engine) baselined services/rules.ts 2026-07-24 via
// `stryker run --mutate src/services/rules.ts` (pure module, no DB): 89.23%,
// identical across 2 scoped runs (deterministic, same pattern as
// flakiness.ts/junit.ts). Floor 84.
// Plan 056 (identity core, task 8) baselined services/auth/password.ts and
// services/auth/session.ts 2026-07-28 via
// `stryker run --mutate src/services/auth/password.ts,src/services/auth/session.ts`
// (pure modules, no DB touched by the mutated code itself, though the dry
// run still needs Postgres up for the rest of the suite): both files scored
// identically across 2 scoped runs (deterministic, same pattern as
// flakiness.ts/junit.ts/rules.ts).
//  - session.ts: 100.00% both runs. Floor 95.
//  - password.ts: 88.14% both runs (raised from an initial 62.71% baseline
//    by adding tests — see password.test.ts's "out-of-range encoded cost
//    parameters" describe block and the standalone tests after it — for
//    branches that were previously reachable-but-unasserted). Floor 83.
//    7 mutants survive both runs, all verified equivalent (not chased):
//    scryptAsync's `if (err) reject(err)` (password.ts:16) — Node's public
//    scrypt() API validates every documented invalid-parameter case
//    SYNCHRONOUSLY (confirmed by direct testing: bad N/r/p, non-integers,
//    NaN, Infinity, and out-of-memory N all throw before the callback would
//    ever run), so the callback's `err` is null on every reachable path;
//    reproducing a non-null `err` would require mocking node:crypto, which
//    this suite deliberately does not do (real scrypt only, matching every
//    other test in the file). hashPassword's `{ N, r: R, p: P }` -> `{}`
//    (password.ts:51) — N=16384/r=8/p=1 (this module's chosen cost) are
//    byte-for-byte IDENTICAL to Node's own scrypt() defaults when no options
//    are passed (verified: scryptSync with `{}` and with the explicit
//    triple produce the same digest), so this mutant cannot ever produce a
//    different derived key. All 4 survivors on the `!Number.isInteger(n) ||
//    !Number.isInteger(r) || !Number.isInteger(p)` guard (password.ts:69,
//    whole line and its LogicalOperator/ConditionalExpression sub-mutants)
//    — every value that fails Number.isInteger (NaN, ±Infinity, non-integer
//    floats) also makes scrypt() throw synchronously when used as N/r/p, so
//    bypassing this guard always lands in the same catch block returning
//    the same `false`; verified directly for all three parameter positions.
//    `n <= 1` -> `n < 1` (password.ts:70) — differs only at n=1, and N=1 is
//    independently rejected by scrypt() itself ("N must be a power of two"),
//    so no test can observe a difference (unlike r<=0/p<=0, where scrypt
//    silently substitutes its own default for 0 instead of throwing — that
//    asymmetry is exactly why the r/p siblings of this same line ARE tested
//    and killed, via crafted digests real at the substituted default).
export const HARDENED = [
  // { report, file, floor }  // baseline: <score>%
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/logger.ts',     floor: 67 }, // baseline: 72.06% (reliable, reproduced 4x)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/rate-limit.ts', floor: 81 }, // baseline: 86.00% (reliable low; wobbles ~2pp post-048 — see comment above)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/routes/projects.ts',       floor: 61 }, // baseline: 66.44% (reliable low; race-wobbly)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/services/flakiness.ts',    floor: 87 }, // baseline: 92.90% (reliable, reproduced 2x; 2 genuine chunks() infinite-loop timeouts)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/parsers/junit.ts',         floor: 83 }, // baseline: 88.38% (deterministic — identical across 2 runs)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/parsers/playwright.ts',    floor: 86 }, // baseline: 91.11% (reliable low of 91.11/91.37)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/services/rules.ts',        floor: 84 }, // baseline: 89.23% (reliable, reproduced 2x)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/services/auth/password.ts', floor: 83 }, // baseline: 88.14% (reliable, reproduced 2x; plan 056)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/services/auth/session.ts',   floor: 95 }, // baseline: 100.00% (reliable, reproduced 2x; plan 056)
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/format.ts',            floor: 91 }, // baseline: 96.88%
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/status.ts',            floor: 61 }, // baseline: 66.04%
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/error-page.ts',        floor: 95 }, // baseline: 100.00%
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/href.ts',              floor: 95 }, // baseline: 100.00%
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/rule-summary.ts',      floor: 95 }, // baseline: 100.00% (plan 055; pure/deterministic)
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/rules-validation.ts',  floor: 83 }, // baseline: 88.05% (plan 055; survivors led by equivalent `?? ''` fallbacks over always-string readRuleForm output)
];

// Stryker mutation score: (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage).
// Ignored / CompileError / RuntimeError are excluded from the denominator.
export function evaluate(hardened, readJson) {
  const results = [];
  for (const h of hardened) {
    let json;
    try { json = readJson(h.report); } catch { return { ok: false, error: `cannot read ${h.report}`, results }; }
    const entry = json?.files?.[h.file];
    if (!entry) return { ok: false, error: `no entry for ${h.file} in ${h.report}`, results };
    let detected = 0, valid = 0;
    for (const m of entry.mutants) {
      if (m.status === 'Killed' || m.status === 'Timeout') { detected++; valid++; }
      else if (m.status === 'Survived' || m.status === 'NoCoverage') { valid++; }
    }
    const score = valid ? (detected / valid) * 100 : 100;
    results.push({ file: h.file, score, detected, valid, floor: h.floor, pass: score >= h.floor });
  }
  return { ok: results.every((r) => r.pass), results };
}

// Main guard — only runs when executed directly, not when imported by the test.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const { ok, error, results } = evaluate(HARDENED, readJson);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.score.toFixed(1)}%  (floor ${r.floor}%)  ${r.file}  [${r.detected}/${r.valid}]`);
  }
  if (error) { console.error(`\nGATE ERROR: ${error}`); process.exit(2); }
  if (!ok) { console.error('\nGATE FAILED: a hardened file dropped below its floor.'); process.exit(1); }
  console.log('\nGATE PASSED: hardened set holds.');
}
