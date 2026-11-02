import type { AuditReport } from './types';

export interface UploadTarget {
  apiUrl: string;
  token: string;
  branch?: string;
  commit?: string;
  pipeline?: string;
}

/** Regression shape returned by POST /api/v1/audits (see apps/api/src/services/audits.ts). */
export type Regression =
  | { kind: 'score'; url: string; device: string; category: string; previous: number; current: number }
  | {
      kind: 'new_issue';
      url: string;
      device: string;
      category: string;
      issueId: string;
      severity: string;
      message: string;
    }
  | { kind: 'metric'; url: string; device: string; category: string; metric: string; previous: number; current: number };

export interface UploadResponse {
  auditRun: { id: string; project: string; branch: string };
  previousRunId: string | null;
  regressions: Regression[];
}

export function buildUploadUrl({ apiUrl, branch, commit, pipeline }: Omit<UploadTarget, 'token'>): string {
  // RELATIVE path against a slash-terminated base, so a path prefix survives:
  // https://host/flaky -> https://host/flaky/api/v1/audits. An absolute
  // '/api/v1/audits' would silently drop it (and send the token to whatever
  // else is served at the host root).
  const url = new URL('api/v1/audits', apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
  if (branch) url.searchParams.set('branch', branch);
  if (commit) url.searchParams.set('commit', commit);
  if (pipeline) url.searchParams.set('pipeline', pipeline);
  return url.href;
}

export async function uploadReport(
  report: AuditReport,
  target: UploadTarget,
  fetchImpl: typeof fetch = fetch
): Promise<UploadResponse> {
  const res = await fetchImpl(buildUploadUrl(target), {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  });
  const text = await res.text();
  if (res.status !== 201) {
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Non-JSON error body (proxy page, etc.) — report it verbatim.
    }
    throw new Error(`Upload failed: HTTP ${res.status}: ${detail.slice(0, 500)}`);
  }
  return JSON.parse(text) as UploadResponse;
}
