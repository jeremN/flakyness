// Stub for SvelteKit's $app/env/private in plain vitest runs.
//
// The exports are `let` bindings. ES modules export live bindings, so a value
// set with setPrivateEnv() is visible to a module that imported READ_TOKEN or
// COOKIE_SECURE before the change. Call resetPrivateEnv() in afterEach so a
// value cannot leak into the next test.
export let READ_TOKEN = '';
export let COOKIE_SECURE = '';

export function setPrivateEnv(vars: { READ_TOKEN?: string; COOKIE_SECURE?: string }): void {
  if (vars.READ_TOKEN !== undefined) READ_TOKEN = vars.READ_TOKEN;
  if (vars.COOKIE_SECURE !== undefined) COOKIE_SECURE = vars.COOKIE_SECURE;
}

export function resetPrivateEnv(): void {
  READ_TOKEN = '';
  COOKIE_SECURE = '';
}
