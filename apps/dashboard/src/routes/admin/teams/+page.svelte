<script lang="ts">
  import type { PageData } from './$types';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { membersOfTeam, usersAvailableForTeam } from '$lib/team-members';

  // Manual form-result type (Global Constraint 3, matching the rest of the
  // admin console): every action here returns either `{ success: true }` (plus
  // `orphanedProjects` for delete) or `toFail`'s `{ error }`. One shared shape
  // covers all six actions — the page doesn't need to know which action ran to
  // render `form.error` into the single alert region.
  interface TeamsFormResult {
    success?: boolean;
    error?: string;
    orphanedProjects?: number;
  }
  interface Props {
    data: PageData;
    form: TeamsFormResult | null;
  }
  let { data, form }: Props = $props();

  const teams = $derived(data.teams);
  const users = $derived(data.users);

  // null = no team's member panel is open. Only one at a time — keeps the
  // page from turning into a wall of open panels when there are many teams.
  let expandedTeamId = $state<string | null>(null);
  let renamingTeamId = $state<string | null>(null);
  let confirmingDeleteId = $state<string | null>(null);
  let confirmName = $state('');

  function toggleExpand(teamId: string) {
    expandedTeamId = expandedTeamId === teamId ? null : teamId;
    confirmingDeleteId = null;
  }
  function startRename(teamId: string) {
    renamingTeamId = teamId;
  }
  function cancelRename() {
    renamingTeamId = null;
  }
  function startDelete(teamId: string) {
    confirmingDeleteId = teamId;
    confirmName = '';
  }
  function cancelDelete() {
    confirmingDeleteId = null;
    confirmName = '';
  }

  // Close the inline rename editor only when the submit actually succeeded —
  // an invalid/rejected rename should leave the field open with its value.
  const enhanceRename: SubmitFunction = () => async ({ result, update }) => {
    await update();
    if (result.type === 'success') renamingTeamId = null;
  };

  // Same idea for delete: a mismatch or API error keeps the confirm form open;
  // a real delete removes the row entirely, so there's nothing left to confirm.
  const enhanceDelete: SubmitFunction = () => async ({ result, update }) => {
    await update();
    if (result.type === 'success') {
      confirmingDeleteId = null;
      confirmName = '';
    }
  };
</script>

<svelte:head>
  <title>Teams · Admin | Flackyness</title>
</svelte:head>

<div class="mb-8">
  <a href="/admin" class="text-sm text-purple-600 hover:underline">&larr; Back to admin</a>
  <h1 class="text-2xl font-bold text-gray-900 mt-2">Teams</h1>
  <p class="text-muted">Manage teams, their membership, and project ownership.</p>
</div>

{#if form?.error}
  <div role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-6 max-w-2xl">
    {form.error}
  </div>
{/if}

{#if form?.success && form.orphanedProjects !== undefined}
  <div class="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 mb-6 max-w-2xl">
    Team deleted. {form.orphanedProjects}
    {form.orphanedProjects === 1 ? 'project' : 'projects'} became unassigned.
  </div>
{/if}

<!-- Create team -->
<section class="card p-6 max-w-lg mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-4">Create team</h2>
  <form method="POST" action="?/create" use:enhance class="flex items-end gap-3">
    <div class="flex-1">
      <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Team name</label>
      <input
        id="name"
        name="name"
        type="text"
        required
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
    </div>
    <button type="submit" class="pill-btn pill-btn-primary">Create</button>
  </form>
</section>

{#if teams.length === 0}
  <div class="card p-12 text-center">
    <h3 class="text-lg font-semibold text-gray-900 mb-2">No teams yet</h3>
    <p class="text-muted">Create a team above to start assigning projects and members.</p>
  </div>
{:else}
  <div class="card overflow-hidden">
    <table class="w-full">
      <thead>
        <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light bg-gray-50">
          <th class="py-4 px-4 font-medium">Team</th>
          <th class="py-4 px-4 font-medium">Members</th>
          <th class="py-4 px-4 font-medium">Projects</th>
          <th class="py-4 px-4 font-medium"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each teams as team (team.id)}
          <tr class="hover:bg-gray-50 transition-colors">
            <td class="py-4 px-4 font-medium text-gray-900">
              {#if renamingTeamId === team.id}
                <form method="POST" action="?/rename" use:enhance={enhanceRename} class="flex items-center gap-2">
                  <input type="hidden" name="teamId" value={team.id} />
                  <input
                    name="name"
                    type="text"
                    value={team.name}
                    aria-label="Team name"
                    class="border border-subtle rounded-lg px-2 py-1 text-sm"
                  />
                  <button type="submit" class="pill-btn pill-btn-primary text-xs">Save</button>
                  <button type="button" class="pill-btn pill-btn-ghost text-xs" onclick={cancelRename}>Cancel</button>
                </form>
              {:else}
                <div class="flex items-center gap-2">
                  <span>{team.name}</span>
                  <button
                    type="button"
                    class="text-xs text-purple-600 hover:underline"
                    onclick={() => startRename(team.id)}
                  >Rename</button>
                </div>
              {/if}
            </td>
            <td class="py-4 px-4 text-muted">{team.memberCount}</td>
            <td class="py-4 px-4 text-muted">{team.projectCount}</td>
            <td class="py-4 px-4 text-right">
              <button type="button" class="pill-btn pill-btn-ghost text-xs" onclick={() => toggleExpand(team.id)}>
                {expandedTeamId === team.id ? 'Hide members' : 'Manage members'}
              </button>
            </td>
          </tr>
          {#if expandedTeamId === team.id}
            {@const members = membersOfTeam(users, team.id)}
            {@const available = usersAvailableForTeam(users, team.id)}
            <tr>
              <td colspan="4" class="bg-gray-50 px-4 py-4">
                <div class="flex flex-col gap-4 max-w-2xl">
                  <div>
                    <h3 class="text-sm font-semibold text-gray-900 mb-2">Members</h3>
                    {#if members.length === 0}
                      <p class="text-sm text-muted">No members yet.</p>
                    {:else}
                      <ul class="flex flex-col gap-1">
                        {#each members as member (member.userId)}
                          <li class="flex items-center gap-3 text-sm py-1">
                            <span class="flex-1 truncate">{member.displayName ?? member.email}</span>
                            <form method="POST" action="?/setRole" use:enhance>
                              <input type="hidden" name="teamId" value={team.id} />
                              <input type="hidden" name="userId" value={member.userId} />
                              <select
                                name="role"
                                aria-label="Role for {member.displayName ?? member.email}"
                                class="border border-subtle rounded-lg px-2 py-1 text-xs"
                                onchange={(e) => (e.currentTarget as HTMLSelectElement).form?.requestSubmit()}
                              >
                                <option value="member" selected={member.role === 'member'}>Member</option>
                                <option value="team_admin" selected={member.role === 'team_admin'}>Team admin</option>
                              </select>
                            </form>
                            <form method="POST" action="?/removeMember" use:enhance>
                              <input type="hidden" name="teamId" value={team.id} />
                              <input type="hidden" name="userId" value={member.userId} />
                              <button type="submit" class="pill-btn pill-btn-ghost text-xs text-red-600">Remove</button>
                            </form>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>

                  {#if available.length > 0}
                    <form method="POST" action="?/addMember" use:enhance class="flex items-end gap-2">
                      <input type="hidden" name="teamId" value={team.id} />
                      <div>
                        <label for="userId-{team.id}" class="block text-xs font-medium text-gray-700 mb-1">
                          Add member
                        </label>
                        <select
                          id="userId-{team.id}"
                          name="userId"
                          class="border border-subtle rounded-lg px-2 py-1 text-sm"
                        >
                          {#each available as user (user.id)}
                            <option value={user.id}>{user.displayName ?? user.email}</option>
                          {/each}
                        </select>
                      </div>
                      <div>
                        <label for="role-{team.id}" class="block text-xs font-medium text-gray-700 mb-1">Role</label>
                        <select id="role-{team.id}" name="role" class="border border-subtle rounded-lg px-2 py-1 text-sm">
                          <option value="member">Member</option>
                          <option value="team_admin">Team admin</option>
                        </select>
                      </div>
                      <button type="submit" class="pill-btn pill-btn-ghost text-xs">Add</button>
                    </form>
                  {:else if users.length === 0}
                    <p class="text-xs text-muted">No users exist yet.</p>
                  {:else}
                    <p class="text-xs text-muted">Every user is already a member of this team.</p>
                  {/if}

                  <div class="border-t border-subtle-light pt-4">
                    {#if confirmingDeleteId === team.id}
                      <form method="POST" action="?/delete" use:enhance={enhanceDelete} class="flex flex-col gap-2 max-w-sm">
                        <input type="hidden" name="teamId" value={team.id} />
                        <p class="text-sm text-red-700">
                          Its {team.projectCount} projects will become unassigned, not deleted.
                        </p>
                        <label for="confirmName-{team.id}" class="text-sm text-gray-700">
                          Type <span class="font-mono font-semibold">{team.name}</span> to confirm:
                        </label>
                        <input
                          id="confirmName-{team.id}"
                          name="confirmName"
                          type="text"
                          autocomplete="off"
                          bind:value={confirmName}
                          aria-label="Type the team name to confirm"
                          class="border border-subtle rounded-lg px-2 py-1 text-sm"
                        />
                        <div class="flex gap-2">
                          <button
                            type="submit"
                            disabled={confirmName !== team.name}
                            class="pill-btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs self-start"
                          >Delete permanently</button>
                          <button type="button" class="pill-btn pill-btn-ghost text-xs" onclick={cancelDelete}>Cancel</button>
                        </div>
                      </form>
                    {:else}
                      <button
                        type="button"
                        class="pill-btn pill-btn-ghost text-xs text-red-600"
                        onclick={() => startDelete(team.id)}
                      >Delete team</button>
                    {/if}
                  </div>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}
