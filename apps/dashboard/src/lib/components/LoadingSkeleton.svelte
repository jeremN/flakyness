<script lang="ts">
  interface Props {
    type?: 'card' | 'table' | 'text';
    rows?: number;
  }

  let { type = 'card', rows = 3 }: Props = $props();
</script>

{#if type === 'card'}
  <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 animate-pulse">
    <div class="h-8 w-16 bg-gray-700 rounded mb-2"></div>
    <div class="h-4 w-24 bg-gray-800 rounded"></div>
  </div>
{:else if type === 'table'}
  <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden animate-pulse">
    <div class="bg-gray-800/50 py-4 px-4">
      <div class="h-4 w-32 bg-gray-700 rounded"></div>
    </div>
    {#each Array(rows) as _, i}
      <div class="flex gap-4 py-4 px-4 border-t border-gray-800">
        <div class="h-4 w-1/4 bg-gray-800 rounded"></div>
        <div class="h-4 w-1/3 bg-gray-800 rounded"></div>
        <div class="h-4 w-1/5 bg-gray-800 rounded"></div>
        <div class="h-4 w-1/6 bg-gray-800 rounded"></div>
      </div>
    {/each}
  </div>
{:else}
  <div class="h-4 bg-gray-800 rounded animate-pulse" style="width: {Math.random() * 40 + 60}%"></div>
{/if}

<style>
  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  .animate-pulse {
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
</style>
