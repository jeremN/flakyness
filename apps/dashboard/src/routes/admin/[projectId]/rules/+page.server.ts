import type { PageServerLoad, Actions } from './$types';
import { error, fail } from '@sveltejs/kit';
import {
  listRules,
  createRule,
  patchRule,
  deleteRule,
  reorderRules,
  adminConfigured,
  AdminApiError,
  MissingAdminTokenError,
} from '$lib/server/adminApi';
import { validateRuleForm, buildRulePayload } from '$lib/rules-validation';

export const load: PageServerLoad = async ({ params, parent }) => {
  if (!adminConfigured()) throw error(403, 'ADMIN_TOKEN not set.');

  // Reuse the project list the root layout already fetched via the PUBLIC api
  // (+layout.server.ts) instead of spending an admin API call on a second list:
  // the admin console runs entirely from one server IP, so a gratuitous admin
  // call is exactly the per-IP pressure the rate-limit work addressed. Both
  // endpoints enumerate every project, so the id set is identical.
  const { projects, apiError } = await parent();
  // Distinguish "API unreachable" (empty list because the public fetch failed)
  // from a genuinely-missing project, so a down API doesn't masquerade as a 404.
  if (apiError) throw error(502, apiError);
  const project = projects.find((p) => p.id === params.projectId);
  if (!project) throw error(404, 'Project not found');

  let rules;
  try {
    ({ rules } = await listRules(params.projectId));
  } catch (e) {
    const status = e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load rules');
  }

  return { project, rules };
};

// Maps an adminApi throw to the right `fail`, tagged with the action name so
// the page can route feedback to the correct spot.
function actionError(action: string, e: unknown) {
  if (e instanceof MissingAdminTokenError) return fail(403, { action, message: e.message });
  if (e instanceof AdminApiError) return fail(e.statusCode, { action, message: e.message });
  return fail(502, { action, message: 'Unexpected error contacting the API.' });
}

// Every string field the rule form submits. Collected into a flat record so
// validateRuleForm / buildRulePayload can operate on it.
const RULE_FIELDS = [
  'name', 'selectorBranch', 'selectorFile', 'selectorTag',
  'action', 'conditionType', 'flakeThreshold', 'minRuns',
  'windowDays', 'consecutiveFailures', 'ttlDays',
];

function readRuleForm(form: FormData): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const f of RULE_FIELDS) raw[f] = String(form.get(f) ?? '');
  return raw;
}

export const actions = {
  create: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'create', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const raw = readRuleForm(form);
    const { valid, errors } = validateRuleForm(raw);
    if (!valid) return fail(400, { action: 'create', errors });
    try {
      await createRule(params.projectId, buildRulePayload(raw, form.get('enabled') != null));
      return { action: 'create', success: true };
    } catch (e) {
      return actionError('create', e);
    }
  },

  update: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'update', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'update', message: 'Missing rule id.' });
    const raw = readRuleForm(form);
    const { valid, errors } = validateRuleForm(raw);
    if (!valid) return fail(400, { action: 'update', errors });
    try {
      await patchRule(params.projectId, ruleId, buildRulePayload(raw, form.get('enabled') != null));
      return { action: 'update', success: true };
    } catch (e) {
      return actionError('update', e);
    }
  },

  toggle: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'toggle', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'toggle', message: 'Missing rule id.' });
    const enabled = String(form.get('enabled') ?? '') === 'true';
    try {
      await patchRule(params.projectId, ruleId, { enabled });
      return { action: 'toggle', success: true };
    } catch (e) {
      return actionError('toggle', e);
    }
  },

  delete: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'delete', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'delete', message: 'Missing rule id.' });
    try {
      await deleteRule(params.projectId, ruleId);
      return { action: 'delete', success: true };
    } catch (e) {
      return actionError('delete', e);
    }
  },

  reorder: async ({ request, params }) => {
    if (!adminConfigured()) return fail(403, { action: 'reorder', message: 'ADMIN_TOKEN not set.' });
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    const direction = String(form.get('direction') ?? '');
    if (ruleId === '' || (direction !== 'up' && direction !== 'down')) {
      return fail(400, { action: 'reorder', message: 'Invalid reorder request.' });
    }

    // Source the current order server-side — the reorder API demands the exact
    // current id set, so a stale client order can't be trusted.
    let order: string[];
    try {
      const { rules } = await listRules(params.projectId);
      order = rules.map((r) => r.id);
    } catch (e) {
      return actionError('reorder', e);
    }

    const idx = order.indexOf(ruleId);
    if (idx === -1) return fail(400, { action: 'reorder', message: 'Rule not found.' });
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= order.length) {
      // Already at the end in that direction — guarded no-op, no API call.
      return { action: 'reorder', success: true };
    }
    [order[idx], order[swapWith]] = [order[swapWith], order[idx]];

    try {
      await reorderRules(params.projectId, order);
      return { action: 'reorder', success: true };
    } catch (e) {
      return actionError('reorder', e);
    }
  },
} satisfies Actions;
