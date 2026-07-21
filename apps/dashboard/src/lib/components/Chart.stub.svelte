<script lang="ts">
  // Stub of $lib/components/Chart.svelte for render tests: a marker instead of
  // initialising ECharts. Kept even though browser mode has canvas, so chart
  // pages render fast + deterministically; chart registration stays guarded by
  // chart-registration.test.ts.
  const _props: { options?: unknown; height?: string; class?: string } = $props();
</script>
<div data-testid="chart-stub"></div>
