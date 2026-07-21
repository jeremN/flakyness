<script lang="ts">
  import type { PageData } from './$types';
  import { formatDate } from '$lib/format';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head>
  <title>Analysis | Flackyness</title>
</svelte:head>

<!-- Header -->
<div class="mb-8">
  <h1 class="text-2xl font-bold text-gray-900 mb-1">Analysis</h1>
  {#if data.currentProject}
    <p class="text-muted">Project: {data.currentProject.name}</p>
  {/if}
</div>

<!-- Controls -->
<div class="card p-6 mb-6">
  <form method="GET" class="flex flex-wrap items-end gap-4">
    {#if data.currentProject}
      <input type="hidden" name="project" value={data.currentProject.id} />
    {/if}
    <div>
      <label for="days" class="block text-xs text-muted uppercase tracking-wider mb-2 font-medium">
        Window (days)
      </label>
      <input
        id="days"
        name="days"
        type="number"
        min="1"
        max="90"
        value={data.days}
        class="w-32 bg-white border border-subtle rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
      />
    </div>
    <div>
      <label for="threshold" class="block text-xs text-muted uppercase tracking-wider mb-2 font-medium">
        Threshold
      </label>
      <input
        id="threshold"
        name="threshold"
        type="number"
        min="0"
        max="1"
        step="0.01"
        value={data.threshold}
        class="w-32 bg-white border border-subtle rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
      />
    </div>
    <button type="submit" class="pill-btn pill-btn-primary">
      Analyze
    </button>
  </form>
</div>

{#if !data.analysis}
  <div class="card p-12 flex flex-col items-center justify-center text-center">
    <div class="icon-circle icon-circle-purple mb-4 w-16 h-16 text-2xl">📭</div>
    <h3 class="text-lg font-semibold text-gray-900 mb-2">No Project Selected</h3>
    <p class="text-muted">Select a project to run a real-time flakiness analysis.</p>
  </div>
{:else}
  <p class="text-muted mb-4">
    {data.analysis.flakyTests.length} of {data.analysis.allTests.length} tests flaky at &ge;{(data.analysis.threshold * 100).toFixed(0)}% over {data.analysis.windowDays} days
  </p>

  {#if data.analysis.allTests.length === 0}
    <div class="card p-12 flex flex-col items-center justify-center text-center">
      <div class="icon-circle icon-circle-green mb-4 w-16 h-16 text-2xl">🎉</div>
      <h3 class="text-lg font-semibold text-gray-900 mb-2">No tests found.</h3>
      <p class="text-muted">No test runs fall within this window yet.</p>
    </div>
  {:else}
    <div class="card overflow-hidden">
      <table class="w-full">
        <thead>
          <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light bg-gray-50">
            <th class="py-4 px-4 font-medium">Test Name</th>
            <th class="py-4 px-4 font-medium">File</th>
            <th class="py-4 px-4 font-medium">Runs</th>
            <th class="py-4 px-4 font-medium">Passed</th>
            <th class="py-4 px-4 font-medium">Failed</th>
            <th class="py-4 px-4 font-medium">Flaky</th>
            <th class="py-4 px-4 font-medium">Flake Rate</th>
            <th class="py-4 px-4 font-medium">Last Seen</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each data.analysis.allTests as test}
            <tr class="hover:bg-gray-50 transition-colors">
              <td class="py-4 px-4 max-w-md">
                <a
                  href="/tests/{encodeURIComponent(test.testName)}?project={data.currentProject?.id}"
                  class="text-purple-600 hover:text-purple-700 font-medium hover:underline"
                >
                  {test.testName}
                </a>
                {#if test.isFlaky}
                  <span class="badge badge-orange ml-2 uppercase">Flaky</span>
                {/if}
              </td>
              <td class="py-4 px-4 text-muted font-mono text-sm max-w-xs truncate">
                {test.testFile}
              </td>
              <td class="py-4 px-4 text-muted">
                {test.totalRuns}
              </td>
              <td class="py-4 px-4 text-muted">
                {test.passCount}
              </td>
              <td class="py-4 px-4 text-muted">
                {test.failCount}
              </td>
              <td class="py-4 px-4 text-muted">
                {test.flakyCount}
              </td>
              <td class="py-4 px-4">
                <div class="flex items-center gap-3">
                  <div class="w-16 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                    <div
                      class="bg-orange-500 h-full rounded-full"
                      style="width: {Math.min(test.flakeRate * 100, 100)}%"
                    ></div>
                  </div>
                  <span class="text-sm font-semibold text-gray-900">
                    {(test.flakeRate * 100).toFixed(1)}%
                  </span>
                </div>
              </td>
              <td class="py-4 px-4 text-muted text-sm">
                {formatDate(test.lastSeen)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}
