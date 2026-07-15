<script lang="ts">
  import type { PageData } from './$types';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import { invalidateAll } from '$app/navigation';
  import { statusBadgeClass } from '$lib/status';

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

  function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  // `startedAt`/`finishedAt` are both nullable (a report can omit either) —
  // only compute a duration when both are present, rather than showing a
  // misleading number derived from one missing side.
  function runDurationMs(run: { startedAt: string | null; finishedAt: string | null }): number | null {
    if (!run.startedAt || !run.finishedAt) return null;
    return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  }
</script>

<svelte:head>
  <title>Run Detail | Flackyness</title>
</svelte:head>

{#if data.projectId}
  <a href="/runs?project={data.projectId}" class="inline-flex items-center gap-2 text-muted hover:text-gray-900 mb-6 transition-colors text-sm font-medium">
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
    </svg>
    Back to Test Runs
  </a>
{/if}

{#if !data.projectId}
  <div class="card p-12 flex flex-col items-center justify-center text-center">
    <div class="icon-circle icon-circle-purple mb-4 w-16 h-16 text-2xl">📭</div>
    <h3 class="text-lg font-semibold text-gray-900 mb-2">No Project Selected</h3>
    <p class="text-muted">Select a project to view this run.</p>
  </div>
{:else if data.loadFailed}
  <div class="card p-6">
    <ErrorState message="Couldn't load this run." onRetry={() => invalidateAll()} />
  </div>
{:else if data.runDetail}
  {@const run = data.runDetail.run}
  {@const showingAll = data.statusFilter === 'all'}

  <!-- Header -->
  <div class="mb-8">
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 mb-1">
          <span class="badge badge-purple font-mono">{run.branch}</span>
          <span class="font-mono text-muted text-lg ml-2">{run.commitSha.slice(0, 7)}</span>
        </h1>
        <p class="text-muted text-sm">
          Pipeline: {run.pipelineId || '—'} •
          Started: {formatDate(run.startedAt)} •
          Finished: {formatDate(run.finishedAt)} •
          Duration: {formatDuration(runDurationMs(run))}
        </p>
      </div>

      {#if showingAll}
        <a href="/runs/{run.id}?project={data.projectId}" class="pill-btn pill-btn-ghost text-sm">
          Show failures only
        </a>
      {:else}
        <a href="/runs/{run.id}?project={data.projectId}&status=all" class="pill-btn pill-btn-ghost text-sm">
          Show all results
        </a>
      {/if}
    </div>

    <div class="flex flex-wrap gap-2 mt-4">
      <span class="badge badge-green">{run.passed} passed</span>
      <span class="badge badge-red">{run.failed} failed</span>
      <span class="badge badge-orange">{run.flaky} flaky</span>
      <span class="badge badge-gray">{run.skipped} skipped</span>
    </div>
  </div>

  <!-- Results -->
  {#if data.runDetail.results.length === 0}
    <div class="card p-12 flex flex-col items-center justify-center text-center">
      <div class="icon-circle icon-circle-green mb-4 w-16 h-16 text-2xl">🎉</div>
      <h3 class="text-lg font-semibold text-gray-900 mb-2">No failures on this run</h3>
      <p class="text-muted">🎉 — all {run.passed} tests passed.</p>
    </div>
  {:else}
    <div class="card overflow-hidden">
      <div class="p-4 border-b border-subtle-light bg-gray-50">
        <h2 class="text-sm font-semibold text-muted uppercase tracking-wider">
          {showingAll ? 'All Results' : 'Failures & Flaky Results'}
        </h2>
      </div>

      <table class="w-full">
        <thead>
          <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light">
            <th class="py-3 px-4 font-medium">Status</th>
            <th class="py-3 px-4 font-medium">Test Name</th>
            <th class="py-3 px-4 font-medium">File</th>
            <th class="py-3 px-4 font-medium">Duration</th>
            <th class="py-3 px-4 font-medium">Retries</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each data.runDetail.results as result, i (result.testName + i)}
            <tr class="hover:bg-gray-50 transition-colors">
              <td class="py-4 px-4">
                <span class="badge {statusBadgeClass(result.status)} uppercase">
                  {result.status}
                </span>
                {#if result.tags && result.tags.length > 0}
                  {#each result.tags as tag}
                    <span class="badge badge-purple ml-1">{tag}</span>
                  {/each}
                {/if}
              </td>
              <td class="py-4 px-4 font-medium max-w-md">{result.testName}</td>
              <td class="py-4 px-4 font-mono text-muted text-sm">{result.testFile || '—'}</td>
              <td class="py-4 px-4 text-muted">{formatDuration(result.durationMs)}</td>
              <td class="py-4 px-4 text-muted">{result.retryCount ?? 0}</td>
            </tr>
            {#if result.failureDetail || result.errorMessage}
              <tr class="bg-red-50">
                <td colspan="5" class="py-3 px-4">
                  {#if result.failureDetail}
                    {#each result.failureDetail.errors as err, ei (ei)}
                      <div class="mb-2 last:mb-0">
                        {#if err.message || err.value}
                          <p class="text-red-600 text-xs font-mono whitespace-pre-wrap">{err.message || err.value}</p>
                        {/if}
                        {#if err.snippet}
                          <pre class="text-red-600 text-xs font-mono whitespace-pre-wrap mt-1">{err.snippet}</pre>
                        {/if}
                        {#if err.stack}
                          <details class="mt-1">
                            <summary class="text-xs text-muted cursor-pointer">Stack trace</summary>
                            <pre class="text-red-600 text-xs font-mono whitespace-pre-wrap mt-1">{err.stack}</pre>
                          </details>
                        {/if}
                      </div>
                    {/each}
                    {#if result.failureDetail.stdout}
                      <details class="mt-1">
                        <summary class="text-xs text-muted cursor-pointer">stdout</summary>
                        <pre class="text-muted text-xs font-mono whitespace-pre-wrap mt-1">{result.failureDetail.stdout}</pre>
                      </details>
                    {/if}
                    {#if result.failureDetail.stderr}
                      <details class="mt-1">
                        <summary class="text-xs text-muted cursor-pointer">stderr</summary>
                        <pre class="text-muted text-xs font-mono whitespace-pre-wrap mt-1">{result.failureDetail.stderr}</pre>
                      </details>
                    {/if}
                    {#if result.failureDetail.attachments && result.failureDetail.attachments.length > 0}
                      <div class="mt-2 text-xs text-muted">
                        <p class="font-medium mb-1">
                          Attachments (metadata only — the files themselves live in the CI job's artifacts):
                        </p>
                        <ul class="list-disc list-inside">
                          {#each result.failureDetail.attachments as att}
                            <li>{att.name} · {att.contentType}{att.path ? ` · ${att.path}` : ''}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}
                  {:else}
                    <pre class="text-red-600 text-xs font-mono whitespace-pre-wrap">{result.errorMessage}</pre>
                  {/if}
                </td>
              </tr>
            {/if}
            {#if result.annotations && result.annotations.length > 0}
              <tr class="bg-gray-50">
                <td colspan="5" class="py-2 px-4">
                  <div class="flex flex-col gap-1 text-xs text-muted">
                    {#each result.annotations as annotation}
                      <span><span class="font-medium">{annotation.type}</span>{annotation.description ? `: ${annotation.description}` : ''}</span>
                    {/each}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if data.runDetail.truncated}
    <p class="text-muted text-xs mt-4">
      Showing a capped subset of results — this run has more than the display limit.
    </p>
  {/if}

  <p class="text-muted text-xs mt-4">
    Flackyness stores each failure's error message, stack trace, code snippet, and captured
    stdout/stderr, plus attachment metadata (name, type, path) — but not the attachment files
    themselves; screenshots, videos, and traces still live in the CI job's artifacts. Runs
    recorded before this feature only have the error message shown above.
  </p>
{/if}
