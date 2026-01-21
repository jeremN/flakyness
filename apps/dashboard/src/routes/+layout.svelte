<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
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
  ];

  function handleProjectChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    const projectId = select.value;
    const currentPath = $page.url.pathname;
    const searchParams = new URLSearchParams($page.url.searchParams);
    searchParams.set('project', projectId);
    goto(`${currentPath}?${searchParams.toString()}`);
  }

  function getNavHref(baseHref: string): string {
    if (data.selectedProject) {
      return `${baseHref}?project=${data.selectedProject.id}`;
    }
    return baseHref;
  }

  function isActive(href: string): boolean {
    return $page.url.pathname === href;
  }
</script>

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
    
    <!-- Project Selector -->
    {#if data.projects.length > 0}
      <div>
        <label for="project-select" class="block text-xs text-muted uppercase tracking-wider mb-2 font-medium">
          Project
        </label>
        <select 
          id="project-select"
          class="w-full bg-white border border-subtle rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:ring-2 focus:ring-purple-500 focus:border-transparent cursor-pointer appearance-none"
          onchange={handleProjectChange}
          value={data.selectedProject?.id}
          style="background-image: url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 fill=%22none%22 viewBox=%220 0 20 20%22%3E%3Cpath stroke=%22%236b7280%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22 stroke-width=%221.5%22 d=%22m6 8 4 4 4-4%22/%3E%3C/svg%3E'); background-position: right 0.5rem center; background-repeat: no-repeat; background-size: 1.5em 1.5em; padding-right: 2.5rem;"
        >
          {#each data.projects as project}
            <option value={project.id}>{project.name}</option>
          {/each}
        </select>
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
    
    <!-- Version footer -->
    <div class="mt-auto pt-4 border-t border-subtle-light">
      <div class="text-xs text-light">
        Flackyness v0.0.1
      </div>
    </div>
  </aside>
  
  <!-- Main Content -->
  <main class="flex-1 p-8 overflow-y-auto bg-[var(--color-bg)]">
    {@render children()}
  </main>
</div>
