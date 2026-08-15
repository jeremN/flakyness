<script lang="ts">
  import type { PageData } from './$types';
  import { enhance } from '$app/forms';
  import { MIN_PASSWORD_LENGTH } from '$lib/password-form';

  // `data` uses the generated PageData; `form` is hand-typed (Global
  // Constraint 3, matches login/+page.svelte) — no field here is ever worth
  // re-populating (Task 5 review, plan 059), unlike login's `email`.
  interface ChangePasswordFormResult {
    error?: string;
  }
  interface Props {
    data: PageData;
    form: ChangePasswordFormResult | null;
  }

  let { data, form }: Props = $props();
</script>

<svelte:head>
  <title>Change password | Flackyness</title>
</svelte:head>

<div class="flex items-center justify-center min-h-[70vh]">
  <div class="card p-8 w-full max-w-sm flex flex-col gap-4">
    <div class="text-center">
      <h1 class="text-2xl font-bold text-gray-900">
        {#if data.forced}
          You must change your password before continuing
        {:else}
          Change your password
        {/if}
      </h1>
    </div>

    {#if form?.error}
      <div role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {form.error}
      </div>
    {/if}

    <form method="POST" use:enhance class="flex flex-col gap-4">
      <div>
        <label for="currentPassword" class="block text-sm font-medium text-gray-700 mb-1">
          Current password
        </label>
        <!-- No `value` binding on any field here: a failed submit must not
             put a submitted password back in the DOM (matches login). -->
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autocomplete="current-password"
          required
          class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label for="newPassword" class="block text-sm font-medium text-gray-700 mb-1">New password</label>
        <!-- minlength is bound to $lib/password-form.ts's MIN_PASSWORD_LENGTH
             (not a hardcoded literal) so this can't silently drift from the
             server-side check — the drift this $lib extraction exists to
             prevent (Task 5 review, plan 059). -->
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength={MIN_PASSWORD_LENGTH}
          class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label for="confirmPassword" class="block text-sm font-medium text-gray-700 mb-1">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength={MIN_PASSWORD_LENGTH}
          class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
        />
      </div>
      <button type="submit" class="pill-btn pill-btn-primary w-full justify-center">Change password</button>
    </form>
  </div>
</div>
