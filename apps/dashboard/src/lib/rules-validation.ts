// Pure, client-safe pre-flight mirroring the API's rule schema
// (apps/api/src/routes/admin.ts quarantineRuleShape + checkRuleConsistency).
// The API stays authoritative; this only blocks obviously-invalid submits for
// fast inline feedback. No I/O, no env: safe to import into a .svelte
// component. Reuses admin-validation's numeric-bounds check (DRY).
import { validateNumericField, type NumericFieldSpec } from './admin-validation';

const RULE_NUMERIC_SPECS: Record<string, NumericFieldSpec> = {
  flakeThreshold: { min: 0, max: 1, integer: false },
  minRuns: { min: 1, max: 100, integer: true },
  windowDays: { min: 1, max: 90, integer: true },
  consecutiveFailures: { min: 1, max: 100, integer: true },
  ttlDays: { min: 1, max: 365, integer: true },
};

export interface RuleValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

// `raw` holds every rule field as a string (form values). Numeric bounds are
// checked first; then the cross-field consistency rule based on `action`.
export function validateRuleForm(raw: Record<string, string>): RuleValidationResult {
  const errors: Record<string, string> = {};

  for (const [field, spec] of Object.entries(RULE_NUMERIC_SPECS)) {
    const msg = validateNumericField(raw[field] ?? '', spec);
    if (msg) errors[field] = msg;
  }

  const action = raw.action ?? '';
  if (action !== 'quarantine' && action !== 'exempt') {
    errors.action = "must be 'quarantine' or 'exempt'";
    return { valid: false, errors };
  }

  const conditionType = (raw.conditionType ?? '').trim();
  const hasThreshold = (raw.flakeThreshold ?? '').trim() !== '';
  const hasConsecutive = (raw.consecutiveFailures ?? '').trim() !== '';

  if (action === 'exempt') {
    if (conditionType !== '' || hasThreshold || hasConsecutive) {
      errors.action = 'exempt rules take no condition';
    }
    return { valid: Object.keys(errors).length === 0, errors };
  }

  // action === 'quarantine'
  if (conditionType === '') {
    errors.conditionType = 'quarantine rules need a condition';
  } else if (conditionType !== 'flake_rate' && conditionType !== 'consecutive') {
    errors.conditionType = "must be 'flake_rate' or 'consecutive'";
  } else if (conditionType === 'flake_rate' && !hasThreshold) {
    errors.flakeThreshold = 'flake_rate needs a threshold';
  } else if (conditionType === 'consecutive' && !hasConsecutive) {
    errors.consecutiveFailures = 'consecutive needs a failure count';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// Maps the raw form strings to a create/patch body. Blank ⇒ null ("use the
// default"); present ⇒ parsed number / trimmed string. `enabled` is the
// checkbox boolean. For exempt rules, condition fields are forced null so a
// leftover value can't sneak through.
export function buildRulePayload(
  raw: Record<string, string>,
  enabled: boolean
): Record<string, number | string | boolean | null> {
  const str = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  const action = raw.action === 'exempt' ? 'exempt' : 'quarantine';

  const payload: Record<string, number | string | boolean | null> = {
    name: str(raw.name ?? ''),
    enabled,
    selectorBranch: str(raw.selectorBranch ?? ''),
    selectorFile: str(raw.selectorFile ?? ''),
    selectorTag: str(raw.selectorTag ?? ''),
    action,
    ttlDays: num(raw.ttlDays ?? ''),
  };

  if (action === 'exempt') {
    payload.conditionType = null;
    payload.flakeThreshold = null;
    payload.minRuns = null;
    payload.windowDays = null;
    payload.consecutiveFailures = null;
  } else {
    const ct = (raw.conditionType ?? '').trim();
    payload.conditionType = ct === '' ? null : ct;
    payload.flakeThreshold = num(raw.flakeThreshold ?? '');
    payload.minRuns = num(raw.minRuns ?? '');
    payload.windowDays = num(raw.windowDays ?? '');
    payload.consecutiveFailures = num(raw.consecutiveFailures ?? '');
  }

  return payload;
}
