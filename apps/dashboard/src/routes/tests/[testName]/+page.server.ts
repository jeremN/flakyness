import type { PageServerLoad } from './$types';
import { getTestHistory } from '$lib/api';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ params, url }) => {
  const testName = decodeURIComponent(params.testName);
  const projectId = url.searchParams.get('project');

  if (!projectId) {
    throw error(400, 'Project ID is required');
  }

  const testHistory = await getTestHistory(testName, projectId);

  return {
    testHistory,
    projectId,
  };
};
