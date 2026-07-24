// Pure, client-safe pre-flight mirroring the API's zod bounds
// (apps/api/src/routes/admin.ts projectConfigPatchSchema). The API stays
// authoritative — this only blocks obviously-invalid submits for fast
// feedback. No I/O, no env: safe to import into a .svelte component.

export interface NumericFieldSpec {
  min: number;
  max: number;
  integer: boolean;
}

// Keyed by the exact PATCH field names. Empty string ⇒ "reset to default"
// (null) ⇒ always valid here; a present value must satisfy the spec.
export const CONFIG_FIELD_SPECS: Record<string, NumericFieldSpec> = {
  flakeThreshold: { min: 0, max: 1, integer: false },
  windowDays: { min: 1, max: 90, integer: true },
  minRuns: { min: 1, max: 100, integer: true },
  retentionDays: { min: 1, max: 3650, integer: true },
  quarantineThreshold: { min: 0, max: 1, integer: false },
  quarantineMinRuns: { min: 1, max: 100, integer: true },
  quarantineTtlDays: { min: 1, max: 365, integer: true },
};

export function validateNumericField(raw: string, spec: NumericFieldSpec): string | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'must be a number';
  if (spec.integer && !Number.isInteger(n)) return 'must be a whole number';
  if (n < spec.min || n > spec.max) return `must be between ${spec.min} and ${spec.max}`;
  return null;
}

export function validateWebhookUrl(raw: string): string | null {
  if (raw.trim() === '') return null;
  if (raw.length > 2048) return 'must be at most 2048 characters';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be a valid URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https';
  return null;
}

export function validateWebhookKind(raw: string): string | null {
  if (raw.trim() === '') return null;
  if (raw !== 'slack' && raw !== 'generic') return "must be 'slack' or 'generic'";
  return null;
}

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export function validateConfigForm(input: Record<string, string>): ValidationResult {
  const errors: Record<string, string> = {};
  for (const [field, spec] of Object.entries(CONFIG_FIELD_SPECS)) {
    const msg = validateNumericField(input[field] ?? '', spec);
    if (msg) errors[field] = msg;
  }
  const urlMsg = validateWebhookUrl(input.webhookUrl ?? '');
  if (urlMsg) errors.webhookUrl = urlMsg;
  const kindMsg = validateWebhookKind(input.webhookKind ?? '');
  if (kindMsg) errors.webhookKind = kindMsg;

  // Cross-field: retentionDays must not undercut windowDays. Only checked when
  // BOTH are present and finite (mirrors the API's post-parse refine).
  const rdRaw = (input.retentionDays ?? '').trim();
  const wdRaw = (input.windowDays ?? '').trim();
  if (rdRaw !== '' && wdRaw !== '') {
    const rd = Number(rdRaw);
    const wd = Number(wdRaw);
    if (Number.isFinite(rd) && Number.isFinite(wd) && rd < wd) {
      errors.retentionDays = 'must be at least the flake window (windowDays)';
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// Maps the raw form strings to a PATCH body: empty ⇒ null (reset to default),
// present ⇒ parsed number / verbatim string. autoQuarantineEnabled is a
// checkbox — always a boolean, never null.
export function buildConfigPatch(
  raw: Record<string, string>,
  autoQuarantineEnabled: boolean
): Record<string, number | string | boolean | null> {
  const patch: Record<string, number | string | boolean | null> = {};
  for (const field of Object.keys(CONFIG_FIELD_SPECS)) {
    const v = (raw[field] ?? '').trim();
    patch[field] = v === '' ? null : Number(v);
  }
  const urlV = (raw.webhookUrl ?? '').trim();
  patch.webhookUrl = urlV === '' ? null : urlV;
  const kindV = (raw.webhookKind ?? '').trim();
  patch.webhookKind = kindV === '' ? null : kindV;
  patch.autoQuarantineEnabled = autoQuarantineEnabled;
  return patch;
}
