<script lang="ts">
  import type { PageData } from './$types';
  import Chart from '$lib/components/Chart.svelte';
  import type { EChartsOption } from 'echarts';

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

  // Chart configuration for flake rate trend - updated for light theme
  const chartOptions: EChartsOption = data.trendData ? {
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#e5e7eb',
      textStyle: { color: '#1f2937' },
      formatter: (params: unknown) => {
        const p = params as Array<{ name: string; value: number }>;
        return `${p[0].name}<br/>Flake Rate: <b>${p[0].value}%</b>`;
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
      data: data.trendData.days,
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
        symbolSize: 8,
        lineStyle: {
          color: '#f97316',
          width: 3,
        },
        itemStyle: {
          color: '#f97316',
          borderColor: '#fff',
          borderWidth: 2,
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(249, 115, 22, 0.2)' },
              { offset: 1, color: 'rgba(249, 115, 22, 0.02)' },
            ],
          },
        },
        data: data.trendData.rates,
      },
    ],
  } : {};

  const statCards = data.stats ? [
    { label: 'Active Flaky Tests', value: data.stats.activeFlakyTests, icon: '⚡', color: 'orange' },
    { label: 'Resolved This Week', value: data.stats.resolvedThisWeek, icon: '✓', color: 'green' },
    { label: 'Total Test Runs', value: data.stats.totalRuns, icon: '🧪', color: 'blue' },
    { label: 'Total Tests Tracked', value: data.stats.totalTests, icon: '📊', color: 'purple' },
  ] : [];
</script>

<svelte:head>
  <title>Overview | Flackyness</title>
</svelte:head>

<!-- Header -->
<div class="mb-8">
  <h1 class="text-2xl font-bold text-gray-900 mb-1">Dashboard Overview</h1>
  {#if data.stats}
    <p class="text-muted">Project: {data.stats.project.name}</p>
  {/if}
</div>

{#if !data.stats}
  <div class="card p-12 flex flex-col items-center justify-center text-center">
    <div class="icon-circle icon-circle-purple mb-4 w-16 h-16 text-2xl">📭</div>
    <h3 class="text-lg font-semibold text-gray-900 mb-2">No Projects Found</h3>
    <p class="text-muted">Start by sending some test reports to your Flackyness API.</p>
  </div>
{:else}
  <!-- Stats Cards -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
    {#each statCards as stat}
      <div class="card p-6">
        <div class="flex items-start justify-between mb-4">
          <div class="icon-circle icon-circle-{stat.color}">
            {stat.icon}
          </div>
        </div>
        <div class="text-3xl font-bold text-gray-900 mb-1">{stat.value}</div>
        <div class="text-sm text-muted">{stat.label}</div>
      </div>
    {/each}
  </div>

  <!-- Flake Rate Trend Chart -->
  {#if data.trendData}
    <div class="card p-6 mb-8">
      <h2 class="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Flake Rate Trend (7 Days)</h2>
      <Chart options={chartOptions} height="280px" />
    </div>
  {/if}

  <!-- Flaky Tests Preview -->
  <div class="card p-6 mb-8">
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-sm font-semibold text-muted uppercase tracking-wider">Top Flaky Tests</h2>
      <a href="/flaky?project={data.stats.project.id}" class="pill-btn pill-btn-ghost text-sm">
        View All
      </a>
    </div>
    
    {#if data.flakyTests.length === 0}
      <div class="text-center py-8 text-muted">
        <span class="text-3xl mb-2 block">🎉</span>
        No flaky tests detected!
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light">
              <th class="py-3 px-4 font-medium">Test Name</th>
              <th class="py-3 px-4 font-medium">File</th>
              <th class="py-3 px-4 font-medium">Flake Rate</th>
              <th class="py-3 px-4 font-medium">Last Seen</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            {#each data.flakyTests.slice(0, 5) as test}
              <tr class="hover:bg-gray-50 transition-colors">
                <td class="py-4 px-4 max-w-xs">
                  <a href="/tests/{encodeURIComponent(test.testName)}?project={data.stats?.project.id}" 
                     class="text-purple-600 hover:text-purple-700 font-medium hover:underline">
                    {test.testName}
                  </a>
                </td>
                <td class="py-4 px-4 text-muted font-mono text-sm">
                  {test.testFile}
                </td>
                <td class="py-4 px-4">
                  <span class="badge badge-orange">
                    {(parseFloat(test.flakeRate) * 100).toFixed(1)}%
                  </span>
                </td>
                <td class="py-4 px-4 text-muted text-sm">{formatDate(test.lastSeen)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <!-- Recent Runs -->
  <div class="card p-6">
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-sm font-semibold text-muted uppercase tracking-wider">Recent Test Runs</h2>
      <a href="/runs?project={data.stats.project.id}" class="pill-btn pill-btn-ghost text-sm">
        View All
      </a>
    </div>
    
    {#if data.recentRuns.length === 0}
      <div class="text-center py-8 text-muted">
        No test runs yet.
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light">
              <th class="py-3 px-4 font-medium">Branch</th>
              <th class="py-3 px-4 font-medium">Commit</th>
              <th class="py-3 px-4 font-medium">Total</th>
              <th class="py-3 px-4 font-medium">Passed</th>
              <th class="py-3 px-4 font-medium">Failed</th>
              <th class="py-3 px-4 font-medium">Flaky</th>
              <th class="py-3 px-4 font-medium">Date</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            {#each data.recentRuns as run}
              <tr class="hover:bg-gray-50 transition-colors">
                <td class="py-4 px-4 font-mono text-sm font-medium">{run.branch}</td>
                <td class="py-4 px-4 font-mono text-sm text-muted">{run.commitSha.slice(0, 7)}</td>
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
  </div>
{/if}
