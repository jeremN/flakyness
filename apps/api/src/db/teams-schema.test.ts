import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { teams, teamMembers, projects } from './schema';

describe('teams schema (plan 057)', () => {
  it('teams.name is unique and not null', () => {
    const name = getTableConfig(teams).columns.find((c) => c.name === 'name')!;
    expect(name.isUnique).toBe(true);
    expect(name.notNull).toBe(true);
  });

  // Regression guard. Plan 056's Task 1 shipped these columns tz-NAIVE by
  // accident — the plan's own code sample had omitted `withTimezone` — and
  // only a review caught it, after the migration had already been generated.
  // `getSQLType()` reflects `withTimezone`, so this assertion bites on the
  // exact mistake rather than on a proxy for it.
  it('teams.created_at and team_members.created_at are timestamptz, not tz-naive', () => {
    const teamCreated = getTableConfig(teams).columns.find((c) => c.name === 'created_at')!;
    const memberCreated = getTableConfig(teamMembers).columns.find((c) => c.name === 'created_at')!;
    expect(teamCreated.getSQLType()).toBe('timestamp with time zone');
    expect(memberCreated.getSQLType()).toBe('timestamp with time zone');
  });

  it('team_members cascades from BOTH parents — a deleted user or team leaves no orphan rows', () => {
    const fks = getTableConfig(teamMembers).foreignKeys;
    expect(fks).toHaveLength(2);
    for (const fk of fks) expect(fk.onDelete).toBe('cascade');
  });

  it('team_members is unique on (user_id, team_id) — a user joins a team at most once', () => {
    const unique = getTableConfig(teamMembers).indexes.find((i) => i.config.unique);
    expect(unique).toBeDefined();
    const cols = unique!.config.columns.map((c) => (c as { name: string }).name);
    expect(cols).toEqual(expect.arrayContaining(['user_id', 'team_id']));
  });

  it('team_members.role is not null', () => {
    const role = getTableConfig(teamMembers).columns.find((c) => c.name === 'role')!;
    expect(role.notNull).toBe(true);
  });

  it('projects.team_id SET NULLs on team delete — deleting a team must never delete project data', () => {
    const fk = getTableConfig(projects).foreignKeys.find((f) =>
      f.reference().foreignTable === teams
    );
    expect(fk, 'projects has no FK to teams').toBeDefined();
    expect(fk!.onDelete).toBe('set null');
  });

  it('projects.team_id is nullable — an orphaned project is a legal state, not a corrupt one', () => {
    const teamId = getTableConfig(projects).columns.find((c) => c.name === 'team_id')!;
    expect(teamId.notNull).toBe(false);
  });
});
