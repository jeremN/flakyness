<script lang="ts">
  import { enhance } from '$app/forms';

  // Manual form-result type (Global Constraint 3) — mirrors admin/new's
  // CreateFormResult. `password` is deliberately absent: the action never
  // returns it, so there is nothing here to accidentally re-render.
  interface LoginFormResult {
    email?: string;
    error?: string;
  }
  interface Props {
    form: LoginFormResult | null;
  }

  let { form }: Props = $props();
</script>

<svelte:head>
  <title>Log in | Flackyness</title>
</svelte:head>

<div class="flex items-center justify-center min-h-[70vh]">
  <div class="card p-8 w-full max-w-sm flex flex-col gap-4">
    <div class="text-center">
      <h1 class="text-2xl font-bold text-gray-900">Flackyness</h1>
      <p class="text-muted text-sm mt-1">Sign in to your account</p>
    </div>

    {#if form?.error}
      <div role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {form.error}
      </div>
    {/if}

    <form method="POST" use:enhance class="flex flex-col gap-4">
      <div>
        <label for="email" class="block text-sm font-medium text-gray-700 mb-1">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autocomplete="email"
          required
          value={form?.email ?? ''}
          class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label for="password" class="block text-sm font-medium text-gray-700 mb-1">Password</label>
        <!-- No `value` binding: a failed submit must not put the submitted
             password back in the DOM. -->
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          class="w-full border border-subtle rounded-lg px-3 py-2 text-sm"
        />
      </div>
      <button type="submit" class="pill-btn pill-btn-primary w-full justify-center">Sign in</button>
    </form>
  </div>
</div>
