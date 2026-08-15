import type { ServerLoadEvent } from '@sveltejs/kit';
import { createApi } from '$lib/server/api';
import type { Project } from '../app.d';

export async function load({ url, locals }: ServerLoadEvent) {
  const api = createApi(locals.sessionToken, locals.clientIp);

  let projects: Project[] = [];
  let apiError: string | null = null;

  // Delta §D2. This layout load runs for EVERY route, including
  // /change-password. Under plan 058b a mid-reset session is refused on every
  // non-allowlisted route, so getProjects() answers 403
  // password_change_required — and the catch below would report "Cannot reach
  // the Flackyness API" on the one page the user must use to recover, while
  // the API is healthy and answering exactly as designed. There is also
  // nothing to show a user who cannot read projects yet, so skip the call.
  //
  // The `locals.user &&` half is load-bearing and was ADDED 2026-08-15, during
  // execution — `!locals.user?.mustChangePassword` alone is `true` for an
  // ANONYMOUS caller, and this layout runs for /login too (Task 3's gate lets
  // /login through by design, so the gate cannot be relied on to stop this).
  // With no session, api.ts falls back to READ_TOKEN or an anonymous request,
  // and anonymous API reads are UNSCOPED (AGENTS.md: "Anonymous callers stay
  // unscoped" — true whether or not READ_TOKEN is set). The nav would
  // therefore render every project name on the instance to a visitor sitting
  // on the sign-in page. Skip the fetch unless somebody is actually signed in.
  if (locals.user && !locals.user.mustChangePassword) {
    try {
      projects = await api.getProjects();
    } catch {
      apiError = 'Cannot reach the Flackyness API. Showing an empty dashboard.';
    }
  }

  // NOTE: `projects` is ALREADY team-scoped by the API (plan 058) — this
  // filter is a UI convenience for a multi-team user narrowing their view,
  // never a security control. Do not let it become one: a client-supplied
  // ?team= must not be able to widen what the API returned.
  const teamFilter = url.searchParams.get('team');
  const visible = teamFilter ? projects.filter((p) => p.teamId === teamFilter) : projects;

  const selectedProjectId = url.searchParams.get('project') || visible[0]?.id || null;
  const selectedProject = visible.find((p) => p.id === selectedProjectId) || visible[0] || null;

  return {
    projects: visible,
    selectedProject,
    apiError,
    user: locals.user,
    teams: locals.teams,
    activeTeam: teamFilter,
  };
}
