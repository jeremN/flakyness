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
      year: 'numeric',
    });
  }

  function getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'active': return 'badge-orange';
      case 'resolved': return 'badge-green';
      case 'ignored': return 'badge-gray';
      default: return 'badge-gray';
    }
  }

  function getFilterHref(status: string): string {
    const base = `/flaky?status=${status}`;
    if (data.currentProject) {
      return `${base}&project=${data.currentProject.id}`;
    }
    return base;
  }
</script>

<svelte:head>
  <title>Flaky Tests | Flackyness</title>
</svelte:head>

<!-- Header -->
<div class="mb-8">
  <h1 class="text-2xl font-bold text-gray-900 mb-1">Flaky Tests</h1>
  {#if data.currentProject}
    <p class="text-muted">Project: {data.currentProject.name}</p>
  {/if}
</div>

<!-- Filters -->
<div class="flex gap-2 mb-6">
  <a 
    href={getFilterHref('active')}
    class="pill-btn {data.status === 'active' ? 'pill-btn-primary' : 'pill-btn-ghost'}"
  >
    Active
  </a>
  <a 
    href={getFilterHref('resolved')}
    class="pill-btn {data.status === 'resolved' ? 'pill-btn-primary' : 'pill-btn-ghost'}"
  >
    Resolved
  </a>
  <a 
    href={getFilterHref('all')}
    class="pill-btn {data.status === 'all' ? 'pill-btn-primary' : 'pill-btn-ghost'}"
  >
    All
  </a>
</div>

{#if data.flakyTests.length === 0}
  <div class="card p-12 flex flex-col items-center justify-center text-center">
    <div class="icon-circle icon-circle-green mb-4 w-16 h-16 text-2xl">🎉</div>
    <h3 class="text-lg font-semibold text-gray-900 mb-2">
      {#if data.status === 'active'}
        No active flaky tests!
      {:else}
        No flaky tests found.
      {/if}
    </h3>
    <p class="text-muted">Your test suite is looking healthy.</p>
  </div>
{:else}
  <div class="card overflow-hidden">
    <table class="w-full">
      <thead>
        <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light bg-gray-50">
          <th class="py-4 px-4 font-medium">Test Name</th>
          <th class="py-4 px-4 font-medium">File</th>
          <th class="py-4 px-4 font-medium">Flake Rate</th>
          <th class="py-4 px-4 font-medium">Runs</th>
          <th class="py-4 px-4 font-medium">First Detected</th>
          <th class="py-4 px-4 font-medium">Last Seen</th>
          <th class="py-4 px-4 font-medium">Status</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each data.flakyTests as test}
          <tr class="hover:bg-gray-50 transition-colors">
            <td class="py-4 px-4 max-w-md">
              <a 
                href="/tests/{encodeURIComponent(test.testName)}?project={data.currentProject?.id}" 
                class="text-purple-600 hover:text-purple-700 font-medium hover:underline"
              >
                {test.testName}
              </a>
            </td>
            <td class="py-4 px-4 text-muted font-mono text-sm max-w-xs truncate">
              {test.testFile}
            </td>
            <td class="py-4 px-4">
              <div class="flex items-center gap-3">
                <div class="w-16 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                  <div 
                    class="bg-orange-500 h-full rounded-full" 
                    style="width: {Math.min(parseFloat(test.flakeRate) * 100, 100)}%"
                  ></div>
                </div>
                <span class="text-sm font-semibold text-gray-900">
                  {(parseFloat(test.flakeRate) * 100).toFixed(1)}%
                </span>
              </div>
            </td>
            <td class="py-4 px-4 text-muted">
              {test.totalRuns}
            </td>
            <td class="py-4 px-4 text-muted text-sm">
              {formatDate(test.firstDetected)}
            </td>
            <td class="py-4 px-4 text-muted text-sm">
              {formatDate(test.lastSeen)}
            </td>
            <td class="py-4 px-4">
              <span class="badge {getStatusBadgeClass(test.status)} uppercase">
                {test.status}
              </span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
