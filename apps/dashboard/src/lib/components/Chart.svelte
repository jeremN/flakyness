<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as echarts from 'echarts';
  import type { EChartsOption } from 'echarts';

  interface Props {
    options: EChartsOption;
    height?: string;
    class?: string;
  }

  let { options, height = '300px', class: className = '' }: Props = $props();
  
  let chartContainer: HTMLDivElement;
  let chart: echarts.ECharts | null = null;

  // Dark theme configuration
  const darkTheme = {
    backgroundColor: 'transparent',
    textStyle: {
      color: '#9ca3af',
    },
    title: {
      textStyle: {
        color: '#f3f4f6',
      },
    },
    legend: {
      textStyle: {
        color: '#9ca3af',
      },
    },
    grid: {
      borderColor: '#374151',
    },
    xAxis: {
      axisLine: {
        lineStyle: {
          color: '#374151',
        },
      },
      axisTick: {
        lineStyle: {
          color: '#374151',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: '#1f2937',
        },
      },
    },
    yAxis: {
      axisLine: {
        lineStyle: {
          color: '#374151',
        },
      },
      axisTick: {
        lineStyle: {
          color: '#374151',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: '#1f2937',
        },
      },
    },
  };

  function initChart() {
    if (!chartContainer) return;
    
    chart = echarts.init(chartContainer);
    
    // Merge dark theme with provided options
    const mergedOptions = {
      ...darkTheme,
      ...options,
      xAxis: { ...darkTheme.xAxis, ...(options.xAxis as object) },
      yAxis: { ...darkTheme.yAxis, ...(options.yAxis as object) },
    };
    
    chart.setOption(mergedOptions);
  }

  function handleResize() {
    chart?.resize();
  }

  onMount(() => {
    initChart();
    window.addEventListener('resize', handleResize);
  });

  onDestroy(() => {
    window.removeEventListener('resize', handleResize);
    chart?.dispose();
  });

  // Re-render when options change
  $effect(() => {
    if (chart && options) {
      const mergedOptions = {
        ...darkTheme,
        ...options,
        xAxis: { ...darkTheme.xAxis, ...(options.xAxis as object) },
        yAxis: { ...darkTheme.yAxis, ...(options.yAxis as object) },
      };
      chart.setOption(mergedOptions, true);
    }
  });
</script>

<div 
  bind:this={chartContainer} 
  class="w-full {className}" 
  style="height: {height};"
></div>
