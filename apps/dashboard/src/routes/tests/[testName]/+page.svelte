<script lang="ts">
  import type { PageData } from './$types';
  import Chart from '$lib/components/Chart.svelte';
  import ErrorState from '$lib/components/ErrorState.svelte';
  import { invalidateAll } from '$app/navigation';
  import type { EChartsOption } from 'echarts';
  import type { TrendDirection } from '../../../app.d';
  import { statusBadgeClass as getStatusBadgeClass } from '$lib/status';

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

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const statCards = $derived([
    { label: 'Total Runs', value: data.testHistory.stats.totalRuns, color: 'purple' },
    { label: 'Passed', value: data.testHistory.stats.passed, color: 'green' },
    { label: 'Failed', value: data.testHistory.stats.failed, color: 'red' },
    { label: 'Flaky', value: data.testHistory.stats.flaky, color: 'orange' },
    { label: 'Skipped', value: data.testHistory.stats.skipped, color: 'gray' },
    { label: 'Avg Duration', value: formatDuration(data.testHistory.stats.avgDuration), color: 'blue' },
  ]);

  // Rendered honestly, including 'insufficient-data' — it is not the same
  // claim as 'stable' (see plans/028-honest-visible-trends.md design
  // decision 4) and must never be disguised as one.
  const DIRECTION_LABEL: Record<TrendDirection, string> = {
    improving: '↓ Improving',
    worsening: '↑ Worsening',
    stable: '→ Stable',
    'insufficient-data': 'Insufficient data',
  };

  const DIRECTION_BADGE_CLASS: Record<TrendDirection, string> = {
    improving: 'badge-green',
    worsening: 'badge-red',
    stable: 'badge-gray',
    'insufficient-data': 'badge-gray',
  };

  // A day with no runs (`flakeRate: null`) must render as a gap in the
  // line, not a flat 0% — that flat line is exactly the lie plan 028 exists
  // to remove. `connectNulls` is left at its default (false/unset) so
  // ECharts breaks the line across the gap instead of bridging it.
  const trendChartOptions: EChartsOption = $derived(data.testTrend ? {
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#e5e7eb',
      textStyle: { color: '#1f2937' },
      formatter: (params: unknown) => {
        const p = params as Array<{ name: string; value: number | null }>;
        const value = p[0]?.value ?? null;
        return `${p[0].name}<br/>Flake Rate: <b>${value === null ? 'no runs' : `${value}%`}</b>`;
      },
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      top: '10%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: data.testTrend.trend.map((bucket) => bucket.date),
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisLabel: { color: '#6b7280' },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        formatter: '{value}%',
        color: '#6b7280',
      },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#f3f4f6' } },
      min: 0,
    },
    series: [
      {
        name: 'Flake Rate',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: {
          color: '#f97316',
          width: 3,
        },
        itemStyle: {
          color: '#f97316',
          borderColor: '#fff',
          borderWidth: 2,
        },
        data: data.testTrend.trend.map((bucket) =>
          bucket.flakeRate === null ? null : Math.round(bucket.flakeRate * 1000) / 10
        ),
      },
    ],
  } : {});
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

<!-- Flake Rate Trend -->
{#if data.testTrend}
  <div class="card p-6 mb-8">
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-sm font-semibold text-muted uppercase tracking-wider">
        Flake Rate Trend ({data.testTrend.days} Days)
      </h2>
      <span class="badge {DIRECTION_BADGE_CLASS[data.testTrend.direction]}">
        {DIRECTION_LABEL[data.testTrend.direction]}
      </span>
    </div>
    <Chart options={trendChartOptions} height="240px" />
  </div>
{:else if data.trendFailed}
  <div class="card p-6 mb-8">
    <h2 class="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Flake Rate Trend</h2>
    <ErrorState message="Couldn't load the flake-rate trend." onRetry={() => invalidateAll()} />
  </div>
{/if}

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
            {#if run.tags && run.tags.length > 0}
              {#each run.tags as tag}
                <span class="badge badge-purple ml-1">{tag}</span>
              {/each}
            {/if}
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
        {#if run.annotations && run.annotations.length > 0}
          <tr class="bg-gray-50">
            <td colspan="6" class="py-2 px-4">
              <div class="flex flex-col gap-1 text-xs text-muted">
                {#each run.annotations as annotation}
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
