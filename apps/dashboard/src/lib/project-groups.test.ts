import { describe, it, expect } from 'vitest';
import type { Project } from '../app.d';
import { partitionProjects } from './project-groups';

function project(overrides: Partial<Project> = {}): Project {
  return { id: 'p1', name: 'Project One', createdAt: '2026-01-01', teamId: 't1', ...overrides };
}

describe('partitionProjects', () => {
  it('puts a project with a teamId into assigned, not unassigned', () => {
    const result = partitionProjects([project({ id: 'p1', teamId: 't1' })]);
    expect(result.assigned.map((p) => p.id)).toEqual(['p1']);
    expect(result.unassigned).toEqual([]);
  });

  it('puts a project with teamId: null into unassigned, not assigned', () => {
    const result = partitionProjects([project({ id: 'p1', teamId: null })]);
    expect(result.unassigned.map((p) => p.id)).toEqual(['p1']);
    expect(result.assigned).toEqual([]);
  });

  it('splits a mixed list into both groups, preserving relative order in each', () => {
    const a = project({ id: 'a', teamId: 't1' });
    const b = project({ id: 'b', teamId: null });
    const c = project({ id: 'c', teamId: 't2' });
    const d = project({ id: 'd', teamId: null });

    const result = partitionProjects([a, b, c, d]);

    expect(result.assigned.map((p) => p.id)).toEqual(['a', 'c']);
    expect(result.unassigned.map((p) => p.id)).toEqual(['b', 'd']);
  });

  it('returns two empty arrays for an empty input', () => {
    expect(partitionProjects([])).toEqual({ assigned: [], unassigned: [] });
  });
});
