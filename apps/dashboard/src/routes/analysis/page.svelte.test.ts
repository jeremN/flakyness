import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

// PageData for /analysis = layout `{ projects, selectedProject, apiError }` merged with the
// page load union `{ analysis: null, currentProject: null, days, threshold }` |
// `{ analysis: AnalysisResponse, currentProject: Project, days, threshold }`. `selectedProject`
// is a NON-NULL Project (see plan point 7); `currentProject` pairs with `analysis`.
const project = { id: 'p1', name: 'Proj', createdAt: '2026-01-01T00:00:00Z' };
const base = { projects: [], selectedProject: project, apiError: null, days: 14, threshold: 0.05 };

describe('analysis/+page', () => {
  it('shows "No Project Selected" when analysis is null', async () => {
    render(Page, { props: { data: { ...base, analysis: null, currentProject: null } } });
    await expect.element(page.getByText('No Project Selected')).toBeInTheDocument();
  });

  it('shows "No tests found." when allTests is empty', async () => {
    render(Page, { props: { data: { ...base, currentProject: project, analysis: {
      allTests: [], flakyTests: [], threshold: 0.05, windowDays: 14 } } } });
    await expect.element(page.getByText('No tests found.')).toBeInTheDocument();
  });

  it('renders a row per test and marks the flaky one', async () => {
    const row = (name: string, isFlaky: boolean) => ({
      testName: name, testFile: `${name}.spec.ts`, totalRuns: 5, passCount: 4,
      failCount: 1, flakyCount: isFlaky ? 1 : 0, flakeRate: isFlaky ? 0.2 : 0,
      isFlaky, lastSeen: '2026-03-15T10:00:00Z',
    });
    render(Page, { props: { data: { ...base, currentProject: project, analysis: {
      allTests: [row('a', true), row('b', false)], flakyTests: [row('a', true)],
      threshold: 0.05, windowDays: 14 } } } });
    // `exact: true` avoids strict-mode ambiguity: without it, `getByText('a')` substring-matches
    // unrelated page text (e.g. "Analysis", "Analyze"), and `getByText('Flaky')` also matches the
    // "Flaky" column header — the badge (row 1, after the header at row 0) is the isFlaky marker.
    await expect.element(page.getByText('a', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('b', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Flaky', { exact: true }).nth(1)).toBeInTheDocument();
  });
});
