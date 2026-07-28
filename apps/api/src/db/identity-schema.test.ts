import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { users, sessions } from './schema';

describe('identity schema (plan 056)', () => {
  const userCols = getTableConfig(users).columns;
  const sessionCols = getTableConfig(sessions).columns;

  const col = (cols: typeof userCols, name: string) => {
    const found = cols.find((c) => c.name === name);
    if (!found) throw new Error(`column ${name} not found`);
    return found;
  };

  it('users.email is unique and not null (it is the login identity)', () => {
    const email = col(userCols, 'email');
    expect(email.isUnique).toBe(true);
    expect(email.notNull).toBe(true);
  });

  it('users.password_hash is not null — an account without a hash is unloginable-but-present', () => {
    expect(col(userCols, 'password_hash').notNull).toBe(true);
  });

  it('users.is_global_admin defaults to false — a new account is never an operator by accident', () => {
    const flag = col(userCols, 'is_global_admin');
    expect(flag.notNull).toBe(true);
    expect(flag.default).toBe(false);
  });

  it('users.must_change_password defaults to false', () => {
    const flag = col(userCols, 'must_change_password');
    expect(flag.notNull).toBe(true);
    expect(flag.default).toBe(false);
  });

  it('sessions.user_id cascades — deleting a user revokes every session they hold', () => {
    const fks = getTableConfig(sessions).foreignKeys;
    expect(fks).toHaveLength(1);
    expect(fks[0].onDelete).toBe('cascade');
  });

  it('sessions.token_hash is indexed — it is the per-request lookup key', () => {
    const idxCols = getTableConfig(sessions).indexes.flatMap((i) =>
      i.config.columns.map((c) => (c as { name: string }).name)
    );
    expect(idxCols).toContain('token_hash');
  });

  it('sessions.expires_at is not null — a session with no expiry can never be reaped', () => {
    expect(col(sessionCols, 'expires_at').notNull).toBe(true);
  });

  // expires_at drives JS expiry math (`expiresAt.getTime() <= Date.now()`).
  // A tz-naive `timestamp` column is written/read in the DB server's local
  // time, so it silently skews if the API container's TZ ever diverges from
  // the DB's — `timestamptz` is immune to that. Assert it on every new
  // timestamp column in these two tables (not just expires_at), so the
  // decision can't silently regress on the next edit to either table.
  it('users.created_at and users.last_login_at are timestamptz, not tz-naive', () => {
    expect(col(userCols, 'created_at').getSQLType()).toBe('timestamp with time zone');
    expect(col(userCols, 'last_login_at').getSQLType()).toBe('timestamp with time zone');
  });

  it('sessions.created_at, expires_at and last_seen_at are timestamptz, not tz-naive', () => {
    expect(col(sessionCols, 'created_at').getSQLType()).toBe('timestamp with time zone');
    expect(col(sessionCols, 'expires_at').getSQLType()).toBe('timestamp with time zone');
    expect(col(sessionCols, 'last_seen_at').getSQLType()).toBe('timestamp with time zone');
  });
});
