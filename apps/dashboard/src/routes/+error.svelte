<script lang="ts">
  import { page } from '$app/stores';
  import { errorTitle, errorIcon } from '$lib/error-page';

  // Get error info from page store
  const status = $derived($page.status);
  const message = $derived($page.error?.message || 'An unexpected error occurred');
</script>

<svelte:head>
  <title>{status} | Flackyness</title>
</svelte:head>

<div class="min-h-screen bg-gray-950 flex items-center justify-center p-4">
  <div class="text-center max-w-md">
    <div class="text-8xl mb-6">{errorIcon(status)}</div>

    <h1 class="text-4xl font-bold text-white mb-2">{status}</h1>
    <h2 class="text-xl text-gray-400 mb-4">{errorTitle(status)}</h2>
    
    <p class="text-gray-500 mb-8">{message}</p>
    
    <div class="flex gap-4 justify-center">
      <a 
        href="/"
        class="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors"
      >
        Go Home
      </a>
      <button 
        onclick={() => history.back()}
        class="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors"
      >
        Go Back
      </button>
    </div>
  </div>
</div>
