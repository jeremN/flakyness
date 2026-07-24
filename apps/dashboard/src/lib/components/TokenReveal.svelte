<script lang="ts">
  interface Props {
    token: string;
    warning: string;
  }

  let { token, warning }: Props = $props();
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<div class="card p-6 border border-orange-200 bg-orange-50" data-testid="token-reveal">
  <h3 class="text-lg font-semibold text-gray-900 mb-2">API token</h3>
  <p class="text-sm text-orange-800 mb-3">{warning}</p>
  <div class="flex items-center gap-2">
    <code class="flex-1 font-mono text-sm bg-white border border-subtle rounded-lg px-3 py-2 break-all">{token}</code>
    <button type="button" class="pill-btn pill-btn-primary" onclick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  </div>
</div>
