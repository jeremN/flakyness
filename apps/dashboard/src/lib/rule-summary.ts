// One-line human summary of a quarantine rule for the console list. Pure; no
// I/O. Output strings are asserted verbatim by the render + E2E tests — keep
// the `≥` (U+2265) and separators exact.
import type { QuarantineRule } from '../app.d';

export function describeRule(rule: QuarantineRule): string {
  const scope = describeSelectors(rule);
  if (rule.action === 'exempt') {
    return `exempt · ${scope || 'all tests'}`;
  }
  const cond = describeCondition(rule);
  return scope ? `${scope} · ${cond}` : cond;
}

function describeSelectors(rule: QuarantineRule): string {
  const parts: string[] = [];
  if (rule.selectorBranch) parts.push(rule.selectorBranch);
  if (rule.selectorFile) parts.push(rule.selectorFile);
  if (rule.selectorTag) parts.push(`#${rule.selectorTag}`);
  return parts.join(' ');
}

function describeCondition(rule: QuarantineRule): string {
  if (rule.conditionType === 'consecutive') {
    const win = rule.windowDays != null ? ` / ${rule.windowDays}d` : '';
    return `${rule.consecutiveFailures ?? '?'} consecutive fails${win}`;
  }
  if (rule.conditionType === 'flake_rate') {
    const rate = rule.flakeThreshold != null ? rule.flakeThreshold.toFixed(2) : '?';
    const runs = rule.minRuns != null ? ` over ≥ ${rule.minRuns} runs` : '';
    const win = rule.windowDays != null ? ` / ${rule.windowDays}d` : '';
    return `flake ≥ ${rate}${runs}${win}`;
  }
  return 'no condition';
}
