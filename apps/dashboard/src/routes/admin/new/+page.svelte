<script lang="ts">
  import { enhance } from '$app/forms';
  import TokenReveal from '$lib/components/TokenReveal.svelte';

  // Manual form-result type (Global Constraint 3) — cleaner than narrowing the
  // generated ActionData union. The create page has no `load`, so it needs no
  // `data` prop.
  interface CreateFormResult {
    created?: boolean;
    token?: string;
    warning?: string;
    projectName?: string;
    message?: string;
    name?: string;
  }
  interface Props {
    form: CreateFormResult | null;
  }

  let { form }: Props = $props();
</script>

<svelte:head>
  <title>New project | Flackyness</title>
</svelte:head>

<div class="mb-8">
  <a href="/admin" class="text-sm text-purple-600 hover:underline">&larr; Back to projects</a>
  <h1 class="text-2xl font-bold text-gray-900 mt-2">New project</h1>
</div>

{#if form?.created}
  <div class="flex flex-col gap-4 max-w-2xl">
    <div class="card p-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-1">
        Project “{form.projectName}” created
      </h3>
      <p class="text-muted text-sm">Copy the ingest token below — it is shown only once.</p>
    </div>
    <!-- token/warning are flat-optional in CreateFormResult (Global Constraint 3), but the
         action only ever sets `created: true` alongside both — non-null assertions encode
         that invariant since TS can't narrow one optional field from a sibling. -->
    <TokenReveal token={form.token!} warning={form.warning!} />
    <a href="/admin" class="pill-btn pill-btn-primary self-start">Done</a>
  </div>
{:else}
  <form method="POST" use:enhance class="card p-6 max-w-lg flex flex-col gap-4">
    {#if form?.message}
      <p class="text-sm text-red-600">{form.message}</p>
    {/if}
    <div>
      <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Project name</label>
      <input
        id="name"
        name="name"
        type="text"
        required
        value={form?.name ?? ''}
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
    </div>
    <div>
      <label for="gitlabProjectId" class="block text-sm font-medium text-gray-700 mb-1">
        GitLab project ID <span class="text-muted">(optional)</span>
      </label>
      <input
        id="gitlabProjectId"
        name="gitlabProjectId"
        type="text"
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
    </div>
    <button type="submit" class="pill-btn pill-btn-primary self-start">Create project</button>
  </form>
{/if}
