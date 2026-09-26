import type { Check, Issue, Severity } from './types';
import { MAX_ISSUES_PER_CHECK, MAX_MESSAGE_LENGTH } from './types';

/** The subset of an axe-core result the summary needs (keeps this module browser-free). */
export interface AxeRuleResult {
  id: string;
  impact?: string | null;
  help: string;
  nodes: unknown[];
}

export interface AxeSummaryInput {
  violations: AxeRuleResult[];
  passes: AxeRuleResult[];
}

/**
 * Weight of a rule by its impact. A pass carries no impact in axe's output
 * (the rule found nothing to be severe about), so passes count as `moderate`.
 * The effect: one critical violation outweighs three passing rules.
 */
export const IMPACT_WEIGHT: Record<string, number> = {
  critical: 10,
  serious: 7,
  moderate: 3,
  minor: 1,
};
const PASS_WEIGHT = IMPACT_WEIGHT.moderate;

const IMPACT_ORDER: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

function toSeverity(impact: string | null | undefined): Severity {
  return impact === 'critical' || impact === 'serious' || impact === 'moderate' || impact === 'minor'
    ? impact
    : 'moderate';
}

/**
 * Summarise axe-core results into an a11y check.
 *
 * Score = weighted pass ratio over the rules that APPLIED to the page
 * (inapplicable/incomplete rules are excluded — a page with no forms must not
 * score higher for having "passed" every form rule). Each rule counts once,
 * however many elements violate it: the element count is reported as the
 * issue's `count`, and a regression is a NEW rule id, not a higher count.
 *
 * A page where no rule applied at all scores `null` (nothing was measured).
 */
export function summarizeAxe({ violations, passes }: AxeSummaryInput): Check {
  const violationWeight = violations.reduce(
    (sum, v) => sum + (IMPACT_WEIGHT[toSeverity(v.impact)] ?? PASS_WEIGHT),
    0
  );
  const passWeight = passes.length * PASS_WEIGHT;
  const total = violationWeight + passWeight;
  const score = total === 0 ? null : Math.round((passWeight / total) * 10_000) / 10_000;

  const issues: Issue[] = [...violations]
    .sort(
      (a, b) =>
        (IMPACT_ORDER[toSeverity(a.impact)] ?? 9) - (IMPACT_ORDER[toSeverity(b.impact)] ?? 9) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, MAX_ISSUES_PER_CHECK)
    .map((v) => ({
      id: v.id,
      severity: toSeverity(v.impact),
      message: v.help.slice(0, MAX_MESSAGE_LENGTH),
      count: v.nodes.length,
    }));

  return { category: 'a11y', score, issues };
}
