<script lang="ts">
  import type { PageData } from './$types';
  import { enhance } from '$app/forms';
  import TokenReveal from '$lib/components/TokenReveal.svelte';
  import { formatDate } from '$lib/format';

  // `data` uses the generated PageData; `form` is hand-typed (Global Constraint
  // 3) — the union of all four actions' returns is not worth narrowing.
  interface DetailFormResult {
    action?: 'patch' | 'rotate' | 'prune' | 'delete';
    success?: boolean;
    errors?: Record<string, string>;
    message?: string;
    token?: string;
    warning?: string;
    prune?: {
      dryRun: boolean;
      cutoff: string;
      runsToDelete?: number;
      resultsToDelete?: number;
      runsDeleted?: number;
      resultsDeleted?: number;
    };
  }
  interface Props {
    data: PageData;
    form: DetailFormResult | null;
  }

  let { data, form }: Props = $props();

  const project = $derived(data.project);
  // form.errors is set only by the patch action's validation fail. Typed
  // Record<string,string> so `patchErrors[field.name]` indexes cleanly.
  const patchErrors: Record<string, string> = $derived(
    form?.action === 'patch' && form.errors ? form.errors : {}
  );

  function val(n: number | null): string {
    return n === null ? '' : String(n);
  }

  let confirmName = $state('');
  const canDelete = $derived(confirmName === project.name);
</script>

<svelte:head>
  <title>{project.name} · Admin | Flackyness</title>
</svelte:head>

<div class="mb-8">
  <a href="/admin" class="text-sm text-purple-600 hover:underline">&larr; Back to projects</a>
  <h1 class="text-2xl font-bold text-gray-900 mt-2">{project.name}</h1>
  <p class="text-muted">
    {project.stats.totalRuns} runs · {project.stats.activeFlakyTests} active flaky
  </p>
</div>

<!-- Settings -->
<section class="card p-6 max-w-2xl mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-4">Settings</h2>
  {#if form?.action === 'patch' && form.success}
    <p class="text-sm text-green-600 mb-3">Settings saved.</p>
  {/if}
  {#if form?.action === 'patch' && form.message}
    <p class="text-sm text-red-600 mb-3">{form.message}</p>
  {/if}
  <form method="POST" action="?/patch" use:enhance class="flex flex-col gap-4">
    <p class="text-xs text-muted">Leave a field blank to reset it to the system default.</p>

    {#each [
      { name: 'flakeThreshold', label: 'Flake threshold (0–1)', value: val(project.flakeThreshold) },
      { name: 'windowDays', label: 'Window days (1–90)', value: val(project.windowDays) },
      { name: 'minRuns', label: 'Min runs (1–100)', value: val(project.minRuns) },
      { name: 'retentionDays', label: 'Retention days (1–3650)', value: val(project.retentionDays) },
      { name: 'quarantineThreshold', label: 'Quarantine threshold (0–1)', value: val(project.quarantineThreshold) },
      { name: 'quarantineMinRuns', label: 'Quarantine min runs (1–100)', value: val(project.quarantineMinRuns) },
      { name: 'quarantineTtlDays', label: 'Quarantine TTL days (1–365)', value: val(project.quarantineTtlDays) },
    ] as field}
      <div>
        <label for={field.name} class="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
        <input
          id={field.name}
          name={field.name}
          type="text"
          value={field.value}
          class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
        />
        {#if patchErrors[field.name]}
          <p class="text-xs text-red-600 mt-1">{patchErrors[field.name]}</p>
        {/if}
      </div>
    {/each}

    <div>
      <label for="webhookUrl" class="block text-sm font-medium text-gray-700 mb-1">Webhook URL</label>
      <input
        id="webhookUrl"
        name="webhookUrl"
        type="text"
        value={project.webhookUrl ?? ''}
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
      {#if patchErrors.webhookUrl}
        <p class="text-xs text-red-600 mt-1">{patchErrors.webhookUrl}</p>
      {/if}
    </div>

    <div>
      <label for="webhookKind" class="block text-sm font-medium text-gray-700 mb-1">Webhook kind</label>
      <select
        id="webhookKind"
        name="webhookKind"
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      >
        <option value="" selected={project.webhookKind === null}>Auto-detect</option>
        <option value="slack" selected={project.webhookKind === 'slack'}>Slack</option>
        <option value="generic" selected={project.webhookKind === 'generic'}>Generic</option>
      </select>
    </div>

    <label class="flex items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" name="autoQuarantineEnabled" checked={project.autoQuarantineEnabled} />
      Enable auto-quarantine
    </label>

    <button type="submit" class="pill-btn pill-btn-primary self-start">Save settings</button>
  </form>
</section>

<!-- Rotate token -->
<section class="card p-6 max-w-2xl mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-2">API token</h2>
  {#if form?.action === 'rotate' && form.token}
    <div class="mb-4">
      <TokenReveal token={form.token!} warning={form.warning!} />
    </div>
  {/if}
  {#if form?.action === 'rotate' && form.message}
    <p class="text-sm text-red-600 mb-3">{form.message}</p>
  {/if}
  <p class="text-sm text-muted mb-3">
    Rotating issues a new token and invalidates the current one immediately — CI using the old
    token will fail until its secret is updated.
  </p>
  <form method="POST" action="?/rotate" use:enhance>
    <button type="submit" class="pill-btn pill-btn-ghost">Rotate token</button>
  </form>
</section>

<!-- Prune -->
<section class="card p-6 max-w-2xl mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-2">Prune old data</h2>
  {#if form?.action === 'prune' && form.prune}
    {#if form.prune.dryRun}
      <p class="text-sm text-gray-700 mb-3">
        This will delete {form.prune.runsToDelete} runs / {form.prune.resultsToDelete} results
        older than {formatDate(form.prune.cutoff)}.
      </p>
      <form method="POST" action="?/pruneConfirm" use:enhance class="mb-4">
        <button
          type="submit"
          class="pill-btn bg-red-600 text-white hover:bg-red-700"
        >
          Confirm prune
        </button>
      </form>
    {:else}
      <p class="text-sm text-green-600 mb-3">
        Deleted {form.prune.runsDeleted} runs / {form.prune.resultsDeleted} results.
      </p>
    {/if}
  {/if}
  {#if form?.action === 'prune' && form.message}
    <p class="text-sm text-red-600 mb-3">{form.message}</p>
  {/if}
  <form method="POST" action="?/pruneDryRun" use:enhance>
    <button type="submit" class="pill-btn pill-btn-ghost">Preview prune…</button>
  </form>
</section>

<!-- Delete -->
<section class="card p-6 max-w-2xl border border-red-200">
  <h2 class="text-lg font-semibold text-red-700 mb-2">Delete project</h2>
  <p class="text-sm text-muted mb-3">
    Permanently deletes “{project.name}” and all its runs, results, and flaky-test history. This
    cannot be undone.
  </p>
  {#if form?.action === 'delete' && form.message}
    <p class="text-sm text-red-600 mb-3">{form.message}</p>
  {/if}
  <form method="POST" action="?/delete" use:enhance class="flex flex-col gap-3">
    <input type="hidden" name="name" value={project.name} />
    <label for="confirmName" class="text-sm text-gray-700">
      Type <span class="font-mono font-semibold">{project.name}</span> to confirm:
    </label>
    <input
      id="confirmName"
      name="confirmName"
      type="text"
      autocomplete="off"
      bind:value={confirmName}
      aria-label="Type the project name to confirm"
      class="w-full max-w-sm border border-subtle rounded-lg px-3 py-2 text-sm"
    />
    <button
      type="submit"
      disabled={!canDelete}
      class="pill-btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed self-start"
    >
      Delete permanently
    </button>
  </form>
</section>
