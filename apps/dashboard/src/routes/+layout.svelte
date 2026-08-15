<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { appendProjectParam, withQueryParam } from '$lib/href';
  import { partitionProjects } from '$lib/project-groups';
  import TeamSwitcher from '$lib/components/TeamSwitcher.svelte';
  import type { LayoutData } from './$types';

  interface Props {
    children: import('svelte').Snippet;
    data: LayoutData;
  }

  let { children, data }: Props = $props();

  const navItems = [
    { href: '/', label: 'Overview', icon: '📊', color: 'purple' },
    { href: '/flaky', label: 'Flaky Tests', icon: '⚡', color: 'orange' },
    { href: '/runs', label: 'Test Runs', icon: '🧪', color: 'blue' },
    { href: '/analysis', label: 'Analysis', icon: '🔬', color: 'purple' },
    { href: '/admin', label: 'Admin', icon: '⚙️', color: 'purple' },
  ];

  function getNavHref(baseHref: string): string {
    return appendProjectParam(baseHref, data.selectedProject?.id);
  }

  function isActive(href: string): boolean {
    return $page.url.pathname === href;
  }

  // Discharges the plan 059 Task 6 Global Constraint: a `teamId === null`
  // project is invisible to every non-global-admin via canReadProject, so it
  // must render under its own "Unassigned" heading — never merged silently
  // into the regular list — and only for the one caller who can read it at
  // all. See $lib/project-groups.ts.
  const partitioned = $derived(partitionProjects(data.projects));

  function projectHref(projectId: string): string {
    return withQueryParam($page.url, 'project', projectId);
  }

  function isSelectedProject(projectId: string): boolean {
    return data.selectedProject?.id === projectId;
  }

  function projectLinkClass(projectId: string): string {
    return `block px-3 py-1.5 rounded-lg text-sm truncate ${
      isSelectedProject(projectId) ? 'bg-purple-50 text-purple-700 font-medium' : 'text-gray-600 hover:bg-gray-50'
    }`;
  }
</script>

{#if data.user}
  <div class="flex min-h-screen">
    <!-- Sidebar -->
    <aside class="w-64 bg-white border-r border-subtle p-6 flex flex-col gap-6">
      <!-- Logo -->
      <div class="flex items-center gap-2">
        <div class="icon-circle icon-circle-purple">
          🎭
        </div>
        <span class="text-xl font-bold text-gray-900">Flackyness</span>
      </div>

      <TeamSwitcher teams={data.teams} activeTeam={data.activeTeam} />

      <!-- Project list -->
      {#if partitioned.assigned.length > 0 || (data.user.isGlobalAdmin && partitioned.unassigned.length > 0)}
        <div>
          {#if partitioned.assigned.length > 0}
            <h3 class="block text-xs text-muted uppercase tracking-wider mb-2 font-medium">
              Projects
            </h3>
            <ul class="flex flex-col gap-1">
              {#each partitioned.assigned as project (project.id)}
                <li>
                  <a
                    href={projectHref(project.id)}
                    class={projectLinkClass(project.id)}
                    aria-current={isSelectedProject(project.id) ? 'page' : undefined}
                  >
                    {project.name}
                  </a>
                </li>
              {/each}
            </ul>
          {/if}

          {#if data.user.isGlobalAdmin && partitioned.unassigned.length > 0}
            <h3 class="block text-xs text-muted uppercase tracking-wider mt-3 mb-2 font-medium">
              Unassigned
            </h3>
            <ul class="flex flex-col gap-1">
              {#each partitioned.unassigned as project (project.id)}
                <li>
                  <a
                    href={projectHref(project.id)}
                    class={projectLinkClass(project.id)}
                    aria-current={isSelectedProject(project.id) ? 'page' : undefined}
                  >
                    {project.name}
                  </a>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      <!-- Navigation -->
      <nav class="flex flex-col gap-1">
        {#each navItems as item}
          <a
            href={getNavHref(item.href)}
            class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-150
              {isActive(item.href)
                ? 'bg-purple-50 text-purple-700'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}"
          >
            <span class="w-6 h-6 flex items-center justify-center rounded-lg text-sm
              {isActive(item.href)
                ? (item.color === 'purple' ? 'bg-purple-100' : item.color === 'orange' ? 'bg-orange-100' : 'bg-blue-100')
                : 'bg-gray-100'}">
              {item.icon}
            </span>
            <span>{item.label}</span>
            {#if isActive(item.href)}
              <span class="ml-auto">
                <svg class="w-4 h-4 text-purple-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
              </span>
            {/if}
          </a>
        {/each}
      </nav>

      <!-- Team/user administration — only a global admin can manage these. -->
      {#if data.user.isGlobalAdmin}
        <nav aria-label="Administration" class="flex flex-col gap-1">
          <a
            href="/admin/teams"
            class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900"
          >
            Teams
          </a>
          <a
            href="/admin/users"
            class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900"
          >
            Users
          </a>
        </nav>
      {/if}

      <!-- User menu -->
      <div class="mt-auto pt-4 border-t border-subtle-light flex flex-col gap-3">
        <div class="text-sm font-medium text-gray-900 truncate">
          {data.user.displayName || data.user.email}
        </div>
        <form method="POST" action="/logout">
          <button type="submit" class="pill-btn pill-btn-ghost w-full justify-center">
            Sign out
          </button>
        </form>
        <div class="text-xs text-light">
          Flackyness v0.0.1
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 p-8 overflow-y-auto bg-[var(--color-bg)]">
      {#if data.apiError}
        <div class="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {data.apiError}
        </div>
      {/if}
      {@render children()}
    </main>
  </div>
{:else}
  <!-- Anonymous visitor (/login and any other route the session gate lets
       through unauthenticated): render the page bare, with no chrome. A
       `+page@.svelte` breakout cannot do this — /login has no layout above
       the root to break out to — so the shell itself is gated on data.user
       instead. Pairs with +layout.server.ts's `locals.user &&` fetch guard:
       that one stops the DATA reaching an anonymous caller, this stops the
       NAVIGATION. -->
  {@render children()}
{/if}
