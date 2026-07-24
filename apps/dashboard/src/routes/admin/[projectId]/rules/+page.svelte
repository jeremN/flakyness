<script lang="ts">
  import type { PageData } from './$types';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { describeRule } from '$lib/rule-summary';

  type Rule = PageData['rules'][number];

  interface RulesFormResult {
    action?: 'create' | 'update' | 'toggle' | 'delete' | 'reorder';
    success?: boolean;
    errors?: Record<string, string>;
    message?: string;
  }
  interface Props {
    data: PageData;
    form: RulesFormResult | null;
  }
  let { data, form }: Props = $props();

  const project = $derived(data.project);
  const rules = $derived(data.rules);

  // Editor state: null = closed, 'new' = create, otherwise the ruleId to edit.
  let editing = $state<string | null>(null);
  // The selected action/condition drive which editor fields are shown; seeded
  // when the editor opens so an edit starts from the rule's own values.
  let formAction = $state<'quarantine' | 'exempt'>('quarantine');
  let formCondition = $state<'flake_rate' | 'consecutive'>('flake_rate');
  // Which row is showing its inline delete confirm.
  let confirmingDelete = $state<string | null>(null);

  const editErrors = $derived(
    (form?.action === 'create' || form?.action === 'update') && form.errors ? form.errors : {}
  );

  const editingRule = $derived(
    editing && editing !== 'new' ? rules.find((r) => r.id === editing) : undefined
  );

  function openCreate() {
    editing = 'new';
    formAction = 'quarantine';
    formCondition = 'flake_rate';
    confirmingDelete = null;
  }
  function openEdit(rule: Rule) {
    editing = rule.id;
    formAction = rule.action;
    formCondition = rule.conditionType === 'consecutive' ? 'consecutive' : 'flake_rate';
    confirmingDelete = null;
  }
  function closeEditor() {
    editing = null;
  }

  function num(n: number | null | undefined): string {
    return n == null ? '' : String(n);
  }

  // Close the editor only when the submit actually succeeded.
  const enhanceEditor: SubmitFunction = () => async ({ result, update }) => {
    await update();
    if (result.type === 'success') closeEditor();
  };
</script>

<svelte:head>
  <title>{project.name} · Rules | Flackyness</title>
</svelte:head>

<div class="mb-8">
  <a href="/admin/{project.id}" class="text-sm text-purple-600 hover:underline">&larr; Back to {project.name}</a>
  <h1 class="text-2xl font-bold text-gray-900 mt-2">Quarantine rules</h1>
  <p class="text-muted">
    Evaluated top-to-bottom; the first matching rule wins. No match falls back to the project's
    quarantine threshold.
  </p>
</div>

{#if (form?.action === 'reorder' || form?.action === 'toggle' || form?.action === 'delete') && form.message}
  <p class="text-sm text-red-600 mb-3">{form.message}</p>
{/if}

<section class="card p-6 max-w-3xl mb-8">
  <div class="flex items-center justify-between mb-4">
    <h2 class="text-lg font-semibold text-gray-900">Rules ({rules.length})</h2>
    <button type="button" class="pill-btn pill-btn-primary" onclick={openCreate}>+ Add rule</button>
  </div>

  {#if rules.length === 0}
    <p class="text-sm text-muted">
      No rules yet. Tests are quarantined using the project's quarantine threshold until you add one.
    </p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each rules as rule, i (rule.id)}
        <li
          class="flex items-center gap-3 border border-subtle rounded-lg px-3 py-2"
          class:opacity-50={!rule.enabled}
        >
          <span class="text-xs text-muted w-6 tabular-nums">#{i + 1}</span>

          <div class="flex flex-col leading-none">
            <form method="POST" action="?/reorder" use:enhance>
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="direction" value="up" />
              <button
                type="submit"
                disabled={i === 0}
                aria-label="Move up"
                class="text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed"
              >▲</button>
            </form>
            <form method="POST" action="?/reorder" use:enhance>
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="direction" value="down" />
              <button
                type="submit"
                disabled={i === rules.length - 1}
                aria-label="Move down"
                class="text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed"
              >▼</button>
            </form>
          </div>

          <div class="flex-1 min-w-0">
            {#if rule.name}<span class="text-sm font-medium text-gray-900 block">{rule.name}</span>{/if}
            <span class="text-sm text-gray-700 block truncate">{describeRule(rule)}</span>
          </div>

          <span
            class="text-xs px-2 py-0.5 rounded-full {rule.action === 'exempt'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-amber-100 text-amber-700'}"
          >{rule.action}</span>

          <form method="POST" action="?/toggle" use:enhance>
            <input type="hidden" name="ruleId" value={rule.id} />
            <input type="hidden" name="enabled" value={(!rule.enabled).toString()} />
            <button type="submit" class="pill-btn pill-btn-ghost text-xs">
              {rule.enabled ? 'Disable' : 'Enable'}
            </button>
          </form>

          <button type="button" class="pill-btn pill-btn-ghost text-xs" onclick={() => openEdit(rule)}>Edit</button>

          {#if confirmingDelete === rule.id}
            <form method="POST" action="?/delete" use:enhance class="flex items-center gap-1">
              <input type="hidden" name="ruleId" value={rule.id} />
              <span class="text-xs text-red-600">Delete?</span>
              <button type="submit" class="pill-btn bg-red-600 text-white text-xs">Yes</button>
              <button type="button" class="pill-btn pill-btn-ghost text-xs" onclick={() => (confirmingDelete = null)}>No</button>
            </form>
          {:else}
            <button
              type="button"
              class="pill-btn pill-btn-ghost text-xs text-red-600"
              onclick={() => (confirmingDelete = rule.id)}
            >Delete</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if editing !== null}
  <section class="card p-6 max-w-3xl mb-8">
    <h2 class="text-lg font-semibold text-gray-900 mb-4">
      {editing === 'new' ? 'Add rule' : 'Edit rule'}
    </h2>
    <form
      method="POST"
      action={editing === 'new' ? '?/create' : '?/update'}
      use:enhance={enhanceEditor}
      class="flex flex-col gap-4"
    >
      {#if editing !== 'new' && editingRule}
        <input type="hidden" name="ruleId" value={editingRule.id} />
      {/if}

      <div>
        <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Name (optional)</label>
        <input id="name" name="name" type="text" value={editingRule?.name ?? ''} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
      </div>

      <div class="grid grid-cols-3 gap-3">
        <div>
          <label for="selectorBranch" class="block text-sm font-medium text-gray-700 mb-1">Branch glob</label>
          <input id="selectorBranch" name="selectorBranch" type="text" placeholder="main" value={editingRule?.selectorBranch ?? ''} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label for="selectorFile" class="block text-sm font-medium text-gray-700 mb-1">File glob</label>
          <input id="selectorFile" name="selectorFile" type="text" placeholder="*e2e*" value={editingRule?.selectorFile ?? ''} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label for="selectorTag" class="block text-sm font-medium text-gray-700 mb-1">Tag</label>
          <input id="selectorTag" name="selectorTag" type="text" value={editingRule?.selectorTag ?? ''} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      <div>
        <label for="action" class="block text-sm font-medium text-gray-700 mb-1">Action</label>
        <select id="action" name="action" bind:value={formAction} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm">
          <option value="quarantine">Quarantine</option>
          <option value="exempt">Exempt</option>
        </select>
      </div>

      {#if formAction === 'quarantine'}
        <div>
          <label for="conditionType" class="block text-sm font-medium text-gray-700 mb-1">Condition</label>
          <select id="conditionType" name="conditionType" bind:value={formCondition} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm">
            <option value="flake_rate">Flake rate</option>
            <option value="consecutive">Consecutive failures</option>
          </select>
        </div>

        {#if formCondition === 'flake_rate'}
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label for="flakeThreshold" class="block text-sm font-medium text-gray-700 mb-1">Threshold (0–1)</label>
              <input id="flakeThreshold" name="flakeThreshold" type="text" value={num(editingRule?.flakeThreshold)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.flakeThreshold}<p class="text-xs text-red-600 mt-1">{editErrors.flakeThreshold}</p>{/if}
            </div>
            <div>
              <label for="minRuns" class="block text-sm font-medium text-gray-700 mb-1">Min runs (1–100)</label>
              <input id="minRuns" name="minRuns" type="text" value={num(editingRule?.minRuns)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.minRuns}<p class="text-xs text-red-600 mt-1">{editErrors.minRuns}</p>{/if}
            </div>
            <div>
              <label for="windowDays" class="block text-sm font-medium text-gray-700 mb-1">Window days (1–90)</label>
              <input id="windowDays" name="windowDays" type="text" value={num(editingRule?.windowDays)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.windowDays}<p class="text-xs text-red-600 mt-1">{editErrors.windowDays}</p>{/if}
            </div>
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="consecutiveFailures" class="block text-sm font-medium text-gray-700 mb-1">Consecutive fails (1–100)</label>
              <input id="consecutiveFailures" name="consecutiveFailures" type="text" value={num(editingRule?.consecutiveFailures)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.consecutiveFailures}<p class="text-xs text-red-600 mt-1">{editErrors.consecutiveFailures}</p>{/if}
            </div>
            <div>
              <label for="windowDays" class="block text-sm font-medium text-gray-700 mb-1">Window days (1–90)</label>
              <input id="windowDays" name="windowDays" type="text" value={num(editingRule?.windowDays)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
              {#if editErrors.windowDays}<p class="text-xs text-red-600 mt-1">{editErrors.windowDays}</p>{/if}
            </div>
          </div>
        {/if}

        <div class="max-w-xs">
          <label for="ttlDays" class="block text-sm font-medium text-gray-700 mb-1">Quarantine TTL days (1–365, optional)</label>
          <input id="ttlDays" name="ttlDays" type="text" value={num(editingRule?.ttlDays)} class="w-full border border-subtle rounded-lg px-3 py-2 text-sm" />
          {#if editErrors.ttlDays}<p class="text-xs text-red-600 mt-1">{editErrors.ttlDays}</p>{/if}
        </div>
      {/if}

      <label class="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="enabled" checked={editingRule?.enabled ?? true} />
        Enabled
      </label>

      {#if editErrors.action}<p class="text-sm text-red-600">{editErrors.action}</p>{/if}
      {#if editErrors.conditionType}<p class="text-sm text-red-600">{editErrors.conditionType}</p>{/if}
      {#if (form?.action === 'create' || form?.action === 'update') && form.message}
        <p class="text-sm text-red-600">{form.message}</p>
      {/if}

      <div class="flex gap-2">
        <button type="submit" class="pill-btn pill-btn-primary">
          {editing === 'new' ? 'Create rule' : 'Save rule'}
        </button>
        <button type="button" class="pill-btn pill-btn-ghost" onclick={closeEditor}>Cancel</button>
      </div>
    </form>
  </section>
{/if}
