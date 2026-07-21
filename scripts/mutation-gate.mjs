import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Per-file floors over the A1–A3b hardened set. floor = floor(baseline) - 5.
// Baselines recorded 2026-07-21 (Tasks 2 & 3). Bump deliberately, like the
// route-count guard. Broad-run scores for non-hardened files are report-only.
export const HARDENED = [
  // { report, file, floor }  // baseline: <score>%
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/logger.ts',     floor: 74 }, // baseline: 79.41%
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/rate-limit.ts', floor: 57 }, // baseline: 62.00%
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/routes/projects.ts',       floor: 53 }, // baseline: 58.05%
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
