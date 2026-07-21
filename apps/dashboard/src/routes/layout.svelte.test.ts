import { describe, it, expect, vi } from 'vitest';
import { readable } from 'svelte/store';
import { createRawSnippet } from 'svelte';
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/flaky') }) }));
import { render } from 'vitest-browser-svelte';
import { page as vitestPage } from 'vitest/browser';
import Layout from './+layout.svelte';

// LayoutData = { projects: Project[], selectedProject: Project (NON-NULL — same layout-load
// `|| null` narrowing as PageData, plan point 7), apiError: string | null }. `children` is a
// REQUIRED Snippet prop, so every render passes a no-op snippet; the tested UI (switcher, banner,
// nav) all renders outside `{@render children()}`.
const project = { id: 'p1', name: 'Proj One', createdAt: '2026-01-01T00:00:00Z' };
const children = createRawSnippet(() => ({ render: () => '<span></span>' }));
const data = (over = {}) => ({ projects: [], selectedProject: project, apiError: null, ...over });

describe('+layout', () => {
  it('renders the project switcher when there are projects', async () => {
    render(Layout, { props: { children, data: data({ projects: [project] }) } });
    await expect.element(vitestPage.getByText('Proj One')).toBeInTheDocument();
  });

  it('hides the switcher when there are no projects', async () => {
    render(Layout, { props: { children, data: data({ projects: [] }) } });
    await expect.element(vitestPage.getByRole('combobox')).not.toBeInTheDocument();
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
});
