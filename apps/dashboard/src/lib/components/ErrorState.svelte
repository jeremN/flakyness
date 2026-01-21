<script lang="ts">
  interface Props {
    message?: string;
    onRetry?: () => void;
  }

  let { message = 'Something went wrong', onRetry }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center py-12 text-gray-400">
  <div class="w-16 h-16 mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
    <svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  </div>
  
  <h3 class="text-lg font-semibold text-gray-200 mb-2">Error</h3>
  <p class="text-gray-400 mb-4 text-center max-w-md">{message}</p>
  
  {#if onRetry}
    <button 
      onclick={onRetry}
      class="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors"
    >
      Try Again
    </button>
  {/if}
</div>
