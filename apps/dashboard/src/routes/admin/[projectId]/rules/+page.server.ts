import type { PageServerLoad, Actions } from './$types';
import { error, fail } from '@sveltejs/kit';
import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';
import { validateRuleForm, buildRulePayload } from '$lib/rules-validation';

export const load: PageServerLoad = async ({ params, parent, locals }) => {
  const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);

  // Reuse the project list the root layout already fetched via the PUBLIC api
  // (+layout.server.ts) instead of spending an admin API call on a second list:
  // the admin console runs entirely from one server IP, so a gratuitous admin
  // call is exactly the per-IP pressure the rate-limit work addressed. Both
  // endpoints enumerate every project, so the id set is identical.
  //
  // Ordering note (Task 2 review, I1/M1): this runs — and can 404 on an
  // unknown project id — *before* `adminApi.listRules` below gets a chance to
  // reject with NotAuthenticatedError for a caller with no session, so a
  // request's status depends on whether the project exists: 404 for an unknown
  // id, 403 for a real one.
  //
  // That ordering IS correct, as of Task 3 (landed in 60a424d). It reads like
  // an existence oracle only if an anonymous caller can reach this load with an
  // unscoped project list — and neither half holds any more: `hooks.server.ts`
  // redirects anonymous traffic before `load` ever runs, and `parent()`'s
  // `getProjects()` is now team-scoped. So 404-before-403 is the right
  // existence-hiding answer here, the same convention the API itself uses.
  //
  // Do not reorder this to check auth first; that would just move the guard
  // back to a synchronous `locals.sessionToken` check this task deliberately
  // avoided (see NotAuthenticatedError's docstring in adminApi.ts).
  const { projects, apiError } = await parent();
  // Distinguish "API unreachable" (empty list because the public fetch failed)
  // from a genuinely-missing project, so a down API doesn't masquerade as a 404.
  if (apiError) throw error(502, apiError);
  const project = projects.find((p) => p.id === params.projectId);
  if (!project) throw error(404, 'Project not found');

  let rules;
  try {
    ({ rules } = await adminApi.listRules(params.projectId));
  } catch (e) {
    const status = e instanceof NotAuthenticatedError ? 403 : e instanceof AdminApiError ? e.statusCode : 502;
    throw error(status, e instanceof Error ? e.message : 'Failed to load rules');
  }

  return { project, rules };
};

// Maps an adminApi throw to the right `fail`, tagged with the action name so
// the page can route feedback to the correct spot.
function actionError(action: string, e: unknown) {
  if (e instanceof NotAuthenticatedError) return fail(403, { action, message: e.message });
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
  create: async ({ request, params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    const form = await request.formData();
    const raw = readRuleForm(form);
    const { valid, errors } = validateRuleForm(raw);
    if (!valid) return fail(400, { action: 'create', errors });
    try {
      await adminApi.createRule(params.projectId, buildRulePayload(raw, form.get('enabled') != null));
      return { action: 'create', success: true };
    } catch (e) {
      return actionError('create', e);
    }
  },

  update: async ({ request, params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'update', message: 'Missing rule id.' });
    const raw = readRuleForm(form);
    const { valid, errors } = validateRuleForm(raw);
    if (!valid) return fail(400, { action: 'update', errors });
    try {
      await adminApi.patchRule(params.projectId, ruleId, buildRulePayload(raw, form.get('enabled') != null));
      return { action: 'update', success: true };
    } catch (e) {
      return actionError('update', e);
    }
  },

  toggle: async ({ request, params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'toggle', message: 'Missing rule id.' });
    const enabled = String(form.get('enabled') ?? '') === 'true';
    try {
      await adminApi.patchRule(params.projectId, ruleId, { enabled });
      return { action: 'toggle', success: true };
    } catch (e) {
      return actionError('toggle', e);
    }
  },

  delete: async ({ request, params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
    const form = await request.formData();
    const ruleId = String(form.get('ruleId') ?? '');
    if (ruleId === '') return fail(400, { action: 'delete', message: 'Missing rule id.' });
    try {
      await adminApi.deleteRule(params.projectId, ruleId);
      return { action: 'delete', success: true };
    } catch (e) {
      return actionError('delete', e);
    }
  },

  reorder: async ({ request, params, locals }) => {
    const adminApi = createAdminApi(locals.sessionToken, locals.clientIp);
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
      const { rules } = await adminApi.listRules(params.projectId);
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
      await adminApi.reorderRules(params.projectId, order);
      return { action: 'reorder', success: true };
    } catch (e) {
      return actionError('reorder', e);
    }
  },
} satisfies Actions;
