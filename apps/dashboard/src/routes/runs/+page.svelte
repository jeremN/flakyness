<script lang="ts">
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  function formatDate(dateString: string | null): string {
    if (!dateString) return '—';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getPassRate(run: { passed: number; totalTests: number }): number {
    if (run.totalTests === 0) return 0;
    return (run.passed / run.totalTests) * 100;
  }

  function getPassRateClass(passRate: number): string {
    if (passRate >= 90) return 'badge-green';
    if (passRate >= 70) return 'badge-orange';
    return 'badge-red';
  }
</script>

<svelte:head>
  <title>Test Runs | Flackyness</title>
</svelte:head>

<!-- Header -->
<div class="mb-8">
  <h1 class="text-2xl font-bold text-gray-900 mb-1">Test Runs</h1>
  {#if data.currentProject}
    <p class="text-muted">Project: {data.currentProject.name}</p>
  {/if}
</div>

{#if data.runs.length === 0}
  <div class="card p-12 flex flex-col items-center justify-center text-center">
    <div class="icon-circle icon-circle-blue mb-4 w-16 h-16 text-2xl">🧪</div>
    <h3 class="text-lg font-semibold text-gray-900 mb-2">No Test Runs Yet</h3>
    <p class="text-muted">Submit your first Playwright report to see results here.</p>
  </div>
{:else}
  <div class="card overflow-hidden">
    <table class="w-full">
      <thead>
        <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light bg-gray-50">
          <th class="py-4 px-4 font-medium">Branch</th>
          <th class="py-4 px-4 font-medium">Commit</th>
          <th class="py-4 px-4 font-medium">Pipeline</th>
          <th class="py-4 px-4 font-medium">Pass Rate</th>
          <th class="py-4 px-4 font-medium">Total</th>
          <th class="py-4 px-4 font-medium">Passed</th>
          <th class="py-4 px-4 font-medium">Failed</th>
          <th class="py-4 px-4 font-medium">Flaky</th>
          <th class="py-4 px-4 font-medium">Date</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each data.runs as run}
          {@const passRate = getPassRate(run)}
          <tr class="hover:bg-gray-50 transition-colors">
            <td class="py-4 px-4">
              <span class="badge badge-purple font-mono">
                {run.branch}
              </span>
            </td>
            <td class="py-4 px-4 font-mono text-muted text-sm">
              {run.commitSha.slice(0, 7)}
            </td>
            <td class="py-4 px-4 text-muted text-sm">
              {run.pipelineId || '—'}
            </td>
            <td class="py-4 px-4">
              <div class="flex items-center gap-3">
                <div class="w-16 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                  <div 
                    class="h-full rounded-full transition-all {passRate >= 90 ? 'bg-green-500' : passRate >= 70 ? 'bg-yellow-500' : 'bg-red-500'}" 
                    style="width: {passRate}%"
                  ></div>
                </div>
                <span class="text-sm font-semibold {passRate >= 90 ? 'text-green-600' : passRate >= 70 ? 'text-yellow-600' : 'text-red-600'}">
                  {passRate.toFixed(0)}%
                </span>
              </div>
            </td>
            <td class="py-4 px-4 font-medium">{run.totalTests}</td>
            <td class="py-4 px-4">
              <span class="badge badge-green">{run.passed}</span>
            </td>
            <td class="py-4 px-4">
              <span class="badge badge-red">{run.failed}</span>
            </td>
            <td class="py-4 px-4">
              <span class="badge badge-orange">{run.flaky}</span>
            </td>
            <td class="py-4 px-4 text-muted text-sm">{formatDate(run.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
