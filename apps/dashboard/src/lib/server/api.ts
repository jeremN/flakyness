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
  async function fetchJson<T>(path: string): Promise<T> {
    try {
      // Server-only by construction: this module lives under $lib/server, which
      // SvelteKit refuses to bundle into client code. READ_TOKEN must never be
      // exposed to the browser, which is also why it is NOT prefixed PUBLIC_
      // (unlike PUBLIC_API_URL above).
      const headers: Record<string, string> = {};
      if (sessionToken) {
        headers.Cookie = `${SESSION_COOKIE}=${sessionToken}`;
      } else if (privateEnv.READ_TOKEN) {
        headers.Authorization = `Bearer ${privateEnv.READ_TOKEN}`;
      }
      // Delta §D1.2. Set only when present: an empty X-Forwarded-For would key
      // every such request into one bucket instead of falling back to the
      // socket address, which is the opposite of the intent.
      if (clientIp) headers['X-Forwarded-For'] = clientIp;

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
  };
}
