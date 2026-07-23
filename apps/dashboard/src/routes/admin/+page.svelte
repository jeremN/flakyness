<script lang="ts">
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head>
  <title>Admin | Flackyness</title>
</svelte:head>

<div class="mb-8 flex items-center justify-between">
  <div>
    <h1 class="text-2xl font-bold text-gray-900 mb-1">Admin</h1>
    <p class="text-muted">Manage projects, tokens, and data retention.</p>
  </div>
  {#if data.adminEnabled}
    <a href="/admin/new" class="pill-btn pill-btn-primary">New project</a>
  {/if}
</div>

{#if !data.adminEnabled}
  <div class="card p-8 text-center">
    <h3 class="text-lg font-semibold text-gray-900 mb-2">Admin actions are disabled</h3>
    <p class="text-muted">
      Set <code class="font-mono">ADMIN_TOKEN</code> in the dashboard's environment to manage
      projects from here.
    </p>
  </div>
{:else if data.adminProjects.length === 0}
  <div class="card p-12 text-center">
    <h3 class="text-lg font-semibold text-gray-900 mb-2">No projects yet</h3>
    <p class="text-muted">Create your first project to start ingesting reports.</p>
  </div>
{:else}
  <div class="card overflow-hidden">
    <table class="w-full">
      <thead>
        <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light bg-gray-50">
          <th class="py-4 px-4 font-medium">Project</th>
          <th class="py-4 px-4 font-medium">Runs</th>
          <th class="py-4 px-4 font-medium">Active flaky</th>
          <th class="py-4 px-4 font-medium">Webhook</th>
          <th class="py-4 px-4 font-medium"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each data.adminProjects as project}
          <tr class="hover:bg-gray-50 transition-colors">
            <td class="py-4 px-4 font-medium text-gray-900">{project.name}</td>
            <td class="py-4 px-4 text-muted">{project.stats.totalRuns}</td>
            <td class="py-4 px-4 text-muted">{project.stats.activeFlakyTests}</td>
            <td class="py-4 px-4 text-muted text-sm">
              {project.webhookUrl ? 'configured' : '—'}
            </td>
            <td class="py-4 px-4">
              <a
                href="/admin/{project.id}"
                class="text-purple-600 hover:text-purple-700 font-medium hover:underline"
              >
                Manage
              </a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
