# Notification Channels + Slack Formatter — Design

**Status:** Design approved (hybrid `webhook_kind` + Slack/generic scope, deep-links
in, Teams fast-follow). Awaiting spec review before planning.

**Roadmap:** STRATEGY.md #3 — "Interface `NotificationChannel` + formateur Slack
(+ Teams)". Effort ~1–1.5j.

**Goal:** Turn the two near-duplicate proprietary-JSON webhook senders into a
channel abstraction — neutral domain events → per-channel formatters → one shared
transport — shipping **Slack** and **generic** channels with dashboard deep-links,
while keeping the existing generic payload byte-identical for current consumers.

---

## Why

Today `services/notifications.ts` has two senders (`sendFlakyTransitionWebhook`,
`sendQuarantineWebhook`) that differ only in payload shape; both POST a
**proprietary** JSON body that renders as an unreadable blob in Slack/Mattermost.
The strategic buyer segment (sovereignty / public-sector / self-hosted) lives in
**Slack-compatible** chat — most often **Mattermost**, which accepts Slack's
payload on a self-hosted URL. A pure URL-sniff ("is the host `hooks.slack.com`?")
would misclassify every Mattermost URL as generic. Hence a **hybrid** channel
selector: auto-detect by default, explicit override when the operator knows better.

Two facts constrain the refactor:

1. **Existing generic consumers must not break.** The generic formatter emits
   today's exact payload (`event: 'flaky_tests_changed'` / `quarantine_entered` /
   `quarantine_released`, same keys, same casing).
2. **`dashboardUrl` was always in the payload as `null` ("reserved").** Populating
   it from a deployment-global `DASHBOARD_BASE_URL` is a *compatible* enhancement:
   the field was always present; its value goes from `null` to a string only when
   the operator sets the base URL. Unset → still `null` → byte-identical to today.

---

## Architecture

Three layers, replacing the two monolithic senders:

```
domain event (neutral)  ──►  formatter (per channel)  ──►  transport (shared POST)
  FlakyTransitionEvent        formatGeneric / formatSlack     postWebhook(url, body)
  QuarantineEvent             (+ deep-links from base URL)     best-effort, 5s, no throw
```

Channel selection sits in front of the formatter:

```
resolveWebhookKind(url, storedKind) ──► 'slack' | 'generic'
  storedKind non-null  → use it (explicit override; how Mattermost picks 'slack')
  storedKind null      → auto-detect: host endsWith 'hooks.slack.com' → 'slack', else 'generic'
```

One public entry point, `deliverNotification`, ties it together and is the only
thing `routes/reports.ts` calls. The fire-and-forget wiring, the one-POST-per-
quarantine-transition / one-POST-per-ingest-for-flaky cadence, and the
`?wait=true` semantics in `reports.ts` are **unchanged** — this refactor swaps
what gets POSTed and how it's chosen, not when it fires.

---

## Components (units + interfaces)

### 1. Neutral events — `services/notifications/events.ts`

Format-agnostic descriptions of *what happened*. No wire concepts (no `event`
string literals, no `dashboardUrl`).

```ts
export interface EventProject { id: string; name: string; }

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

### 2. Channel resolution — `services/notifications/channel.ts`

```ts
export type WebhookKind = 'slack' | 'generic'; // 'teams' added in the fast-follow

/** Explicit stored kind wins; else sniff the host. Never throws on a bad URL. */
export function resolveWebhookKind(url: string, storedKind: WebhookKind | null): WebhookKind;
```

Auto-detect rule: parse `url`; if `new URL(url).host` equals or ends with
`hooks.slack.com` → `'slack'`, otherwise `'generic'`. A URL that fails to parse
falls back to `'generic'` (it will simply fail to deliver, best-effort).

### 3. Deep-links — `services/notifications/links.ts`

```ts
export interface DeepLinks { dashboard: string | null; test: string | null; }

/** baseUrl is DASHBOARD_BASE_URL (env-global). null/'' → all links null (back-compat). */
export function buildLinks(baseUrl: string | null | undefined, testName?: string): DeepLinks;
```

- `dashboard`: `baseUrl` present → `${trimTrailingSlash(baseUrl)}/flaky`, else `null`.
- `test`: `baseUrl` present *and* `testName` given →
  `${trimTrailingSlash(baseUrl)}/tests/${encodeURIComponent(testName)}`, else `null`.
- Exact route paths (`/flaky`, `/tests/[testName]`) are confirmed against
  `apps/dashboard/src/routes/` during planning; they are the current dashboard
  routes. Base URL is validated as http(s) at config time (env), not per-send.

### 4. Formatters — `services/notifications/formatters/{generic,slack}.ts`

Each takes a neutral event + resolved links and returns the POST body.

```ts
export function formatGeneric(event: NotificationEvent, links: DeepLinks): unknown;
export function formatSlack(event: NotificationEvent, links: DeepLinks): unknown;
```

**`formatGeneric` — byte-identical to today, with the one reserved field now live:**

`flaky_transition` →
```json
{
  "event": "flaky_tests_changed",
  "project": { "id": "…", "name": "…" },
  "newlyFlaky": ["…"],
  "newlyResolved": ["…"],
  "run": { "branch": "…", "commitSha": "…" },
  "dashboardUrl": null
}
```
`dashboardUrl` = `links.dashboard` (was hardcoded `null`; now `null` unless
`DASHBOARD_BASE_URL` is set). `quarantine` → today's `quarantine_entered` /
`quarantine_released` shape (`testName`, `flakeRate`, `expiresAt`) — unchanged,
`dashboardUrl` field **not** added to the quarantine generic payload (today's
quarantine payload has no such field; keep it identical).

**`formatSlack` — Slack Block Kit with a `text` fallback (Mattermost-safe):**

```json
{
  "text": "⚠️ *my-project*: 1 test newly flaky on `main` — login test flakes on retry",
  "blocks": [ { "type": "section", "text": { "type": "mrkdwn", "text": "…" } } ]
}
```

- Top-level `text` is a plain mrkdwn summary — **required** as Slack's
  notification fallback and the part Mattermost renders reliably (its `blocks`
  support is partial). `blocks` is the richer enhancement that degrades to `text`.
- When `links.test`/`links.dashboard` are non-null, render them as mrkdwn links
  (`<url|label>`); when null, omit the link, keep the label as plain text.
- Quarantine events get their own summary line
  (`🔒 quarantined` / `🔓 released`, flake rate, TTL for `entered`).

### 5. Transport — `services/notifications/transport.ts`

The single best-effort POST, extracted verbatim from the two current senders (the
only real duplication being removed):

```ts
/** POST JSON. Never throws: network error / timeout / non-2xx all → false. */
export async function postWebhook(url: string, body: unknown): Promise<boolean>;
```

`fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })`, `return res.ok`,
`catch → false`. Same 5s timeout, same no-retry, no-signing contract as v1.

### 6. Orchestration — `services/notifications/index.ts`

```ts
export async function deliverNotification(opts: {
  url: string;
  storedKind: WebhookKind | null;
  baseUrl: string | null | undefined;
  event: NotificationEvent;
}): Promise<boolean>;
```

Resolves kind → builds links (using the event's `testName` when it's a quarantine
event) → picks the formatter → `postWebhook`. Returns delivery success for the
caller to log. Re-exports the event types so `reports.ts` imports from one place.

### 7. `routes/reports.ts` rewire

Replace the two call sites (`sendQuarantineWebhook` at ~190, `sendFlakyTransitionWebhook`
at ~232) with `deliverNotification(...)` calls that build the **neutral** event and
pass `project.webhookKind` + `env.DASHBOARD_BASE_URL`. The surrounding fire-and-forget
`.then().catch()` blocks, the per-transition loop, and the `logger.error` on failed
delivery stay as-is. No change to the `reconcilePromise` / `quarantinePromise` /
`?wait=true` machinery.

### 8. Schema + admin — `db/schema.ts`, `routes/admin.ts`, migration

- `db/schema.ts`: add `webhookKind: varchar('webhook_kind', { length: 16 })`
  (nullable; NULL = auto-detect) to `projects`. Column on `projects`, not a child
  table → no `onDelete: 'cascade'` needed.
- Migration: new Drizzle migration adding the column (nullable, no default beyond
  NULL) — safe for existing rows (all become auto-detect).
- `routes/admin.ts`: add `webhookKind: z.enum(['slack', 'generic']).nullable().optional()`
  to the PATCH schema; handler writes it (`'webhookKind' in data` → `data.webhookKind ?? null`);
  GET list + single include it in the projection.
- No new endpoint → no `readAuth`/route-count-guard change. `webhookUrl` validation
  unchanged.

### 9. Config — `DASHBOARD_BASE_URL`

New optional env var read where the API config/env is assembled. Validated http(s)
if present; absent/empty → deep-links stay `null`. Documented in `.env.example`
(if present) and `docs/API.md`.

---

## Data flow (end to end)

1. `POST /api/v1/reports` ingests, commits, returns 201 (unchanged).
2. Background: `updateFlakyTests` → `reconcileQuarantine` (unchanged).
3. On transitions, `reports.ts` builds a neutral `FlakyTransitionEvent` /
   `QuarantineEvent` and calls `deliverNotification({ url: project.webhookUrl,
   storedKind: project.webhookKind, baseUrl: env.DASHBOARD_BASE_URL, event })`.
4. `deliverNotification` resolves kind, builds links, formats, POSTs best-effort.
5. Failure → `logger.error`, swallowed; never blocks the ingest or `?wait=true`.

---

## Error handling

- Unchanged best-effort contract: any delivery failure (timeout, non-2xx, network,
  unparseable URL) resolves to `false`, is logged via the structured logger, and
  dropped. No retries, no signing in this scope.
- `resolveWebhookKind` and `buildLinks` never throw on malformed input — they
  degrade (`'generic'` / `null`), so a bad stored value can't crash the ingest's
  background step.

---

## Testing

Pure-logic units (the whole point of the split) get node-env unit tests, mirroring
the existing `notifications.test.ts` coverage (5+5):

- `channel.test.ts`: auto-detect Slack host, auto-detect Mattermost→generic,
  explicit override wins over host, unparseable URL → generic.
- `links.test.ts`: null/empty base → all null; base set → dashboard + test links;
  trailing-slash normalization; `encodeURIComponent` on test name with spaces/slashes.
- `formatters/generic.test.ts`: **asserts byte-for-byte the current payload** for
  both event kinds (regression lock for existing consumers); `dashboardUrl` null
  when no base, populated when base set.
- `formatters/slack.test.ts`: top-level `text` present (fallback invariant), mrkdwn
  link rendered when link non-null, plain label when null, quarantine summary lines.
- `transport.test.ts`: mock `fetch` → `res.ok` true/false, thrown error → false,
  timeout (AbortSignal) → false.
- `index.test.ts` / rewire: `deliverNotification` picks the right formatter per
  resolved kind; `reports.ts` still fires one POST per quarantine transition and
  one per flaky ingest (existing route tests updated, not replaced).

Formatters + resolver are prime **Stryker** candidates (pure, branchy); the plan
notes them for the API broad mutation run, but adding them to the per-file gate
floor is a **separate deliberate step**, not part of this scope.

---

## Scope (YAGNI)

**In:** channel abstraction (events/formatters/transport/resolver), `generic` +
`slack` formatters, hybrid `webhook_kind` column + admin PATCH, `DASHBOARD_BASE_URL`
deep-links, docs.

**Out (explicitly):**
- **Teams formatter** — fast-follow. The abstraction is proven with two channels;
  Teams becomes `formatTeams` + `'teams'` in the enum/resolver, no core change.
- **Retries / HMAC signing / SSRF deny-list** — separate roadmap concerns; the
  best-effort one-shot, admin-trust model is unchanged.
- **Multiple webhooks or per-event routing per project** — still one `webhookUrl`
  per project; both event kinds go to the same channel.
- **Adding `dashboardUrl` to the quarantine generic payload** — today's quarantine
  payload has no such field; keep it identical. (Slack quarantine messages *do*
  get deep-links, because that's a new format, not the legacy contract.)

---

## Migration / backward compatibility

- Existing projects: `webhook_kind` NULL → auto-detect. Non-Slack URL → `generic`
  → identical payload to today when `DASHBOARD_BASE_URL` is unset.
- Turning on `DASHBOARD_BASE_URL` changes `dashboardUrl` from `null` to a string in
  the generic flaky payload — flagged in docs as the reserved field going live.
- No data backfill; the column defaults to NULL for all rows.

---

## Docs to update

- `docs/API.md`: `webhookKind` field on the PATCH route; Slack payload example;
  auto-detection + override table; `DASHBOARD_BASE_URL` and the `dashboardUrl`
  field going live; Mattermost note.
- `docs/STRATEGY.md`: flip #3 status once shipped; note Teams remains the
  fast-follow and Slack is now delivered (removing the "Slack absent" gap).
- `AGENTS.md`: a sharp-edge/convention line — new notification event kinds go
  through neutral events + per-channel formatters (never a new bespoke sender);
  generic formatter is a frozen backward-compat contract.
