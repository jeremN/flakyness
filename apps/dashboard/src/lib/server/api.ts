import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { error, isHttpError } from '@sveltejs/kit';
import { SESSION_COOKIE } from '../session';
import type {
  Project,
  ProjectStats,
  FlakyTest,
  TestRun,
  RunDetail,
  TestHistory,
  TestTrend,
  AnalysisResponse,
} from '../../app.d';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

export class APIError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public endpoint: string
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export function createApi(sessionToken: string | null, clientIp: string | null) {
  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    // BOTH credentials, never one or the other. These are two independent
    // gates and a signed-in user must clear both: readAuth
    // (api middleware/auth.ts:192-229) decides whether the caller may read at
    // all, and when READ_TOKEN is set it looks ONLY at the Authorization
    // header — it has no session path, and it is mounted ahead of
    // resolveAccess on every read route. Sending the cookie alone therefore
    // 401s before scoping ever runs, so on a READ_TOKEN-hardened install
    // signing in would make the dashboard strictly worse than staying
    // anonymous.
    //
    // Sending both does not weaken team scoping: the API resolves the session
    // first and the bearer only as a fallback, the precedence rule stated at
    // middleware/access.ts:42-43 — "A user session outranks a bearer token
    // when both are present: the session is the more specific credential, and
    // the dashboard forwards both." This function is the "forwards both" half
    // of that contract.
    if (sessionToken) {
      headers.Cookie = `${SESSION_COOKIE}=${sessionToken}`;
    }
    if (privateEnv.READ_TOKEN) {
      headers.Authorization = `Bearer ${privateEnv.READ_TOKEN}`;
    }
    // Delta §D1.2. Set only when present: an empty X-Forwarded-For would key
    // every such request into one bucket instead of falling back to the
    // socket address, which is the opposite of the intent.
    if (clientIp) headers['X-Forwarded-For'] = clientIp;
    return headers;
  }

  async function fetchJson<T>(path: string): Promise<T> {
    try {
      // Server-only by construction: this module lives under $lib/server, which
      // SvelteKit refuses to bundle into client code. READ_TOKEN must never be
      // exposed to the browser, which is also why it is NOT prefixed PUBLIC_
      // (unlike PUBLIC_API_URL above).
      const headers = buildHeaders();

      const response = await fetch(`${API_URL}${path}`, { headers });

      // A 401 here means the API has READ_TOKEN set and this dashboard either
      // has none or has the wrong one. Without this branch the generic message
      // below would blame the network, sending the operator to debug
      // connectivity for a configuration problem.
      if (response.status === 401) {
        throw error(
          500,
          `The Flackyness API rejected this dashboard's read credentials for ${path}. ` +
            'The API has READ_TOKEN set; set the same value as READ_TOKEN in the ' +
            "dashboard's environment."
        );
      }

      if (!response.ok) {
        throw error(
          response.status >= 500 ? 502 : response.status,
          `API request failed (${response.status}) for ${path}`
        );
      }

      return response.json();
    } catch (err) {
      if (isHttpError(err)) {
        throw err;
      }
      // Network errors, etc.
      throw error(503, `Cannot reach the Flackyness API (${API_URL}). Is it running?`);
    }
  }

  return {
    async getProjects(): Promise<Project[]> {
      const data = await fetchJson<{ projects: Project[] }>('/api/v1/projects');
      return data.projects;
    },

    async getProjectStats(projectId: string): Promise<ProjectStats> {
      return fetchJson<ProjectStats>(`/api/v1/projects/${projectId}/stats`);
    },

    async getFlakyTests(
      projectId: string,
      status: string = 'active',
      limit: number = 100
    ): Promise<FlakyTest[]> {
      const data = await fetchJson<{ flakyTests: FlakyTest[] }>(
        `/api/v1/projects/${projectId}/flaky-tests?status=${status}&limit=${limit}`
      );
      return data.flakyTests;
    },

    async getProjectRuns(projectId: string, limit: number = 20): Promise<TestRun[]> {
      const data = await fetchJson<{ runs: TestRun[] }>(
        `/api/v1/projects/${projectId}/runs?limit=${limit}`
      );
      return data.runs;
    },

    async getRunDetail(projectId: string, runId: string, status?: string): Promise<RunDetail> {
      const query = status !== undefined ? `?status=${status}` : '';
      return fetchJson<RunDetail>(`/api/v1/projects/${projectId}/runs/${runId}${query}`);
    },

    async getTestHistory(testName: string, projectId: string): Promise<TestHistory> {
      const encodedName = encodeURIComponent(testName);
      return fetchJson<TestHistory>(`/api/v1/tests/${encodedName}/history?project=${projectId}`);
    },

    async getFlakeTrend(
      projectId: string,
      days: number = 7
    ): Promise<{ days: string[]; rates: (number | null)[] }> {
      return fetchJson<{ days: string[]; rates: (number | null)[] }>(
        `/api/v1/projects/${projectId}/trend?days=${days}`
      );
    },

    async getTestTrend(testName: string, projectId: string, days: number = 30): Promise<TestTrend> {
      const encodedName = encodeURIComponent(testName);
      return fetchJson<TestTrend>(
        `/api/v1/tests/${encodedName}/trend?project=${projectId}&days=${days}`
      );
    },

    async getAnalysis(
      projectId: string,
      days: number = 14,
      threshold: number = 0.05
    ): Promise<AnalysisResponse> {
      return fetchJson<AnalysisResponse>(
        `/api/v1/projects/${projectId}/analysis?days=${days}&threshold=${threshold}`
      );
    },

    /**
     * Mute or unmute a flaky test.
     *
     * Throws APIError rather than SvelteKit's error() — unlike every read above,
     * this is called from a form action, which must answer with fail() so the
     * message renders beside the form instead of replacing the page.
     */
    async setFlakyStatus(id: string, status: 'ignored' | 'active'): Promise<void> {
      const path = `/api/v1/tests/flaky/${id}`;
      let response: Response;
      try {
        response = await fetch(`${API_URL}${path}`, {
          method: 'PATCH',
          headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
      } catch {
        throw new APIError(503, `Cannot reach the Flackyness API (${API_URL}).`, path);
      }
      if (!response.ok) {
        throw new APIError(response.status, `Failed to update status`, path);
      }
    },
  };
}
