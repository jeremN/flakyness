import postgres from 'postgres';

/**
 * Cross-file, cross-connection critical-section lock for the test suite,
 * built on Postgres session-level advisory locks (`pg_advisory_lock` /
 * `pg_advisory_unlock`).
 *
 * Why this exists: vitest's default forks pool runs each test FILE in its
 * own OS process, all pointed at the same Postgres instance
 * (`flackyness-pg-5433`). Two files that both mutate global, ambient state —
 * e.g. "which users have `isGlobalAdmin = true`" — can interleave: one
 * file's read-modify-restore window races another file's concurrent write.
 * An in-process mutex (a JS `Mutex` class, a module-level promise chain)
 * cannot close this gap, because the two callers are different OS
 * processes with no shared memory. `pg_advisory_lock` is a DATABASE-level
 * lock keyed by an integer, visible to every connection against that
 * database regardless of which process or pool it came from — exactly the
 * cross-process serialisation primitive this needs.
 *
 * Session-level advisory locks are tied to the CONNECTION that took them:
 * `pg_advisory_unlock` only releases a lock held by the backend session
 * that called `pg_advisory_lock` on it. Postgres.js's normal pooled client
 * (`db` in `../db`, or a bare `postgres(url)` instance used directly) picks
 * whichever idle connection is free for each query — so a naive
 * `db.execute('select pg_advisory_lock($1)', ...)` followed later by
 * `db.execute('select pg_advisory_unlock($1)', ...)` can silently issue the
 * unlock on a DIFFERENT backend than the one holding the lock, which is a
 * no-op: the lock stays held (until that connection closes) and every
 * future acquire attempt against the same key blocks or, worse, the
 * `finally` "unlock" appears to succeed while doing nothing.
 * `sql.reserve()` (postgres.js) hands back ONE connection, held exclusively
 * until `.release()`, so issuing both the lock and the unlock through that
 * same reserved handle guarantees they run on the same session.
 *
 * Deliberately a SEPARATE connection pool from `../db`'s `db` export: the
 * work done *while holding the lock* (HTTP requests through `app.request`,
 * which themselves query the database via the pooled `db` client) must be
 * free to use that pool concurrently without contending for the one
 * connection reserved for the lock itself.
 */
let lockClient: ReturnType<typeof postgres> | null = null;

function getLockClient(): ReturnType<typeof postgres> {
  if (!lockClient) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    // A single physical connection is all this ever needs — it exists only
    // to serialise a handful of test critical sections, never to carry
    // application load.
    lockClient = postgres(connectionString, { max: 1 });
  }
  return lockClient;
}

/**
 * Shared key for "a global-admin flag is being mutated ambiently" critical
 * sections. Every caller that reads-then-writes `users.is_global_admin`
 * across the whole table (not scoped to a single row it owns) MUST wrap
 * that work in `withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, ...)` — a lock only
 * serialises callers who present the SAME key. Picked with no special
 * meaning; it only needs to be a stable, collision-free `int4`-range
 * integer shared by every caller.
 */
export const GLOBAL_ADMIN_LOCK_KEY = 958_304_501;

/**
 * Runs `run()` while holding a Postgres session-level advisory lock keyed
 * by `key`, serialising it against every other concurrent
 * `withAdvisoryLock(key, ...)` caller — in this process or any other
 * connected to the same database. Reserves and releases a dedicated
 * connection per call (see the module comment for why session affinity is
 * required); acquiring the lock itself blocks in Postgres until a
 * concurrent holder releases it, so callers pay real wall-clock wait time
 * here rather than racing.
 */
export async function withAdvisoryLock<T>(key: number, run: () => Promise<T>): Promise<T> {
  const client = getLockClient();
  const reserved = await client.reserve();
  try {
    await reserved`select pg_advisory_lock(${key})`;
    try {
      return await run();
    } finally {
      await reserved`select pg_advisory_unlock(${key})`;
    }
  } finally {
    reserved.release();
  }
}
