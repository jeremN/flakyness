import { describe, it, expect, vi } from 'vitest';
import { readable } from 'svelte/store';
import { createRawSnippet } from 'svelte';
// The query string here is load-bearing: it lets tests assert that project-link
// hrefs (built via `projectHref` -> `withQueryParam`) both PRESERVE an existing
// param (`team=t1`) and SET `project=` rather than appending a duplicate. A
// bare `/flaky` mock would leave that round-trip unexercised (finding #1, task
// 6 review round 1).
vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/flaky?team=t1') }) }));
import { render } from 'vitest-browser-svelte';
import { page as vitestPage } from 'vitest/browser';
import Layout from './+layout.svelte';

// LayoutData = { projects: Project[], selectedProject: Project | null, apiError: string | null,
// user: SessionUser | null, teams: TeamSummary[], activeTeam: string | null }. `children` is a
// REQUIRED Snippet prop, so every render passes a no-op snippet; the tested UI (project list,
// switcher, nav, user menu) all renders outside `{@render children()}`.
//
// `project` deliberately carries a non-null teamId (t1) — Task 1 gave most dashboard fixtures
// `teamId: null` purely for compile reasons, and building the Unassigned-grouping tests on an
// all-null fixture set would test nothing (every project would silently fall into the same
// bucket). `unassignedProject` is the dedicated teamId: null fixture those tests use instead.
const project = { id: 'p1', name: 'Proj One', createdAt: '2026-01-01T00:00:00Z', teamId: 't1' };
const project2 = { id: 'p3', name: 'Proj Two', createdAt: '2026-01-03T00:00:00Z', teamId: 't1' };
const unassignedProject = { id: 'p2', name: 'Unassigned Proj', createdAt: '2026-01-02T00:00:00Z', teamId: null };

const member = { id: 'u1', email: 'member@example.com', displayName: null, isGlobalAdmin: false, mustChangePassword: false };
const admin = { ...member, id: 'u2', email: 'admin@example.com', isGlobalAdmin: true };

const teamA = { id: 't1', name: 'Team Alpha', role: 'member' as const };
const teamB = { id: 't2', name: 'Team Beta', role: 'team_admin' as const };

const children = createRawSnippet(() => ({ render: () => '<span></span>' }));
const data = (over: Record<string, unknown> = {}) => ({
  projects: [],
  selectedProject: project,
  apiError: null,
  user: member,
  teams: [teamA],
  activeTeam: null,
  ...over,
});

describe('+layout', () => {
  it('renders the project list when there are projects', async () => {
    render(Layout, { props: { children, data: data({ projects: [project] }) } });
    await expect.element(vitestPage.getByRole('link', { name: 'Proj One' })).toBeInTheDocument();
  });

  // Finding #1 (task 6 review round 1): projectHref had zero navigation
  // coverage — `return '#';` left the whole suite green. This single
  // assertion pins the function is called, the existing `team=t1` param
  // survives, and `project=` is SET (not appended to an existing one).
  //
  // Finding #2 (task 6 review round 2): the FIRST version of this test only
  // rendered one project against one mocked URL, so it pinned a coincidence —
  // a body hardcoded to `return '/flaky?team=t1&project=p1';`, ignoring both
  // its arguments, also made it pass. Rendering a SECOND project with a
  // different id closes that gap: a hardcoded literal cannot produce two
  // different values for two different links, so this table proves the
  // function actually uses its `projectId` argument (and, via `$page.url`,
  // the current URL) rather than returning a fixed string. `withQueryParam`'s
  // own replace-vs-append property is already unit-tested in isolation
  // (`href.test.ts`); this test's job is only to prove `projectHref` is wired
  // to it, not to re-prove that property here.
  it("sets each project link's href from the current URL, preserving other params", async () => {
    render(Layout, { props: { children, data: data({ projects: [project, project2] }) } });
    await expect
      .element(vitestPage.getByRole('link', { name: 'Proj One' }))
      .toHaveAttribute('href', '/flaky?team=t1&project=p1');
    await expect
      .element(vitestPage.getByRole('link', { name: 'Proj Two' }))
      .toHaveAttribute('href', '/flaky?team=t1&project=p3');
  });

  // Minor #3 (task 6 review round 1): isSelectedProject had zero assertion
  // coverage — `return true;` left the whole suite green. Mirrors the
  // existing nav-link assertion ("applies the active styling to the
  // current-page nav link, not the others", below) and TeamSwitcher's
  // active-team assertions — named, not line-numbered, since line references
  // go stale as the file grows (task 6 review round 2, Minor).
  it('marks only the selected project link as current', async () => {
    render(Layout, {
      props: { children, data: data({ projects: [project, project2], selectedProject: project }) },
    });
    await expect.element(vitestPage.getByRole('link', { name: 'Proj One' })).toHaveAttribute('aria-current', 'page');
    await expect.element(vitestPage.getByRole('link', { name: 'Proj Two' })).not.toHaveAttribute('aria-current');
  });

  it('hides the project list when there are no projects', async () => {
    render(Layout, { props: { children, data: data({ projects: [] }) } });
    await expect.element(vitestPage.getByRole('heading', { name: 'Projects' })).not.toBeInTheDocument();
  });

  it('renders the apiError banner when apiError is set', async () => {
    render(Layout, { props: { children, data: data({ apiError: 'API unreachable' }) } });
    await expect.element(vitestPage.getByText('API unreachable')).toBeInTheDocument();
  });

  it('applies the active styling to the current-page nav link, not the others', async () => {
    render(Layout, { props: { children, data: data() } });
    // $app/stores is mocked to url=/flaky, so `isActive('/flaky')` is true and the
    // 'Flaky Tests' nav link takes the active branch (`bg-purple-50 text-purple-700`).
    await expect.element(vitestPage.getByRole('link', { name: /Flaky Tests/ })).toHaveClass('bg-purple-50');
    // a non-active item must NOT get the active styling (guards the ternary discriminating).
    await expect.element(vitestPage.getByRole('link', { name: /Overview/ })).not.toHaveClass('bg-purple-50');
  });

  describe('the "Unassigned" project group (plan 059 Task 6, Step 2b — a Global Constraint)', () => {
    it('appears for a global admin when an unassigned project exists', async () => {
      render(Layout, {
        props: { children, data: data({ user: admin, projects: [project, unassignedProject] }) },
      });

      await expect.element(vitestPage.getByRole('heading', { name: 'Unassigned' })).toBeInTheDocument();
      await expect.element(vitestPage.getByRole('link', { name: 'Unassigned Proj' })).toBeInTheDocument();
    });

    it('does not appear for a global admin when there is no unassigned project (no empty heading)', async () => {
      render(Layout, {
        props: { children, data: data({ user: admin, projects: [project] }) },
      });

      await expect.element(vitestPage.getByRole('heading', { name: 'Unassigned' })).not.toBeInTheDocument();
    });

    it('does not appear for a non-admin even if the project list somehow contains an unassigned one', async () => {
      render(Layout, {
        props: { children, data: data({ user: member, projects: [project, unassignedProject] }) },
      });

      await expect.element(vitestPage.getByRole('heading', { name: 'Unassigned' })).not.toBeInTheDocument();
      await expect.element(vitestPage.getByRole('link', { name: 'Unassigned Proj' })).not.toBeInTheDocument();
    });
  });

  describe('admin nav links', () => {
    it('shows the Teams and Users links for a global admin', async () => {
      render(Layout, { props: { children, data: data({ user: admin }) } });

      // exact: true (finding #4, task 6 review round 1) — a substring match
      // also resolves "All teams" once the switcher renders for a multi-team
      // admin, which would make this a strict-mode violation with >=2 teams.
      await expect.element(vitestPage.getByRole('link', { name: 'Teams', exact: true })).toBeInTheDocument();
      await expect.element(vitestPage.getByRole('link', { name: 'Users' })).toBeInTheDocument();
    });

    it('hides the Teams and Users links for a non-admin member', async () => {
      render(Layout, { props: { children, data: data({ user: member }) } });

      await expect.element(vitestPage.getByRole('link', { name: 'Teams', exact: true })).not.toBeInTheDocument();
      await expect.element(vitestPage.getByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    });
  });

  describe('team switcher integration', () => {
    it('is absent for a single-team user', async () => {
      render(Layout, { props: { children, data: data({ teams: [teamA] }) } });
      await expect.element(vitestPage.getByText('All teams')).not.toBeInTheDocument();
    });

    it('is present for a multi-team user', async () => {
      render(Layout, { props: { children, data: data({ teams: [teamA, teamB] }) } });
      await expect.element(vitestPage.getByText('All teams')).toBeInTheDocument();
    });
  });

  describe('user menu and sign-out', () => {
    it("shows the signed-in user's display name when set", async () => {
      render(Layout, { props: { children, data: data({ user: { ...member, displayName: 'Ada Lovelace' } }) } });
      await expect.element(vitestPage.getByText('Ada Lovelace')).toBeInTheDocument();
    });

    it("falls back to the signed-in user's email when displayName is null", async () => {
      render(Layout, { props: { children, data: data({ user: { ...member, displayName: null } }) } });
      await expect.element(vitestPage.getByText(member.email)).toBeInTheDocument();
    });

    it('renders a sign-out form that POSTs to /logout', async () => {
      render(Layout, { props: { children, data: data() } });

      // Raw DOM query (no accessible-role query for a plain <form>) — mirrors
      // login/page.svelte.test.ts's "submits via a standard POST form" precedent.
      const form = document.querySelector('form[action="/logout"]');
      expect(form?.getAttribute('method')?.toUpperCase()).toBe('POST');
      await expect.element(vitestPage.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    });
  });

  describe('app chrome gated on data.user (plan 059 Task 6, Step 3b)', () => {
    it('renders the nav when data.user is set', async () => {
      render(Layout, { props: { children, data: data() } });
      await expect.element(vitestPage.getByRole('link', { name: 'Admin' })).toBeInTheDocument();
    });

    it('renders NO nav link and NO project link when nobody is signed in', async () => {
      render(Layout, {
        props: { children, data: data({ user: null, teams: [], projects: [project] }) },
      });

      // Absence of a SPECIFIC nav link, not merely "some wrapper is missing" —
      // the latter would still pass if the markup moved rather than disappeared.
      await expect.element(vitestPage.getByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
      // Guards the project selector half: even though `projects` is non-empty
      // in this fixture, the whole sidebar (and therefore its project list)
      // must not render for an anonymous caller.
      await expect.element(vitestPage.getByRole('link', { name: 'Proj One' })).not.toBeInTheDocument();
    });
  });

  describe('sidebar scroll containment keeps the window as the scroller (plan 059 Task 6 review round 2, Important #1)', () => {
    // An EARLIER version of this fix made the OUTER wrapper `h-screen`, which
    // silently broke SvelteKit's scroll-to-top-on-navigate and back/forward
    // restoration (the router only ever manages the WINDOW's scroll position,
    // never an inner container's `scrollTop` — see the comment on the outer
    // <div> in +layout.svelte). The corrected version bounds <aside> itself
    // (`sticky top-0 h-screen`) and leaves the outer wrapper at
    // `min-h-screen`, so the window stays the scroller.
    //
    // This asserts classList membership ONLY, not computed style — verified
    // by hand that this harness cannot honestly assert the latter. A probe
    // rendering this same layout and reading `getComputedStyle` on an element
    // carrying `class="flex ..."` returned `display: "block"`, and on
    // `class="... sticky ..."` returned `position: "static"`: the two
    // stylesheets present in this render totalled 36 CSS rules combined —
    // consistent with Svelte's per-component scoped `<style>` output, not
    // Tailwind's generated utility layer, which is thousands of rules in the
    // real app. Tailwind's utility CSS is not applied in this render context,
    // so a `getComputedStyle` assertion here would silently pass or fail for
    // reasons unrelated to this component's classes — theatre, per the
    // finding's own escape hatch. No other test in this codebase asserts
    // `getComputedStyle` for exactly this reason; every existing styling
    // assertion uses `toHaveClass` (see e.g. the "applies the active
    // styling…" test above). This test follows that precedent and pins the
    // two literal, load-bearing facts the real (Tailwind-built) app's
    // behaviour depends on: which element carries the bounding classes, and
    // which one must not. It WOULD catch the exact regression class this
    // finding describes: reverting `<aside>`'s classes, or moving
    // `h-screen` back to the outer wrapper.
    it('bounds the sidebar (not the outer wrapper) to the viewport', async () => {
      render(Layout, { props: { children, data: data() } });

      const aside = document.querySelector('aside');
      const outer = aside?.parentElement;

      expect(aside).not.toBeNull();
      expect(outer).not.toBeNull();

      // <aside> carries the bounding classes: sticky, pinned to the top, a
      // definite viewport height.
      expect(aside?.classList.contains('sticky')).toBe(true);
      expect(aside?.classList.contains('top-0')).toBe(true);
      expect(aside?.classList.contains('h-screen')).toBe(true);

      // The outer wrapper must stay content-driven (`min-h-screen`, exact
      // token — not merely a substring match, since "min-h-screen" itself
      // contains the substring "h-screen") — never `h-screen`, which would
      // reintroduce the <main> `overflow-y-auto` regression.
      expect(outer?.classList.contains('min-h-screen')).toBe(true);
      expect(outer?.classList.contains('h-screen')).toBe(false);
    });
  });
});
