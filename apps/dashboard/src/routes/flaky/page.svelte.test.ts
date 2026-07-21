import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import type { FlakyTest } from '../../app.d';

// PageData for /flaky = layout `{ projects, selectedProject, apiError }` merged with the page
// load union; every fixture below sets `currentProject: project` (non-null Project) so it matches
// the `{ flakyTests: FlakyTest[], currentProject: Project, status, canMute }` branch uniformly.
// `row()` is annotated `: FlakyTest` so `status` stays the literal union, not widened `string`.
const project = { id: 'p1', name: 'Proj', createdAt: '2026-01-01T00:00:00Z' };
const row = (over: Partial<FlakyTest> = {}): FlakyTest => ({ id: '1', testName: 't', testFile: 'f.spec.ts',
  flakeRate: '0.2', totalRuns: 10, flakeCount: 2, firstDetected: '2026-03-01T00:00:00Z',
  lastSeen: '2026-03-15T10:00:00Z', status: 'active', ...over });
const base = { projects: [], selectedProject: project, apiError: null, currentProject: project };

describe('flaky/+page', () => {
  it('shows "No active flaky tests!" for an empty active list', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [], status: 'active', canMute: false } } });
    await expect.element(page.getByText('No active flaky tests!')).toBeInTheDocument();
  });

  it('shows "No flaky tests found." for an empty resolved list', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [], status: 'resolved', canMute: false } } });
    await expect.element(page.getByText('No flaky tests found.')).toBeInTheDocument();
  });

  it('hides Mute actions when canMute is false', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [row()], status: 'active', canMute: false } } });
    await expect.element(page.getByRole('button', { name: 'Mute' })).not.toBeInTheDocument();
  });

  it('shows a Mute button for an active row when canMute is true', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [row({ status: 'active' })], status: 'active', canMute: true } } });
    await expect.element(page.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
  });

  it('shows an Unmute button for an ignored row when canMute is true', async () => {
    render(Page, { props: { data: { ...base, flakyTests: [row({ status: 'ignored' })], status: 'ignored', canMute: true } } });
    await expect.element(page.getByRole('button', { name: 'Unmute' })).toBeInTheDocument();
  });
});
