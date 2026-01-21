import { env } from '$env/dynamic/public';
import type { Project, ProjectStats, FlakyTest, TestRun, TestHistory } from '../app.d';

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

async function fetchJson<T>(path: string): Promise<T> {
  try {
    const response = await fetch(`${API_URL}${path}`);
    
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new APIError(
        response.status,
        `API request failed: ${response.statusText}. ${errorBody}`,
        path
      );
    }
    
    return response.json();
  } catch (error) {
    if (error instanceof APIError) {
      throw error;
    }
    // Network errors, etc.
    throw new APIError(0, `Failed to connect to API: ${error instanceof Error ? error.message : 'Unknown error'}`, path);
  }
}

export async function getProjects(): Promise<Project[]> {
  const data = await fetchJson<{ projects: Project[] }>('/api/v1/projects');
  return data.projects;
}

export async function getProjectStats(projectId: string): Promise<ProjectStats> {
  return fetchJson<ProjectStats>(`/api/v1/projects/${projectId}/stats`);
}

export async function getFlakyTests(
  projectId: string,
  status: string = 'active'
): Promise<FlakyTest[]> {
  const data = await fetchJson<{ flakyTests: FlakyTest[] }>(
    `/api/v1/projects/${projectId}/flaky-tests?status=${status}`
  );
  return data.flakyTests;
}

export async function getProjectRuns(
  projectId: string,
  limit: number = 20
): Promise<TestRun[]> {
  const data = await fetchJson<{ runs: TestRun[] }>(
    `/api/v1/projects/${projectId}/runs?limit=${limit}`
  );
  return data.runs;
}

export async function getTestHistory(
  testName: string,
  projectId: string
): Promise<TestHistory> {
  const encodedName = encodeURIComponent(testName);
  return fetchJson<TestHistory>(
    `/api/v1/tests/${encodedName}/history?project=${projectId}`
  );
}
