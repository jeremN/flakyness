
/** A stored rule reduced to the fields the engine reads (decimals as numbers). */
export interface EvalRule {
  id: string;
  position: number;
  action: 'quarantine' | 'exempt';
  conditionType: 'flake_rate' | 'consecutive' | null;
  selectorBranch: string | null;
  selectorFile: string | null;
  selectorTag: string | null;
  flakeThreshold: number | null;
  minRuns: number | null;
  windowDays: number | null;
  consecutiveFailures: number | null;
  ttlDays: number | null;
}

/** One test result in a test's evaluation window (already fetched, decimals resolved). */
export interface TestSliceResult {
  status: string;            // passed | failed | flaky | skipped
  branch: string;            // from test_runs
  testFile: string | null;
  tags: string[];            // test_results.tags ?? []
  createdAt: Date;
}

export type RuleDecision =
  | { kind: 'quarantine'; ruleId: string; ttlDays: number | null }
  | { kind: 'exempt'; ruleId: string }
  | { kind: 'leave'; ruleId: string }   // a quarantine rule owns it but its condition did not fire
  | { kind: 'no-match' };

/**
 * Translate a glob (`*` within a path segment, `**` across segments, `?` one
 * char; every other char literal) into an anchored full-string RegExp. No
 * dependency — the grammar is tiny and validated at write time.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }   // ** → across segments
      else re += '[^/]*';                              // *  → within a segment
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex metachars
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does one result fall inside a rule's selector slice? */
function resultMatchesSelectors(rule: EvalRule, res: TestSliceResult): boolean {
  if (rule.selectorBranch !== null && !globToRegExp(rule.selectorBranch).test(res.branch)) return false;
  if (rule.selectorFile !== null && !globToRegExp(rule.selectorFile).test(res.testFile ?? '')) return false;
  if (rule.selectorTag !== null && !res.tags.includes(rule.selectorTag)) return false;
  return true;
}

function flakeRateFires(rule: EvalRule, slice: TestSliceResult[]): boolean {
  const total = slice.length;
  if (total < (rule.minRuns ?? 1)) return false;
  const bad = slice.filter((r) => r.status === 'failed' || r.status === 'flaky').length;
  return bad / total >= (rule.flakeThreshold ?? 1);
}

function consecutiveFires(rule: EvalRule, slice: TestSliceResult[]): boolean {
  const k = rule.consecutiveFailures ?? Infinity;
  // newest first; `failed` increments, `passed`/`flaky` reset, `skipped` ignored
  const ordered = [...slice].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  let streak = 0;
  for (const res of ordered) {
    if (res.status === 'skipped') continue;
    if (res.status === 'failed') { streak++; if (streak >= k) return true; }
    else break; // passed or flaky resets → streak from newest is over
  }
  return streak >= k;
}

/**
 * First-matching-rule wins. A rule matches a test when >=1 of the test's
 * results falls in the rule's selector slice; that rule owns the decision and
 * evaluation stops. Returns `no-match` when no rule's selectors match — the
 * caller then applies the legacy project-threshold decision.
 */
export function evaluateRules(rules: EvalRule[], results: TestSliceResult[]): RuleDecision {
  for (const rule of rules) {
    const slice = results.filter((res) => resultMatchesSelectors(rule, res));
    if (slice.length === 0) continue; // selectors don't match this test → next rule
    if (rule.action === 'exempt') return { kind: 'exempt', ruleId: rule.id };
    const fires = rule.conditionType === 'consecutive'
      ? consecutiveFires(rule, slice)
      : flakeRateFires(rule, slice);
    return fires
      ? { kind: 'quarantine', ruleId: rule.id, ttlDays: rule.ttlDays }
      : { kind: 'leave', ruleId: rule.id };
  }
  return { kind: 'no-match' };
}
