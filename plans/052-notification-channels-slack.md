# Notification Channels + Slack Formatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two near-duplicate proprietary-JSON webhook senders with a channel abstraction — neutral events → per-channel formatters → one shared transport — shipping `generic` + `slack` channels with dashboard deep-links, keeping the generic payload byte-identical for existing consumers.

**Architecture:** A new `apps/api/src/services/notifications/` module: pure, node-testable units (`events`, `channel`, `links`, `formatters/{generic,slack}`, `transport`) composed by one entry point `deliverNotification` (`deliver.ts`, re-exported via `index.ts`). Channel is chosen by a hybrid rule — an explicit per-project `webhook_kind` overrides, else the host is sniffed (`hooks.slack.com` → slack, else generic). Deep-links come from a deployment-global `DASHBOARD_BASE_URL`, read at the route edge (`reports.ts`) and injected down, so every unit stays pure. The old `services/notifications.ts` is deleted in the final rewire.

**Tech Stack:** Hono 4.12, Drizzle ORM 0.45 + drizzle-kit 0.31 + Postgres 16, zod, Vitest 4.1.10, built-in `fetch` + `AbortSignal.timeout`. Node 24, pnpm 11, TS 7 (`apps/api`).

**Spec:** `docs/superpowers/specs/2026-07-22-notification-channels-slack-design.md`

**Advances:** STRATEGY.md roadmap **#3** (`NotificationChannel` interface + Slack formatter).

## Global Constraints

- **The `generic` formatter is a FROZEN backward-compat contract.** Its output for both event kinds must match what `services/notifications.ts` emitted before this refactor, byte-for-byte, except `dashboardUrl` on the flaky payload (was hardcoded `null`; now carries `links.dashboard`, still `null` when `DASHBOARD_BASE_URL` is unset). The quarantine generic payload gains **no** new field. Task 4's tests assert this with `toEqual`.
- **All notification units are pure and never throw.** `resolveWebhookKind`, `buildLinks`, formatters, and `postWebhook` degrade on bad input (`generic` / `null` links / `false`) — a malformed stored kind or base URL must never crash the ingest's background step. `postWebhook` keeps the v1 delivery contract: one best-effort POST, `Content-Type: application/json`, `AbortSignal.timeout(5000)`, no retries, no signing.
- **Env is read only at the route edge.** `process.env.DASHBOARD_BASE_URL` is read in `routes/reports.ts` and passed as `baseUrl`; no `process.env` access inside `notifications/`.
- **No new endpoint** → no `readAuth`/route-count-guard change. Reuse the existing admin PATCH route; `webhook_kind` is one more optional field.
- **`webhook_kind` is a column on `projects`** (not a child table) → no `onDelete: 'cascade'`. Decimal columns are untouched by this plan.
- **Structured logger only** (`middleware/logger.ts`), never `console.log`. zod-validate the new admin field; Drizzle query builder only.
- **Commits:** single-line conventional-commit subject, **no `Co-Authored-By` trailer**, never `--no-verify`. Work stays on branch `feat/notification-channels-slack` (already created, spec committed).
- **Environment note (this session):** the RTK hook filters `pnpm`/`vitest`/`stryker` stdout — prefix those with `rtk proxy` (e.g. `rtk proxy pnpm --filter api test`) so results read correctly. DB-backed tests (Tasks 7, 8) need a disposable Postgres via `docker run` (never `docker compose`) + `DATABASE_URL`/`ADMIN_TOKEN`; `docker rm -f` on exit. Pure-unit tasks (1–6) need neither.

---

## File Structure

**New (Tasks 1–6, pure units):**
- `apps/api/src/services/notifications/events.ts` — neutral event types (no runtime)
- `apps/api/src/services/notifications/transport.ts` (+ `.test.ts`) — shared POST
- `apps/api/src/services/notifications/channel.ts` (+ `.test.ts`) — kind resolution
- `apps/api/src/services/notifications/links.ts` (+ `.test.ts`) — deep-links
- `apps/api/src/services/notifications/formatters/generic.ts` (+ `.test.ts`)
- `apps/api/src/services/notifications/formatters/slack.ts` (+ `.test.ts`)
- `apps/api/src/services/notifications/deliver.ts` (+ `.test.ts`) — orchestration

**New (Task 7):** a generated Drizzle migration `apps/api/drizzle/0009_*.sql`.

**New (Task 8):** `apps/api/src/services/notifications/index.ts` — barrel.

**Modified:**
- `apps/api/src/db/schema.ts` (Task 7) — add `webhookKind` column
- `apps/api/src/routes/admin.ts` (+ `admin.test.ts`) (Task 7) — PATCH schema/handler/returning, GET projection
- `apps/api/src/routes/reports.ts` (Task 8) — rewire to `deliverNotification`
- **Deleted (Task 8):** `apps/api/src/services/notifications.ts`, `apps/api/src/services/notifications.test.ts`
- `docs/API.md`, `docs/STRATEGY.md`, `AGENTS.md`, `plans/README.md` (Task 9)

**Why this order stays green at every commit:** the new `notifications/*.ts` files (Tasks 1–6) live *alongside* the untouched `notifications.ts` — the file wins module resolution for `import '../services/notifications'`, so `reports.ts` keeps compiling. Only Task 8 deletes `notifications.ts` and adds `index.ts` in the **same commit** as the `reports.ts` rewire, so there is no ambiguous file-vs-directory window.

---

### Task 1: Neutral events + shared transport

**Files:**
- Create: `apps/api/src/services/notifications/events.ts`
- Create: `apps/api/src/services/notifications/transport.ts`
- Test: `apps/api/src/services/notifications/transport.test.ts`

**Interfaces:**
- Produces: `EventProject`, `FlakyTransitionEvent`, `QuarantineEvent`, `NotificationEvent` (types); `postWebhook(url: string, body: unknown): Promise<boolean>`.

- [ ] **Step 1: Write `events.ts`** (types only — no test; exercised by Tasks 4–6)

```ts
// apps/api/src/services/notifications/events.ts
export interface EventProject {
  id: string;
  name: string;
}

export interface FlakyTransitionEvent {
  kind: 'flaky_transition';
  project: EventProject;
  newlyFlaky: string[];
  newlyResolved: string[];
  run: { branch: string; commitSha: string };
}

export interface QuarantineEvent {
  kind: 'quarantine';
  transition: 'entered' | 'released';
  project: EventProject;
  testName: string;
  flakeRate: number | null;
  expiresAt: Date | null; // set only for 'entered'
}

export type NotificationEvent = FlakyTransitionEvent | QuarantineEvent;
```

- [ ] **Step 2: Write the failing transport test**

```ts
// apps/api/src/services/notifications/transport.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { postWebhook } from './transport';

afterEach(() => vi.restoreAllMocks());

describe('postWebhook', () => {
  it('POSTs JSON and returns true on a 2xx response', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const ok = await postWebhook('https://example.com/hook', { a: 1 });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      })
    );
  });

  it('returns false on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    expect(await postWebhook('https://example.com/hook', {})).toBe(false);
  });

  it('returns false when fetch rejects (network error / timeout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'));
    expect(await postWebhook('https://example.com/hook', {})).toBe(false);
  });
});
```

- [ ] **Step 3: Run it, expect FAIL** (`transport` not found)

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/transport.test.ts`
Expected: FAIL (cannot resolve `./transport`).

- [ ] **Step 4: Write `transport.ts`**

```ts
// apps/api/src/services/notifications/transport.ts
/**
 * The single best-effort webhook POST shared by every channel formatter.
 * Never throws: network error, timeout, and non-2xx all resolve to `false`,
 * so callers log-and-swallow. 5s timeout, no retries, no signing (v1 contract).
 */
export async function postWebhook(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run tests + typecheck, expect PASS**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/transport.test.ts && rtk proxy pnpm --filter api exec tsc --noEmit`
Expected: 3 passing, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/notifications/events.ts apps/api/src/services/notifications/transport.ts apps/api/src/services/notifications/transport.test.ts
git commit -m "feat(notifications): neutral event types + shared best-effort transport"
```

---

### Task 2: Channel resolver

**Files:**
- Create: `apps/api/src/services/notifications/channel.ts`
- Test: `apps/api/src/services/notifications/channel.test.ts`

**Interfaces:**
- Produces: `type WebhookKind = 'slack' | 'generic'`; `resolveWebhookKind(url: string, storedKind: string | null): WebhookKind`.
- Note: `storedKind` is typed `string | null` (not `WebhookKind | null`) so `routes/reports.ts` can pass the raw DB column with no cast; an unexpected non-null value auto-detects rather than trusting bad data.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/notifications/channel.test.ts
import { describe, it, expect } from 'vitest';
import { resolveWebhookKind } from './channel';

describe('resolveWebhookKind', () => {
  it('auto-detects a hooks.slack.com URL as slack', () => {
    expect(resolveWebhookKind('https://hooks.slack.com/services/T/B/x', null)).toBe('slack');
  });

  it('auto-detects a self-hosted Mattermost URL as generic', () => {
    expect(resolveWebhookKind('https://mattermost.internal.example/hooks/abc', null)).toBe('generic');
  });

  it('lets an explicit stored kind override auto-detection (Mattermost → slack)', () => {
    expect(resolveWebhookKind('https://mattermost.internal.example/hooks/abc', 'slack')).toBe('slack');
  });

  it('lets an explicit generic override a Slack host', () => {
    expect(resolveWebhookKind('https://hooks.slack.com/services/x', 'generic')).toBe('generic');
  });

  it('auto-detects (ignores) an unrecognized stored value', () => {
    expect(resolveWebhookKind('https://hooks.slack.com/services/x', 'bogus')).toBe('slack');
  });

  it('falls back to generic on an unparseable URL', () => {
    expect(resolveWebhookKind('not a url', null)).toBe('generic');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/channel.test.ts`
Expected: FAIL (cannot resolve `./channel`).

- [ ] **Step 3: Write `channel.ts`**

```ts
// apps/api/src/services/notifications/channel.ts
export type WebhookKind = 'slack' | 'generic';

/**
 * Decide which channel formatter to use for `url`.
 *
 * An explicit `storedKind` ('slack' | 'generic', set by the operator on the
 * project) always wins — this is how a self-hosted Mattermost URL, which
 * accepts Slack's payload but lives on a private host, opts into Slack
 * formatting. Any other value (null, or an unexpected string) falls through to
 * host sniffing: only Slack's own incoming-webhook host resolves to 'slack';
 * everything else (including Mattermost) defaults to 'generic'.
 */
export function resolveWebhookKind(url: string, storedKind: string | null): WebhookKind {
  if (storedKind === 'slack' || storedKind === 'generic') return storedKind;
  try {
    if (new URL(url).host.toLowerCase() === 'hooks.slack.com') return 'slack';
  } catch {
    // Unparseable URL — fall through to generic; delivery will best-effort fail.
  }
  return 'generic';
}
```

- [ ] **Step 4: Run tests + typecheck, expect PASS**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/channel.test.ts && rtk proxy pnpm --filter api exec tsc --noEmit`
Expected: 6 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/notifications/channel.ts apps/api/src/services/notifications/channel.test.ts
git commit -m "feat(notifications): hybrid webhook-kind resolver (explicit override + host sniff)"
```

---

### Task 3: Deep-links builder

**Files:**
- Create: `apps/api/src/services/notifications/links.ts`
- Test: `apps/api/src/services/notifications/links.test.ts`

**Interfaces:**
- Produces: `interface DeepLinks { dashboard: string | null; test: string | null }`; `buildLinks(baseUrl: string | null | undefined, testName?: string): DeepLinks`.
- Dashboard routes are `/flaky` (list) and `/tests/[testName]` (trend) — confirmed present in `apps/dashboard/src/routes/`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/notifications/links.test.ts
import { describe, it, expect } from 'vitest';
import { buildLinks } from './links';

describe('buildLinks', () => {
  it('returns all-null when no base URL is configured', () => {
    expect(buildLinks(null, 'some test')).toEqual({ dashboard: null, test: null });
    expect(buildLinks('', 'some test')).toEqual({ dashboard: null, test: null });
    expect(buildLinks(undefined)).toEqual({ dashboard: null, test: null });
  });

  it('builds dashboard and test links from a base URL', () => {
    expect(buildLinks('https://flacky.example.com', 'login test')).toEqual({
      dashboard: 'https://flacky.example.com/flaky',
      test: 'https://flacky.example.com/tests/login%20test',
    });
  });

  it('omits the test link when no test name is given', () => {
    expect(buildLinks('https://flacky.example.com')).toEqual({
      dashboard: 'https://flacky.example.com/flaky',
      test: null,
    });
  });

  it('strips trailing slashes from the base URL', () => {
    expect(buildLinks('https://flacky.example.com///', 'a').dashboard).toBe(
      'https://flacky.example.com/flaky'
    );
  });

  it('encodes special characters in the test name', () => {
    expect(buildLinks('https://x.io', 'a/b c').test).toBe('https://x.io/tests/a%2Fb%20c');
  });

  it('returns all-null for a non-http(s) or malformed base URL', () => {
    expect(buildLinks('ftp://x.io', 'a')).toEqual({ dashboard: null, test: null });
    expect(buildLinks('not a url', 'a')).toEqual({ dashboard: null, test: null });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/links.test.ts`
Expected: FAIL (cannot resolve `./links`).

- [ ] **Step 3: Write `links.ts`**

```ts
// apps/api/src/services/notifications/links.ts
export interface DeepLinks {
  dashboard: string | null;
  test: string | null;
}

/**
 * Build dashboard deep-links from the deployment-global DASHBOARD_BASE_URL.
 *
 * `baseUrl` null / empty / non-http(s) / unparseable → every link is null (the
 * backward-compatible default; today's payloads carry `dashboardUrl: null`).
 * When valid, `dashboard` points at the flaky list and `test` (when a testName
 * is given) at that test's trend page. Pure and null-safe — never throws.
 */
export function buildLinks(baseUrl: string | null | undefined, testName?: string): DeepLinks {
  const base = normalizeBase(baseUrl);
  if (!base) return { dashboard: null, test: null };
  return {
    dashboard: `${base}/flaky`,
    test: testName ? `${base}/tests/${encodeURIComponent(testName)}` : null,
  };
}

function normalizeBase(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const protocol = new URL(baseUrl).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return baseUrl.replace(/\/+$/, '');
}
```

- [ ] **Step 4: Run tests + typecheck, expect PASS**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/links.test.ts && rtk proxy pnpm --filter api exec tsc --noEmit`
Expected: 6 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/notifications/links.ts apps/api/src/services/notifications/links.test.ts
git commit -m "feat(notifications): null-safe dashboard deep-link builder"
```

---

### Task 4: Generic formatter (frozen backward-compat contract)

**Files:**
- Create: `apps/api/src/services/notifications/formatters/generic.ts`
- Test: `apps/api/src/services/notifications/formatters/generic.test.ts`

**Interfaces:**
- Consumes: `NotificationEvent` (`../events`), `DeepLinks` (`../links`).
- Produces: `formatGeneric(event: NotificationEvent, links: DeepLinks): unknown`.

- [ ] **Step 1: Write the failing test** (asserts the legacy shapes with `toEqual`)

```ts
// apps/api/src/services/notifications/formatters/generic.test.ts
import { describe, it, expect } from 'vitest';
import { formatGeneric } from './generic';
import type { FlakyTransitionEvent, QuarantineEvent } from '../events';

const flaky: FlakyTransitionEvent = {
  kind: 'flaky_transition',
  project: { id: 'p-1', name: 'demo' },
  newlyFlaky: ['test a'],
  newlyResolved: ['test c'],
  run: { branch: 'main', commitSha: 'a'.repeat(40) },
};

describe('formatGeneric — frozen backward-compat contract', () => {
  it('emits the legacy flaky_tests_changed payload with dashboardUrl null when no base URL', () => {
    expect(formatGeneric(flaky, { dashboard: null, test: null })).toEqual({
      event: 'flaky_tests_changed',
      project: { id: 'p-1', name: 'demo' },
      newlyFlaky: ['test a'],
      newlyResolved: ['test c'],
      run: { branch: 'main', commitSha: 'a'.repeat(40) },
      dashboardUrl: null,
    });
  });

  it('populates dashboardUrl from the resolved link when a base URL is set', () => {
    const body = formatGeneric(flaky, { dashboard: 'https://x.io/flaky', test: null }) as {
      dashboardUrl: string;
    };
    expect(body.dashboardUrl).toBe('https://x.io/flaky');
  });

  it('emits the legacy quarantine_entered payload (no dashboardUrl field)', () => {
    const entered: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'entered',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: 0.42,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    expect(
      formatGeneric(entered, { dashboard: 'https://x.io/flaky', test: 'https://x.io/tests/login%20test' })
    ).toEqual({
      event: 'quarantine_entered',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: 0.42,
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('maps a released transition to quarantine_released with null expiresAt', () => {
    const released: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'released',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: null,
      expiresAt: null,
    };
    const body = formatGeneric(released, { dashboard: null, test: null }) as {
      event: string;
      expiresAt: null;
    };
    expect(body.event).toBe('quarantine_released');
    expect(body.expiresAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/formatters/generic.test.ts`
Expected: FAIL (cannot resolve `./generic`).

- [ ] **Step 3: Write `generic.ts`**

```ts
// apps/api/src/services/notifications/formatters/generic.ts
import type { DeepLinks } from '../links';
import type { NotificationEvent } from '../events';

/**
 * The generic (default) webhook body — a FROZEN backward-compatibility contract.
 * These shapes match what services/notifications.ts emitted before the channel
 * refactor, so existing operator webhooks keep working byte-for-byte. The only
 * change is `dashboardUrl` on the flaky payload, which was always present as a
 * (documented, reserved) `null` and now carries `links.dashboard` when
 * DASHBOARD_BASE_URL is configured. The quarantine payload never had a
 * dashboardUrl field — do NOT add one here.
 */
export function formatGeneric(event: NotificationEvent, links: DeepLinks): unknown {
  if (event.kind === 'flaky_transition') {
    return {
      event: 'flaky_tests_changed',
      project: event.project,
      newlyFlaky: event.newlyFlaky,
      newlyResolved: event.newlyResolved,
      run: event.run,
      dashboardUrl: links.dashboard,
    };
  }
  return {
    event: event.transition === 'entered' ? 'quarantine_entered' : 'quarantine_released',
    project: event.project,
    testName: event.testName,
    flakeRate: event.flakeRate,
    expiresAt: event.expiresAt ? event.expiresAt.toISOString() : null,
  };
}
```

- [ ] **Step 4: Run tests + typecheck, expect PASS**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/formatters/generic.test.ts && rtk proxy pnpm --filter api exec tsc --noEmit`
Expected: 4 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/notifications/formatters/generic.ts apps/api/src/services/notifications/formatters/generic.test.ts
git commit -m "feat(notifications): generic formatter as frozen backward-compat contract"
```

---

### Task 5: Slack formatter

**Files:**
- Create: `apps/api/src/services/notifications/formatters/slack.ts`
- Test: `apps/api/src/services/notifications/formatters/slack.test.ts`

**Interfaces:**
- Consumes: `NotificationEvent`, `FlakyTransitionEvent`, `QuarantineEvent` (`../events`), `DeepLinks` (`../links`).
- Produces: `formatSlack(event: NotificationEvent, links: DeepLinks): { text: string; blocks: unknown[] }`.
- Contract: top-level `text` is always a non-empty mrkdwn summary (Slack's required fallback + the part Mattermost renders reliably); `blocks[0]` is a `section` whose mrkdwn text mirrors `text`. Links render as `<url|label>` when present, plain `label` when null.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/notifications/formatters/slack.test.ts
import { describe, it, expect } from 'vitest';
import { formatSlack } from './slack';
import type { FlakyTransitionEvent, QuarantineEvent } from '../events';

const flaky: FlakyTransitionEvent = {
  kind: 'flaky_transition',
  project: { id: 'p-1', name: 'demo' },
  newlyFlaky: ['login test'],
  newlyResolved: [],
  run: { branch: 'main', commitSha: 'abc' },
};

describe('formatSlack', () => {
  it('always includes a non-empty text fallback mirrored in a blocks section', () => {
    const body = formatSlack(flaky, { dashboard: null, test: null });
    expect(typeof body.text).toBe('string');
    expect(body.text.length).toBeGreaterThan(0);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn', text: body.text },
    });
  });

  it('renders the project as a mrkdwn link when a dashboard link is present', () => {
    const body = formatSlack(flaky, { dashboard: 'https://x.io/flaky', test: null });
    expect(body.text).toContain('<https://x.io/flaky|*demo*>');
    expect(body.text).toContain('login test');
  });

  it('renders the project as plain text (no link markup) when no link is present', () => {
    const body = formatSlack(flaky, { dashboard: null, test: null });
    expect(body.text).toContain('*demo*');
    expect(body.text).not.toContain('<');
  });

  it('summarizes a quarantine entered event with test link, rate and TTL date', () => {
    const entered: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'entered',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: 0.42,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const body = formatSlack(entered, { dashboard: null, test: 'https://x.io/tests/login%20test' });
    expect(body.text).toContain('🔒');
    expect(body.text).toContain('<https://x.io/tests/login%20test|login test>');
    expect(body.text).toContain('42%');
    expect(body.text).toContain('2026-08-01');
  });

  it('summarizes a quarantine released event', () => {
    const released: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'released',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: null,
      expiresAt: null,
    };
    const body = formatSlack(released, { dashboard: null, test: null });
    expect(body.text).toContain('🔓');
    expect(body.text).toContain('released');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/formatters/slack.test.ts`
Expected: FAIL (cannot resolve `./slack`).

- [ ] **Step 3: Write `slack.ts`**

```ts
// apps/api/src/services/notifications/formatters/slack.ts
import type { DeepLinks } from '../links';
import type { NotificationEvent, FlakyTransitionEvent, QuarantineEvent } from '../events';

/**
 * Slack incoming-webhook body. `text` is a plain mrkdwn summary — Slack's
 * required notification fallback and the part Mattermost (partial Block Kit
 * support) renders reliably; `blocks` is the richer rendering that degrades to
 * `text`. Deep-links render as mrkdwn `<url|label>` when present, plain `label`
 * otherwise. Slack- and Mattermost-compatible.
 */
export function formatSlack(
  event: NotificationEvent,
  links: DeepLinks
): { text: string; blocks: unknown[] } {
  const text =
    event.kind === 'flaky_transition' ? flakyText(event, links) : quarantineText(event, links);
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

function link(label: string, url: string | null): string {
  return url ? `<${url}|${label}>` : label;
}

function flakyText(event: FlakyTransitionEvent, links: DeepLinks): string {
  const project = link(`*${event.project.name}*`, links.dashboard);
  const parts: string[] = [];
  if (event.newlyFlaky.length > 0) {
    parts.push(`⚠️ ${event.newlyFlaky.length} newly flaky: ${event.newlyFlaky.join(', ')}`);
  }
  if (event.newlyResolved.length > 0) {
    parts.push(`✅ ${event.newlyResolved.length} resolved: ${event.newlyResolved.join(', ')}`);
  }
  return `${project} on \`${event.run.branch}\` — ${parts.join('  ·  ')}`;
}

function quarantineText(event: QuarantineEvent, links: DeepLinks): string {
  const project = link(`*${event.project.name}*`, links.dashboard);
  const test = link(event.testName, links.test);
  if (event.transition === 'entered') {
    const rate = event.flakeRate != null ? ` (flake rate ${(event.flakeRate * 100).toFixed(0)}%)` : '';
    const until = event.expiresAt ? `, muted until ${event.expiresAt.toISOString().slice(0, 10)}` : '';
    return `🔒 ${project}: quarantined ${test}${rate}${until}`;
  }
  return `🔓 ${project}: released ${test} from quarantine`;
}
```

- [ ] **Step 4: Run tests + typecheck, expect PASS**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/formatters/slack.test.ts && rtk proxy pnpm --filter api exec tsc --noEmit`
Expected: 5 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/notifications/formatters/slack.ts apps/api/src/services/notifications/formatters/slack.test.ts
git commit -m "feat(notifications): Slack/Mattermost formatter with text fallback + deep-links"
```

---

### Task 6: Orchestration — `deliverNotification`

**Files:**
- Create: `apps/api/src/services/notifications/deliver.ts`
- Test: `apps/api/src/services/notifications/deliver.test.ts`

**Interfaces:**
- Consumes: `resolveWebhookKind`/`WebhookKind` (`./channel`), `buildLinks` (`./links`), `formatGeneric` (`./formatters/generic`), `formatSlack` (`./formatters/slack`), `postWebhook` (`./transport`), `NotificationEvent` (`./events`).
- Produces: `interface DeliverOptions { url: string; storedKind: string | null; baseUrl: string | null | undefined; event: NotificationEvent }`; `deliverNotification(opts: DeliverOptions): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/notifications/deliver.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { deliverNotification } from './deliver';
import type { FlakyTransitionEvent } from './events';

const flaky: FlakyTransitionEvent = {
  kind: 'flaky_transition',
  project: { id: 'p-1', name: 'demo' },
  newlyFlaky: ['t'],
  newlyResolved: [],
  run: { branch: 'main', commitSha: 'abc' },
};

afterEach(() => vi.restoreAllMocks());

function captureBody() {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 200 }));
  return () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

describe('deliverNotification', () => {
  it('formats generic for a non-Slack URL (default) and returns transport success', async () => {
    const body = captureBody();
    const ok = await deliverNotification({
      url: 'https://x.io/hook',
      storedKind: null,
      baseUrl: null,
      event: flaky,
    });
    expect(ok).toBe(true);
    expect(body().event).toBe('flaky_tests_changed');
  });

  it('formats Slack when the resolved kind is slack (explicit override)', async () => {
    const body = captureBody();
    await deliverNotification({
      url: 'https://x.io/hook',
      storedKind: 'slack',
      baseUrl: null,
      event: flaky,
    });
    expect(body().text).toBeDefined();
    expect(body().blocks).toBeDefined();
  });

  it('injects deep-links into the body when a base URL is configured', async () => {
    const body = captureBody();
    await deliverNotification({
      url: 'https://x.io/hook',
      storedKind: null,
      baseUrl: 'https://d.io',
      event: flaky,
    });
    expect(body().dashboardUrl).toBe('https://d.io/flaky');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/deliver.test.ts`
Expected: FAIL (cannot resolve `./deliver`).

- [ ] **Step 3: Write `deliver.ts`**

```ts
// apps/api/src/services/notifications/deliver.ts
import { resolveWebhookKind } from './channel';
import { buildLinks } from './links';
import { formatGeneric } from './formatters/generic';
import { formatSlack } from './formatters/slack';
import { postWebhook } from './transport';
import type { NotificationEvent } from './events';

export interface DeliverOptions {
  url: string;
  storedKind: string | null;
  baseUrl: string | null | undefined;
  event: NotificationEvent;
}

/**
 * Resolve the channel, build deep-links, format the event for that channel, and
 * POST it best-effort. Returns the transport's success boolean for the caller to
 * log. The single entry point routes/reports.ts calls — replaces the old
 * sendFlakyTransitionWebhook / sendQuarantineWebhook pair.
 */
export async function deliverNotification(opts: DeliverOptions): Promise<boolean> {
  const kind = resolveWebhookKind(opts.url, opts.storedKind);
  const testName = opts.event.kind === 'quarantine' ? opts.event.testName : undefined;
  const links = buildLinks(opts.baseUrl, testName);
  const body = kind === 'slack' ? formatSlack(opts.event, links) : formatGeneric(opts.event, links);
  return postWebhook(opts.url, body);
}
```

- [ ] **Step 4: Run tests + typecheck, expect PASS**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/notifications/deliver.test.ts && rtk proxy pnpm --filter api exec tsc --noEmit`
Expected: 3 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/notifications/deliver.ts apps/api/src/services/notifications/deliver.test.ts
git commit -m "feat(notifications): deliverNotification orchestrator routing events to channels"
```

---

### Task 7: `webhook_kind` column — schema, migration, admin

**Files:**
- Modify: `apps/api/src/db/schema.ts:18` (add column after `webhookUrl`)
- Create: `apps/api/drizzle/0009_*.sql` (generated)
- Modify: `apps/api/src/routes/admin.ts` (PATCH schema ~54, GET select ~82, GET map ~110, PATCH handler ~300, PATCH returning ~322)
- Test: `apps/api/src/routes/admin.test.ts`

**Interfaces:**
- Produces: `projects.webhookKind` (`varchar('webhook_kind', { length: 16 })`, nullable) on the `Project` type; admin PATCH accepts/returns `webhookKind: 'slack' | 'generic' | null`; GET list includes `webhookKind`.
- Needs a disposable Postgres + `DATABASE_URL`/`ADMIN_TOKEN` for the route tests.

- [ ] **Step 1: Add the column to `schema.ts`** (immediately after the `webhookUrl` line, ~18)

```ts
  // Channel formatter for the outbound webhook: NULL = auto-detect from the URL
  // (hooks.slack.com → Slack, else generic), 'slack'/'generic' = explicit
  // override (how a self-hosted Mattermost URL opts into Slack formatting).
  // See services/notifications/channel.ts.
  webhookKind: varchar('webhook_kind', { length: 16 }),
```

- [ ] **Step 2: Generate the migration**

Run: `rtk proxy pnpm --filter api db:generate`
Expected: a new `apps/api/drizzle/0009_*.sql` adding `webhook_kind varchar(16)` (nullable) to `projects`, plus an updated `drizzle/meta/` snapshot. Inspect the SQL — it must be a single `ALTER TABLE "projects" ADD COLUMN "webhook_kind" varchar(16);` with no destructive statements.

- [ ] **Step 3: Write the failing admin test** (append to `admin.test.ts`; mirror the existing `webhookUrl` PATCH tests)

```ts
  it('sets and clears webhookKind, and returns it', async () => {
    const created = await createProject();
    const set = await patchProject(created.id, { webhookKind: 'slack' });
    expect(set.status).toBe(200);
    expect((await set.json()).project.webhookKind).toBe('slack');

    const cleared = await patchProject(created.id, { webhookKind: null });
    expect((await cleared.json()).project.webhookKind).toBeNull();
  });

  it('rejects an invalid webhookKind', async () => {
    const created = await createProject();
    const res = await patchProject(created.id, { webhookKind: 'teams' });
    expect(res.status).toBe(400);
  });

  it('includes webhookKind in the project list projection', async () => {
    const created = await createProject();
    await patchProject(created.id, { webhookKind: 'generic' });
    const list = await listProjects();
    const row = (await list.json()).projects.find((p: { id: string }) => p.id === created.id);
    expect(row.webhookKind).toBe('generic');
  });
```

> Adapt `createProject` / `patchProject` / `listProjects` to the helpers already in `admin.test.ts`. If those helpers are inline `app.request(...)` calls, follow that existing style exactly rather than introducing new helpers.

- [ ] **Step 4: Run the new tests, expect FAIL**

Run (disposable PG first — see Global Constraints): `rtk proxy pnpm --filter api exec vitest run src/routes/admin.test.ts`
Expected: FAIL — `webhookKind` unknown field (400 on the enum test may pass by accident; the set/return + list tests fail).

- [ ] **Step 5: Wire `webhookKind` through `admin.ts`** — five edits:

1. PATCH schema, after the `webhookUrl` block (~line 54):
```ts
    webhookKind: z.enum(['slack', 'generic']).nullable().optional(),
```
2. GET list select `projectsWithStats`, after `webhookUrl: projects.webhookUrl,` (~82):
```ts
      webhookKind: projects.webhookKind,
```
3. GET list `.map` result, after `webhookUrl: p.webhookUrl,` (~110):
```ts
    webhookKind: p.webhookKind,
```
4. PATCH handler, after the `webhookUrl` write block (~300):
```ts
    if ('webhookKind' in data) {
      updates.webhookKind = data.webhookKind ?? null;
    }
```
5. PATCH `.returning({...})`, after `webhookUrl: projects.webhookUrl,` (~322):
```ts
        webhookKind: projects.webhookKind,
```
(The PATCH response spreads `...project`, so #5 surfaces `webhookKind` in the response automatically.)

- [ ] **Step 6: Run admin tests + typecheck, expect PASS**

Run: `rtk proxy pnpm --filter api exec vitest run src/routes/admin.test.ts && rtk proxy pnpm --filter api exec tsc --noEmit`
Expected: new tests pass, existing admin tests still pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts
git commit -m "feat(notifications): add webhook_kind column + admin PATCH/GET wiring"
```

---

### Task 8: Rewire `reports.ts` + swap the module

**Files:**
- Create: `apps/api/src/services/notifications/index.ts` (barrel)
- Delete: `apps/api/src/services/notifications.ts`, `apps/api/src/services/notifications.test.ts`
- Modify: `apps/api/src/routes/reports.ts` (imports ~10-15; quarantine send ~186-202; flaky send ~217-238)
- Test: `apps/api/src/routes/reports.test.ts` (must keep passing — no webhook assertions there today)

**Interfaces:**
- Consumes: `deliverNotification`, `FlakyTransitionEvent`, `QuarantineEvent` from `../services/notifications` (barrel).
- After this task, `import '../services/notifications'` resolves to `notifications/index.ts` (the old file is gone — no file-vs-directory ambiguity).
- Needs a disposable Postgres for the reports route tests.

- [ ] **Step 1: Create the barrel `index.ts`**

```ts
// apps/api/src/services/notifications/index.ts
export { deliverNotification, type DeliverOptions } from './deliver';
export type {
  NotificationEvent,
  FlakyTransitionEvent,
  QuarantineEvent,
  EventProject,
} from './events';
export type { WebhookKind } from './channel';
```

- [ ] **Step 2: Delete the old module + its test**

```bash
git rm apps/api/src/services/notifications.ts apps/api/src/services/notifications.test.ts
```

- [ ] **Step 3: Rewire `reports.ts` imports** (replace the old block at ~10-15)

```ts
import { deliverNotification, type FlakyTransitionEvent, type QuarantineEvent } from '../services/notifications';
```

- [ ] **Step 4: Rewire the quarantine send block** (replace ~186-202, keeping the surrounding `quarantinePromise.then(...).catch(...)` and the failure `logger.error`)

```ts
      .then(async (transitions) => {
        if (!project.webhookUrl || transitions.length === 0) return;
        const baseUrl = process.env.DASHBOARD_BASE_URL ?? null;
        for (const t of transitions) {
          const event: QuarantineEvent = {
            kind: 'quarantine',
            transition: t.event,
            project: { id: project.id, name: project.name },
            testName: t.testName,
            flakeRate: t.flakeRate,
            expiresAt: t.expiresAt,
          };
          const delivered = await deliverNotification({
            url: project.webhookUrl,
            storedKind: project.webhookKind,
            baseUrl,
            event,
          });
          if (!delivered) {
            logger.error('Quarantine webhook delivery failed', {
              projectId: project.id,
              projectName: project.name,
              testName: t.testName,
            });
          }
        }
      })
```

> `QuarantineTransition.event` is `'entered' | 'released'` and `QuarantineEvent.transition` is the same union — assign directly. The old string-mapping (`t.event === 'entered' ? 'quarantine_entered' : ...`) now lives in `formatGeneric`.

- [ ] **Step 5: Rewire the flaky send block** (replace ~217-238, keeping the surrounding `reconcilePromise.then(...).catch(...)`)

```ts
      .then(async ({ newlyFlaky, newlyResolved }) => {
        if (!project.webhookUrl || (newlyFlaky.length === 0 && newlyResolved.length === 0)) {
          return;
        }
        const event: FlakyTransitionEvent = {
          kind: 'flaky_transition',
          project: { id: project.id, name: project.name },
          newlyFlaky,
          newlyResolved,
          run: { branch: testRun.branch, commitSha: testRun.commitSha },
        };
        const delivered = await deliverNotification({
          url: project.webhookUrl,
          storedKind: project.webhookKind,
          baseUrl: process.env.DASHBOARD_BASE_URL ?? null,
          event,
        });
        if (!delivered) {
          logger.error('Flaky transition webhook delivery failed', {
            projectId: project.id,
            projectName: project.name,
          });
        }
      })
```

- [ ] **Step 6: Run the affected suites + typecheck, expect PASS**

Run: `rtk proxy pnpm --filter api exec vitest run src/routes/reports.test.ts src/services/notifications && rtk proxy pnpm --filter api exec tsc --noEmit`
Expected: reports tests pass unchanged; all `notifications/*` unit tests pass; typecheck clean (proves the barrel resolves and no dangling import to the deleted file remains).

- [ ] **Step 7: Full API suite sanity**

Run: `rtk proxy pnpm --filter api test`
Expected: green (route suites need `DATABASE_URL`/`ADMIN_TOKEN`, else self-skip). Confirm nothing still imports `services/notifications.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/notifications/index.ts apps/api/src/routes/reports.ts
git commit -m "refactor(notifications): route reports webhooks through deliverNotification, drop legacy senders"
```

---

### Task 9: Docs — API, STRATEGY, AGENTS, backlog

**Files:**
- Modify: `docs/API.md` (webhook sections ~966-1023 + the auto-quarantine webhook section)
- Modify: `docs/STRATEGY.md` (roadmap #3 row + the "Slack absent" note)
- Modify: `AGENTS.md` (a convention line)
- Modify: `plans/README.md` (add the 052 row)

**Interfaces:** none (docs only). No test; verified by review.

- [ ] **Step 1: `docs/API.md`** — in the webhook documentation:
  - Document the `webhookKind` PATCH field: `"slack" | "generic" | null`; NULL = auto-detect (`hooks.slack.com` → slack, else generic), explicit = override. Add a one-line note that a self-hosted **Mattermost** URL should set `"webhookKind": "slack"`.
  - Add a **Slack payload** example (`{ "text": "…", "blocks": [ … ] }`) alongside the existing generic example, noting `text` is the Mattermost-safe fallback.
  - Update the `dashboardUrl` note: no longer "always null in v1" — it carries a dashboard link when `DASHBOARD_BASE_URL` is set (still `null` otherwise). Document `DASHBOARD_BASE_URL` as a deployment-global env var (http(s); the flaky `/flaky` list and per-test `/tests/:name` links).
  - Leave the delivery-semantics block (best-effort, 5s, no retries, no signing, no deny-list) as-is — unchanged by this work.

- [ ] **Step 2: `docs/STRATEGY.md`** — flip roadmap #3 to reflect Slack + generic delivered with the channel abstraction; note **Teams remains the fast-follow** (drop-in `formatTeams`), and that "Slack absent" is resolved. Do not claim retries/signing — still out of scope.

- [ ] **Step 3: `AGENTS.md`** — add one convention bullet under Conventions:
  > New notification event kinds go through neutral events (`services/notifications/events.ts`) + a per-channel formatter, never a new bespoke sender. The **`generic` formatter is a frozen backward-compat contract** (asserted byte-for-byte); channel is chosen by `resolveWebhookKind` (explicit `webhook_kind` overrides host sniff). Deep-links come from `DASHBOARD_BASE_URL`, read only at the route edge.

- [ ] **Step 4: `plans/README.md`** — add a row for plan **052** (this plan), status DONE once merged, one-line summary. Match the existing row format.

- [ ] **Step 5: Verify docs build/lint** (if the repo lints markdown/docs) and re-read each change for accuracy against the shipped code.

Run: `rtk proxy pnpm lint`
Expected: clean (oxlint does not lint markdown, but this catches any stray code edit).

- [ ] **Step 6: Commit**

```bash
git add docs/API.md docs/STRATEGY.md AGENTS.md plans/README.md
git commit -m "docs(notifications): document webhook channels, Slack payload, DASHBOARD_BASE_URL"
```

---

## Final verification (before finishing the branch)

- [ ] `rtk proxy pnpm --filter api exec tsc --noEmit` — typecheck clean.
- [ ] `rtk proxy pnpm --filter api test` (disposable Postgres + `DATABASE_URL`/`ADMIN_TOKEN`) — all API suites green; grep confirms no remaining import of `services/notifications.ts`.
- [ ] `rtk proxy pnpm lint` — clean.
- [ ] Manual trace: a project with a `hooks.slack.com` URL and no `webhook_kind` gets Slack-formatted; a generic URL gets the byte-identical legacy payload; with `DASHBOARD_BASE_URL` unset, the generic flaky payload's `dashboardUrl` is still `null`.
