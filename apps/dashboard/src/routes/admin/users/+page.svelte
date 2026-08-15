<script lang="ts">
  import type { PageData } from './$types';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import TokenReveal from '$lib/components/TokenReveal.svelte';
  import { formatDateTime } from '$lib/format';

  // Manual form-result type (Global Constraint 3, matching admin/teams): every
  // action here returns either `{ success: true }` (plus temporaryPassword +
  // warning for create/resetPassword) or `toFail`'s `{ error }`. One shared
  // shape covers all four actions — the page doesn't need to know which action
  // ran to render `form.error` into the single alert region, or the reveal
  // when a password comes back.
  interface UsersFormResult {
    success?: boolean;
    error?: string;
    temporaryPassword?: string;
    warning?: string;
  }
  interface Props {
    data: PageData;
    form: UsersFormResult | null;
  }
  let { data, form }: Props = $props();

  const users = $derived(data.users);

  // null = no user's delete confirmation is showing. Only one at a time.
  let confirmingDeleteId = $state<string | null>(null);
  let confirmEmail = $state('');

  function startDelete(userId: string) {
    confirmingDeleteId = userId;
    confirmEmail = '';
  }
  function cancelDelete() {
    confirmingDeleteId = null;
    confirmEmail = '';
  }

  // A successful delete removes the row entirely, so there's nothing left to
  // confirm; a rejected/failed delete (e.g. the last-admin 409, or a typed
  // email that doesn't match) leaves the confirm affordance open so the
  // operator sees the inline error next to where they were, same idea as
  // admin/teams' enhanceDelete.
  const enhanceDelete: SubmitFunction = () => async ({ result, update }) => {
    await update();
    if (result.type === 'success') {
      confirmingDeleteId = null;
      confirmEmail = '';
    }
  };
</script>

<svelte:head>
  <title>Users · Admin | Flackyness</title>
</svelte:head>

<div class="mb-8">
  <a href="/admin" class="text-sm text-purple-600 hover:underline">&larr; Back to admin</a>
  <h1 class="text-2xl font-bold text-gray-900 mt-2">Users</h1>
  <p class="text-muted">Manage user accounts, global admin access, and passwords.</p>
</div>

{#if form?.error}
  <div role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-6 max-w-2xl">
    {form.error}
  </div>
{/if}

{#if form?.success && form.temporaryPassword}
  <div class="mb-6 max-w-2xl">
    <TokenReveal token={form.temporaryPassword} warning={form.warning ?? ''} label="Temporary password" />
  </div>
{/if}

<!-- Create user -->
<section class="card p-6 max-w-lg mb-8">
  <h2 class="text-lg font-semibold text-gray-900 mb-4">Create user</h2>
  <form method="POST" action="?/create" use:enhance class="flex flex-col gap-3">
    <div>
      <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        required
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
    </div>
    <div>
      <label for="displayName" class="block text-sm font-medium text-gray-700 mb-1">
        Display name <span class="text-muted">(optional)</span>
      </label>
      <input
        id="displayName"
        name="displayName"
        type="text"
        class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
      />
    </div>
    <label class="flex items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" name="isGlobalAdmin" />
      Global admin
    </label>
    <button type="submit" class="pill-btn pill-btn-primary self-start">Create user</button>
  </form>
</section>

{#if users.length === 0}
  <div class="card p-12 text-center">
    <h3 class="text-lg font-semibold text-gray-900 mb-2">No users yet</h3>
    <p class="text-muted">Create a user above to give someone access to the dashboard.</p>
  </div>
{:else}
  <div class="card overflow-hidden">
    <table class="w-full">
      <thead>
        <tr class="text-left text-xs text-muted uppercase tracking-wider border-b border-subtle-light bg-gray-50">
          <th class="py-4 px-4 font-medium">Email</th>
          <th class="py-4 px-4 font-medium">Display name</th>
          <th class="py-4 px-4 font-medium">Global admin</th>
          <th class="py-4 px-4 font-medium">Teams</th>
          <th class="py-4 px-4 font-medium">Last login</th>
          <th class="py-4 px-4 font-medium"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        {#each users as u (u.id)}
          <tr class="hover:bg-gray-50 transition-colors">
            <td class="py-4 px-4 font-medium text-gray-900">{u.email}</td>
            <td class="py-4 px-4 text-muted">{u.displayName ?? '—'}</td>
            <td class="py-4 px-4 text-muted">{u.isGlobalAdmin ? 'Yes' : 'No'}</td>
            <td class="py-4 px-4 text-muted">
              {u.teams.length === 0 ? '—' : u.teams.map((t) => t.name).join(', ')}
            </td>
            <td class="py-4 px-4 text-muted">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</td>
            <td class="py-4 px-4">
              <div class="flex items-center justify-end gap-2">
                <form method="POST" action="?/toggleGlobalAdmin" use:enhance>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="isGlobalAdmin" value={(!u.isGlobalAdmin).toString()} />
                  <button type="submit" class="pill-btn pill-btn-ghost text-xs">
                    {u.isGlobalAdmin ? 'Remove global admin' : 'Make global admin'}
                  </button>
                </form>
                <form method="POST" action="?/resetPassword" use:enhance>
                  <input type="hidden" name="userId" value={u.id} />
                  <button type="submit" class="pill-btn pill-btn-ghost text-xs">Reset password</button>
                </form>
                {#if confirmingDeleteId === u.id}
                  <div class="flex flex-col items-end gap-1">
                    <span class="text-xs text-red-700">
                      Type <span class="font-mono font-semibold">{u.email}</span> to confirm
                    </span>
                    <form method="POST" action="?/delete" use:enhance={enhanceDelete} class="flex items-center gap-2">
                      <input type="hidden" name="userId" value={u.id} />
                      <input
                        name="confirmEmail"
                        type="text"
                        autocomplete="off"
                        bind:value={confirmEmail}
                        aria-label="Type the email to confirm"
                        class="border border-subtle rounded-lg px-2 py-1 text-xs"
                      />
                      <button
                        type="submit"
                        disabled={confirmEmail !== u.email}
                        class="pill-btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                      >
                        Confirm delete
                      </button>
                      <button type="button" class="pill-btn pill-btn-ghost text-xs" onclick={cancelDelete}>
                        Cancel
                      </button>
                    </form>
                  </div>
                {:else}
                  <button
                    type="button"
                    class="pill-btn pill-btn-ghost text-xs text-red-600"
                    onclick={() => startDelete(u.id)}
                  >Delete</button>
                {/if}
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
