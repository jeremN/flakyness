<script lang="ts">
  import { page } from '$app/stores';
  import { withQueryParam } from '$lib/href';
  import type { TeamSummary } from '../../app.d';

  interface Props {
    teams: TeamSummary[];
    activeTeam: string | null;
  }

  let { teams, activeTeam }: Props = $props();
</script>

{#if teams.length >= 2}
  <nav aria-label="Team filter" class="flex flex-col gap-1">
    <span class="block text-xs text-muted uppercase tracking-wider mb-1 font-medium">Team</span>
    <a
      href={withQueryParam($page.url, 'team', null)}
      aria-current={activeTeam === null ? 'page' : undefined}
      class="px-3 py-1.5 rounded-lg text-sm
        {activeTeam === null ? 'bg-purple-50 text-purple-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}"
    >
      All teams
    </a>
    {#each teams as team (team.id)}
      <a
        href={withQueryParam($page.url, 'team', team.id)}
        aria-current={activeTeam === team.id ? 'page' : undefined}
        class="px-3 py-1.5 rounded-lg text-sm truncate
          {activeTeam === team.id ? 'bg-purple-50 text-purple-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}"
      >
        {team.name}
      </a>
    {/each}
  </nav>
{/if}
