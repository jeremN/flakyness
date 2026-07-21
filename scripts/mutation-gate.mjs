import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Per-file floors over the A1–A3b hardened set. floor = floor(baseline) - 5.
// Baselines recorded 2026-07-21. Bump deliberately, like the route-count guard.
// Broad-run scores for non-hardened files are report-only.
//
// The 4 dashboard baselines + API rate-limit.ts reproduce exactly run-to-run.
// The two other API floors were lowered from earlier, higher recordings — for
// two DIFFERENT reasons, not one:
//  - logger.ts: an earlier concurrent-load run mis-scored 5 Survived mutants as
//    Timeout (this formula counts Timeout like Killed), inflating it to 79.41%.
//    Reliable isolated timeout-free score = 72.06% (49 killed, reproduced 4x).
//    timeoutMS/timeoutFactor in apps/api's Stryker config now suppress that.
//  - projects.ts: its score is non-deterministic (~54-58%) because the projects
//    route tests hit the repo's documented un-awaited reconcile race (AGENTS.md)
//    — ~12 mutants swing Killed<->Survived between runs, NOT a timeout artifact;
//    the timeout knob does not fix it. Never measured in isolation; floor 48 is
//    set below the reliable low (~53.7%). Stabilizing that race is what would
//    let this floor tighten.
// Raising real coverage on the coarse route files is the honest way to lift
// these floors (see plans/README.md #13/#15).
export const HARDENED = [
  // { report, file, floor }  // baseline: <score>%
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/logger.ts',     floor: 67 }, // baseline: 72.06% (reliable, reproduced 4x)
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/rate-limit.ts', floor: 57 }, // baseline: 62.00%
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/routes/projects.ts',       floor: 48 }, // baseline: ~53.7% (reliable low; race-wobbly)
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/format.ts',            floor: 91 }, // baseline: 96.88%
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/status.ts',            floor: 61 }, // baseline: 66.04%
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/error-page.ts',        floor: 95 }, // baseline: 100.00%
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/href.ts',              floor: 95 }, // baseline: 100.00%
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
