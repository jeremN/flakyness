import type { Context } from 'hono';

/** The machine-readable code of every request-validation 400. */
export const VALIDATION_FAILED = 'validation_failed';

export interface ValidationIssue {
  /** Dotted path to the offending field, `''` for the whole input. */
  path: string;
  message: string;
  /** Zod's issue code, e.g. `invalid_type`, `too_small`. */
  code: string;
}

/**
 * The part of a Zod error this module reads. Structural on purpose:
 * `@hono/zod-validator` hands the hook zod's core `$ZodError`, not the classic
 * `ZodError` class, and both carry `issues`.
 */
export interface ZodLikeError {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; code: string }>;
}

export interface ValidationErrorBody {
  error: string;
  code: typeof VALIDATION_FAILED;
  issues: ValidationIssue[];
}

const TARGET_LABEL: Record<string, string> = {
  json: 'request body',
  query: 'query string',
  param: 'path parameter',
  header: 'header',
  form: 'form body',
  cookie: 'cookie',
};

/**
 * The API's one shape for a request-validation 400 (backlog #25).
 *
 * `error` stays a string, like every other error in the API, so a client that
 * reads `body.error` as text keeps working. `issues` carries the detail.
 *
 * Each issue copies three named fields and nothing else. A Zod issue can carry
 * the rejected `input` when that option is on; a login or change-password
 * body holds a password, so the input must never reach the response.
 */
export function validationErrorBody(error: ZodLikeError, target: string): ValidationErrorBody {
  const issues: ValidationIssue[] = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
  const label = TARGET_LABEL[target] ?? target;
  const first = issues[0];
  const detail = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'invalid';
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  return { error: `Invalid ${label}: ${detail}${more}`, code: VALIDATION_FAILED, issues };
}

/**
 * The third argument of EVERY `zValidator(...)` call. Without it,
 * `@hono/zod-validator` answers with its own default shape, in which `error`
 * is an object, and a library bump could change the public contract with no
 * test failing. `validation-hook-coverage.test.ts` fails on a call site that
 * omits it.
 */
export function validationHook(
  result: { success: true } | { success: false; error: ZodLikeError; target: string },
  c: Context
): Response | undefined {
  if (result.success) return undefined;
  return c.json(validationErrorBody(result.error, result.target), 400);
}
