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

  function getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'passed': return 'badge-green';
      case 'failed': return 'badge-red';
      case 'flaky': return 'badge-orange';
      case 'skipped': return 'badge-gray';
      default: return 'badge-gray';
    }
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const statCards = [
    { label: 'Total Runs', value: data.testHistory.stats.totalRuns, color: 'purple' },
    { label: 'Passed', value: data.testHistory.stats.passed, color: 'green' },
    { label: 'Failed', value: data.testHistory.stats.failed, color: 'red' },
    { label: 'Flaky', value: data.testHistory.stats.flaky, color: 'orange' },
    { label: 'Skipped', value: data.testHistory.stats.skipped, color: 'gray' },
    { label: 'Avg Duration', value: formatDuration(data.testHistory.stats.avgDuration), color: 'blue' },
  ];
</script>

<svelte:head>
  <title>{data.testHistory.testName} | Flackyness</title>
</svelte:head>

<!-- Back button -->
<a href="/flaky?project={data.projectId}" class="inline-flex items-center gap-2 text-muted hover:text-gray-900 mb-6 transition-colors text-sm font-medium">
  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
  </svg>
  Back to Flaky Tests
</a>

<!-- Header -->
<div class="mb-8">
  <h1 class="text-2xl font-bold text-gray-900 mb-1">{data.testHistory.testName}</h1>
  {#if data.testHistory.flakyInfo}
    <p class="text-muted font-mono text-sm">{data.testHistory.flakyInfo.testFile}</p>
  {/if}
</div>

<!-- Stats -->
<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
  {#each statCards as stat}
    <div class="card p-4">
      <div class="text-2xl font-bold text-gray-900 mb-1 {stat.color === 'green' ? 'text-green-600' : stat.color === 'red' ? 'text-red-600' : stat.color === 'orange' ? 'text-orange-600' : stat.color === 'gray' ? 'text-gray-400' : ''}">
        {stat.value}
      </div>
      <div class="text-sm text-muted">{stat.label}</div>
    </div>
  {/each}
</div>

<!-- Flaky Info -->
{#if data.testHistory.flakyInfo}
  <div class="card p-6 mb-8 border-l-4 border-l-orange-500">
    <div class="flex items-center gap-3">
      <div class="icon-circle icon-circle-orange">
        ⚡
      </div>
      <div>
        <h2 class="font-semibold text-gray-900">This test is marked as flaky</h2>
        <p class="text-muted text-sm">
          Flake rate: <span class="font-semibold text-orange-600">{(parseFloat(data.testHistory.flakyInfo.flakeRate) * 100).toFixed(1)}%</span> • 
          First detected: {formatDate(data.testHistory.flakyInfo.firstDetected)}
        </p>
      </div>
    </div>
  </div>
{/if}

<!-- Run History -->
<div class="card overflow-hidden">
  <div class="p-4 border-b border-subtle-light bg-gray-50">
    <h2 class="text-sm font-semibold text-muted uppercase tracking-wider">Run History</h2>
  </div>
  
  <table class="w-full">
    <thead>
      <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light">
        <th class="py-3 px-4 font-medium">Status</th>
        <th class="py-3 px-4 font-medium">Branch</th>
        <th class="py-3 px-4 font-medium">Commit</th>
        <th class="py-3 px-4 font-medium">Duration</th>
        <th class="py-3 px-4 font-medium">Retries</th>
        <th class="py-3 px-4 font-medium">Date</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-gray-100">
      {#each data.testHistory.history as run}
        <tr class="hover:bg-gray-50 transition-colors">
          <td class="py-4 px-4">
            <span class="badge {getStatusBadgeClass(run.status)} uppercase">
              {run.status}
            </span>
          </td>
          <td class="py-4 px-4 font-mono text-sm font-medium">{run.branch}</td>
          <td class="py-4 px-4 font-mono text-muted text-sm">{run.commitSha.slice(0, 7)}</td>
          <td class="py-4 px-4 text-muted">{formatDuration(run.durationMs)}</td>
          <td class="py-4 px-4 text-muted">{run.retryCount}</td>
          <td class="py-4 px-4 text-muted text-sm">{formatDate(run.createdAt)}</td>
        </tr>
        {#if run.errorMessage}
          <tr class="bg-red-50">
            <td colspan="6" class="py-3 px-4">
              <pre class="text-red-600 text-xs font-mono whitespace-pre-wrap">{run.errorMessage}</pre>
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
</div>
