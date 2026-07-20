import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { getFlakyTests } from '$lib/server/api';

export const load: PageServerLoad = async ({ url, parent }) => {
  const { selectedProject } = await parent();

  if (!selectedProject) {
    return { flakyTests: [], currentProject: null, status: 'active', canMute: Boolean(env.ADMIN_TOKEN) };
  }

  const status = url.searchParams.get('status') || 'active';
  const flakyTests = await getFlakyTests(selectedProject.id, status);

  return {
    flakyTests,
    currentProject: selectedProject,
    status,
    canMute: Boolean(env.ADMIN_TOKEN),
  };
};

export const actions = {
  setStatus: async ({ request }) => {
    if (!env.ADMIN_TOKEN) return fail(403, { message: 'Muting is not configured' });
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    const status = String(form.get('status') ?? '');
    if (!id || (status !== 'ignored' && status !== 'active')) {
      return fail(400, { message: 'Invalid request' });
    }
    const apiUrl = publicEnv.PUBLIC_API_URL || 'http://localhost:8080';
    const res = await fetch(`${apiUrl}/api/v1/tests/flaky/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return fail(res.status === 404 ? 404 : 502, { message: 'Failed to update status' });
    return { success: true };
  },
} satisfies Actions;
