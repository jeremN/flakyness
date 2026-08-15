import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const project = { id: 'p1', name: 'Proj', stats: { totalRuns: 0, activeFlakyTests: 0 } } as any;

// Layout half of PageData (root +layout.server.ts, Global Constraint 1):
// `data` for this route = { projects, selectedProject, apiError } ∪ { project, rules }.
const layout = {
  projects: [],
  selectedProject: { id: 'p1', name: 'Proj', createdAt: '2026-01-01T00:00:00Z', teamId: null },
  apiError: null,
  // user/teams/activeTeam: added by plan 059 Task 6's +layout.server.ts — not
  // read by this page, present only so the fixture type-checks.
  user: null,
  teams: [],
  activeTeam: null,
};

function rule(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'r1', projectId: 'p1', position: 0, name: null, enabled: true,
    selectorBranch: 'main', selectorFile: null, selectorTag: null,
    action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: 0.3,
    minRuns: 5, windowDays: 14, consecutiveFailures: null, ttlDays: null,
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

describe('admin rules page', () => {
  it('lists rules in order with their summaries', async () => {
    render(Page, {
      props: {
        data: {
          ...layout,
          project,
          rules: [
            rule(),
            rule({ id: 'r2', action: 'exempt', conditionType: null, flakeThreshold: null, minRuns: null, windowDays: null, selectorBranch: null, selectorFile: 'release/*' }),
          ],
        },
        form: null,
      },
    });
    await expect.element(page.getByText('main · flake ≥ 0.30 over ≥ 5 runs / 14d')).toBeInTheDocument();
    await expect.element(page.getByText('exempt · release/*')).toBeInTheDocument();
  });

  it('shows the empty state when there are no rules', async () => {
    render(Page, { props: { data: { ...layout, project, rules: [] }, form: null } });
    await expect.element(page.getByText(/No rules yet/)).toBeInTheDocument();
  });

  it('opens the editor with flake_rate fields when editing a flake_rate rule', async () => {
    render(Page, { props: { data: { ...layout, project, rules: [rule()] }, form: null } });
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect.element(page.getByLabelText('Threshold (0–1)')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Min runs (1–100)')).toBeInTheDocument();
  });

  it('hides condition fields when editing an exempt rule', async () => {
    render(Page, {
      props: {
        data: { ...layout, project, rules: [rule({ action: 'exempt', conditionType: null, flakeThreshold: null, minRuns: null, windowDays: null })] },
        form: null,
      },
    });
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect.element(page.getByLabelText('Threshold (0–1)')).not.toBeInTheDocument();
    await expect.element(page.getByLabelText('Condition')).not.toBeInTheDocument();
  });

  it('disables the up arrow on the first rule', async () => {
    render(Page, { props: { data: { ...layout, project, rules: [rule(), rule({ id: 'r2' })] }, form: null } });
    await expect.element(page.getByRole('button', { name: 'Move up' }).first()).toBeDisabled();
  });
});
