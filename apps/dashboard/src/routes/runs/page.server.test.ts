import { describe, it, expect, vi } from 'vitest';
import type { Project } from '../../app.d';

// Minimal by design: this route previously had no server-load test file at
// all. It is added now only to close the identity gap flagged in Task 2
// review (I1) — do not build out coverage for the rest of the route here.
vi.mock('$lib/server/api', () => ({
  createApi: vi.fn(),
}));

import { createApi } from '$lib/server/api';
import { load } from './+page.server';

const project: Project = { id: 'p1', name: 'Project A', createdAt: '2024-01-01', teamId: null };

const mockedGetProjectRuns = vi.fn();
vi.mocked(createApi).mockReturnValue({ getProjectRuns: mockedGetProjectRuns } as unknown as ReturnType<typeof createApi>);

describe('routes/runs/+page.server load', () => {
  // Distinct, both non-null: an argument swap (createApi(clientIp, sessionToken))
  // compiles clean since both are `string | null` — only a call-site assertion
  // with two distinguishable values catches it.
  it('builds the client from the request session, not a swapped pair', async () => {
    mockedGetProjectRuns.mockResolvedValue([]);

    await load({
      parent: async () => ({ selectedProject: project }),
      locals: { sessionToken: 'sess-1', clientIp: '203.0.113.7' },
    } as any);

    expect(createApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});
