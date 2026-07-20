# Plan 041 — Durcissement des routes de lecture (`READ_TOKEN`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à un opérateur de fermer les 11 routes de lecture de l'API avec un secret unique, sans casser aucune installation existante ni aucun workflow client déjà déployé.

**Architecture:** Un middleware `readAuth(resolveProjectId?)` monté route par route. Trois issues dans un ordre load-bearing : `READ_TOKEN` absent de l'environnement ⇒ passage direct (mode ouvert, défaut) ; Bearer égal à `READ_TOKEN` ⇒ passage, comparaison en mémoire sans SQL ; Bearer égal au token du projet visé ⇒ passage, un lookup indexé. Sinon 401. Une garde de couverture lit `app.routes` et échoue si une route `GET` sous `/api/v1` n'a pas `readAuth` monté.

**Tech Stack:** Hono 4.12, Drizzle + postgres-js, Vitest, SvelteKit 2 (dashboard), bash + jq (GitHub Action).

**Spec :** `docs/superpowers/specs/2026-07-20-read-hardening-design.md` (décisions D1→D7).

## Global Constraints

- Logger structuré (`apps/api/src/middleware/logger.ts`), **jamais** `console.log` côté API.
- Commits : sujet conventional-commit sur une seule ligne, **aucun** trailer `Co-Authored-By`.
- `main` est protégée — travailler sur une branche, PR avec CI verte.
- Aucune suite de tests existante ne doit être modifiée. Tout churn observé est le signe d'une régression, pas un ajustement à faire.
- Le token de lecture ne doit **jamais** porter le préfixe `PUBLIC_` côté dashboard (exposerait au bundle navigateur).
- Les tests d'API se skippent d'eux-mêmes sans `DATABASE_URL` ; les nouveaux tests qui n'ont pas besoin de base ne doivent **pas** se skipper.

---

## File Structure

| Fichier | Responsabilité | Action |
|---|---|---|
| `apps/api/src/middleware/auth.ts` | `readAuth()` + marqueur | Modifier |
| `apps/api/src/middleware/auth.test.ts` | Tests unitaires du middleware | Modifier |
| `apps/api/src/index.ts` | Avertissement au boot | Modifier |
| `apps/api/src/routes/projects.ts` | Montage sur 8 routes | Modifier |
| `apps/api/src/routes/tests.ts` | Montage sur 3 routes | Modifier |
| `apps/api/src/routes-auth-coverage.test.ts` | Garde de couverture | Créer |
| `apps/api/src/routes/read-auth.test.ts` | Tests d'intégration du gating | Créer |
| `apps/dashboard/src/lib/server/api.ts` | Client API, server-only | Déplacer depuis `lib/api.ts` |
| `.github/action-scripts/comment.sh` | Header sur le fetch quarantine | Modifier |
| `.env.example`, `docs/API.md`, `AGENTS.md`, `plans/README.md` | Documentation | Modifier |

---

## Task 1: Le middleware `readAuth`

**Files:**
- Modify: `apps/api/src/middleware/auth.ts` (ajout en fin de fichier, après `adminAuth` ligne 122)
- Test: `apps/api/src/middleware/auth.test.ts`

**Interfaces:**
- Consumes: `extractBearerToken` (`auth.ts:25`), `tokensMatch` (`auth.ts:44`), `hashToken` (`auth.ts:10`), `db`/`projects` (`../db`)
- Produces: `readAuth(resolveProjectId?: (c: Context) => string | null): ReadAuthMiddleware` — le type retourné porte `isReadAuth: true`, lu par la garde de la Task 3.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de `apps/api/src/middleware/auth.test.ts` :

```typescript
describe('readAuth', () => {
  afterEach(() => {
    delete process.env.READ_TOKEN;
    vi.restoreAllMocks();
  });

  function appWith(mw: ReturnType<typeof readAuth>) {
    const app = new Hono();
    app.get('/p/:id', mw, (c) => c.json({ ok: true }));
    return app;
  }

  it('passe sans credential quand READ_TOKEN est absent (mode ouvert)', async () => {
    const app = appWith(readAuth((c) => c.req.param('id')));
    const res = await app.request('/p/abc');
    expect(res.status).toBe(200);
  });

  it('passe avec un READ_TOKEN valide', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const app = appWith(readAuth((c) => c.req.param('id')));
    const res = await app.request('/p/abc', {
      headers: { Authorization: 'Bearer read-secret' },
    });
    expect(res.status).toBe(200);
  });

  it('rejette en 401 sans header quand READ_TOKEN est défini', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const app = appWith(readAuth((c) => c.req.param('id')));
    const res = await app.request('/p/abc');
    expect(res.status).toBe(401);
  });

  it('rejette en 401 sur un format non-Bearer', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const app = appWith(readAuth((c) => c.req.param('id')));
    const res = await app.request('/p/abc', {
      headers: { Authorization: 'read-secret' },
    });
    expect(res.status).toBe(401);
  });

  it('rejette en 401 un mauvais token sans résolveur de projet', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const app = appWith(readAuth());
    const res = await app.request('/p/abc', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('marque le middleware retourné pour la garde de couverture', () => {
    expect(readAuth().isReadAuth).toBe(true);
    expect(readAuth((c) => c.req.param('id')).isReadAuth).toBe(true);
  });
});
```

Modifier la ligne 3 de `auth.test.ts` pour ajouter `readAuth` :

```typescript
import { hashToken, generateToken, adminAuth, projectAuth, readAuth } from '../middleware/auth';
```

Les lignes 1-2 (`vitest`, `Hono`) sont déjà correctes et n'ont pas besoin d'être touchées — `afterEach` et `vi` y sont déjà importés.

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `pnpm --filter api exec vitest run src/middleware/auth.test.ts`
Expected: FAIL — `readAuth is not a function` / erreur de type à l'import.

- [ ] **Step 3: Implémenter le middleware**

Ajouter à la fin de `apps/api/src/middleware/auth.ts`. **Aucun nouvel import n'est nécessaire** : `Context` et `MiddlewareHandler` (ligne 2), `HTTPException` (ligne 3), `eq` (ligne 4), `db` et `projects` (ligne 5) sont déjà importés par le fichier.

```typescript
/**
 * A readAuth middleware, tagged so the route-coverage guard can recognise it.
 *
 * The tag is part of the contract, not a convenience: every readAuth() call
 * returns a fresh closure, so routes-auth-coverage.test.ts cannot identify
 * mounted read-auth by reference identity. Removing `isReadAuth` makes that
 * guard silently pass over an empty set — exactly the failure mode it exists
 * to eliminate.
 */
export interface ReadAuthMiddleware extends MiddlewareHandler {
  isReadAuth: true;
}

/**
 * Read authorization middleware (plan 041, design decisions D1–D6).
 *
 * An unset READ_TOKEN means "reads are open" — identical to the behaviour
 * before this plan. That is deliberate (D1): closing by default would break
 * every existing install on upgrade, and in a self-hosted product the
 * operator, not us, knows whether their network is trusted. The boot warning
 * in index.ts is what makes the choice conscious rather than accidental; this
 * middleware stays silent.
 *
 * Evaluation order is load-bearing for performance (D3), not just for
 * readability. The dashboard presents READ_TOKEN on every SSR request and
 * emits 2–5 API calls per page view, including GET /api/v1/projects on every
 * single page via +layout.server.ts. That path must not touch the database,
 * so the READ_TOKEN comparison — constant-time, in memory — comes first. Only
 * the project-token fallback pays a lookup, and that path is the CI Action:
 * roughly once per pipeline run, against an existing index
 * (projects_token_hash_idx, schema.ts:27).
 *
 * @param resolveProjectId Reads the project this request targets out of the
 *   request. Omit it on routes that are not scoped to a single project — they
 *   then accept READ_TOKEN only. Two routes deliberately omit it:
 *   GET /api/v1/projects (D6) and GET /api/v1/tests/flaky/:id (D5).
 */
export function readAuth(
  resolveProjectId?: (c: Context) => string | null
): ReadAuthMiddleware {
  const mw: MiddlewareHandler = async (c, next) => {
    const readToken = process.env.READ_TOKEN;
    if (!readToken) return next();

    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) {
      throw new HTTPException(401, { message: 'Authorization header required' });
    }

    if (tokensMatch(token, readToken)) return next();

    if (resolveProjectId) {
      const wanted = resolveProjectId(c);
      if (wanted) {
        const project = await db.query.projects.findFirst({
          where: eq(projects.tokenHash, hashToken(token)),
        });
        // Both predicates matter: a valid project token that targets a
        // DIFFERENT project must be rejected. This is what closes the
        // cross-project read at the middleware, rather than relying on each
        // handler to remember.
        if (project && project.id === wanted) {
          c.set('project', project);
          return next();
        }
      }
    }

    // Deliberately generic: do not reveal whether the token was unknown or
    // simply pointed at another project.
    throw new HTTPException(401, { message: 'Invalid read credentials' });
  };

  return Object.assign(mw, { isReadAuth: true as const });
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `pnpm --filter api exec vitest run src/middleware/auth.test.ts`
Expected: PASS, y compris les 8 suites existantes du fichier, inchangées.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/middleware/auth.test.ts
git commit -m "feat(api): add readAuth middleware with open-by-default mode"
```

---

## Task 2: Avertissement au démarrage

**Files:**
- Modify: `apps/api/src/index.ts` (après les imports, avant le montage des routes ligne 89)

**Interfaces:**
- Consumes: `logger` (déjà importé dans `index.ts`)
- Produces: rien de programmatique — un effet de bord au chargement du module.

- [ ] **Step 1: Ajouter l'avertissement**

Insérer juste avant le commentaire `// Mount routes` (ligne 88) dans `apps/api/src/index.ts` :

```typescript
// Fires once, at module evaluation (server start), not per-request — loud
// enough that an operator cannot miss it in the boot log, without spamming
// every request. Mirrors the DASHBOARD_PASSWORD warning in the dashboard's
// hooks.server.ts, and follows the same reasoning (plan 041, D1): leaving
// reads open is a legitimate choice for a network-isolated deployment, so we
// warn rather than hard-fail.
if (!process.env.READ_TOKEN) {
  logger.warn(
    'READ_TOKEN is not set — all read endpoints are unauthenticated, and ' +
      'GET /api/v1/projects enumerates every project on this instance. Anyone ' +
      'who can reach this API can read every project\'s stats, runs, flaky ' +
      'tests and quarantine list. Set READ_TOKEN to require a Bearer token on ' +
      'read endpoints, or confirm this deployment is genuinely network-isolated. ' +
      'See docs/API.md.'
  );
}
```

- [ ] **Step 2: Vérifier que l'avertissement se déclenche**

Run: `pnpm --filter api exec vitest run src/routes/api.test.ts 2>&1 | grep -i "READ_TOKEN is not set" | head -2`
Expected: la ligne d'avertissement apparaît (les tests importent `../index`, ce qui évalue le module).

- [ ] **Step 3: Vérifier qu'il ne se déclenche PAS quand la variable est définie**

Run: `READ_TOKEN=x pnpm --filter api exec vitest run src/routes/api.test.ts 2>&1 | grep -ci "READ_TOKEN is not set"`
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): warn at boot when READ_TOKEN is unset"
```

---

## Task 3: La garde de couverture (RED)

Cette task écrit une garde qui **doit échouer** en la fermant : les 11 routes ne sont pas encore couvertes. La Task 4 la fait passer. C'est le cycle TDD, réparti sur deux tasks parce qu'un relecteur peut légitimement accepter la garde et rejeter le montage, ou l'inverse.

**Files:**
- Create: `apps/api/src/routes-auth-coverage.test.ts`

**Interfaces:**
- Consumes: `app` (export default de `apps/api/src/index.ts:130`), `ReadAuthMiddleware.isReadAuth` (Task 1)
- Produces: rien — c'est un test.

**Contexte vérifié, à ne pas re-dériver :**
- `app.routes` est une propriété publique typée de Hono 4.12 : `{ basePath, path, method, handler }[]`.
- `app.route(prefix, subApp)` réinjecte chaque route du sous-routeur avec le préfixe déjà fusionné — `app.routes` est donc **plat**, avec les chemins complets.
- `app.get(path, mw, handler)` appelle `#addRoute` **une fois par handler** (`hono-base.js:47-49`) : le middleware monté par route produit sa propre entrée, **même méthode, même chemin** que le handler. La jointure est donc exacte, pas par préfixe.
- L'identité des fonctions handler survit au montage (aucun sous-routeur ne définit d'`errorHandler`, donc pas de wrapping).
- Importer `../index` ne requiert **pas** `DATABASE_URL` : `db` est un Proxy paresseux (`db/index.ts:23-31`). Et `index.ts:94` gate `serve()` sur `VITEST`, donc aucun port n'est ouvert.

- [ ] **Step 1: Écrire la garde**

Créer `apps/api/src/routes-auth-coverage.test.ts` :

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import app from './index';

/**
 * Fail-loud guard: every read endpoint has readAuth mounted.
 *
 * This is a STATIC SCAN of Hono's route table, not a test of request
 * behaviour. It asserts that the middleware is *mounted*, not that it
 * *works* — that is read-auth.test.ts's job.
 *
 * Why it exists: plan 041 mounts readAuth route-by-route rather than
 * router-wide (design decision D4), because testsRouter is mixed — three
 * public reads plus an admin-gated PATCH — and a router-wide mount would
 * break the dashboard's mute action. Route-by-route mounting is the one
 * thing in this API that a developer must remember, and this repo has been
 * bitten twice by remember-to-register mistakes (ECharts series types,
 * Dependabot directory coverage), both silent, both caught only by a
 * reviewer mutating the source by hand. Both were fixed the same way: stop
 * relying on the convention, and make the gap fail CI. This is that guard.
 *
 * The risk is measured, not hypothetical: 5 of the 11 read routes postdate
 * the initial commit, and the two most recent landed on the same day
 * (2026-07-15) from two different plans.
 */

// Read routes deliberately mounted WITHOUT a project resolver — they accept
// READ_TOKEN only. They still need readAuth mounted; they just pass no
// resolver. Listed here only to document intent; the assertion treats them
// like any other route.
const READ_TOKEN_ONLY = ['/api/v1/projects', '/api/v1/tests/flaky/:id'];

// The number of GET routes under /api/v1, excluding /admin/* (already gated
// by adminAuth) and the static /api/v1 index. Bumping this is the point: a
// new read route forces a deliberate edit here, which forces a reviewer to
// ask whether readAuth was mounted.
const EXPECTED_READ_ROUTE_COUNT = 11;

function isReadAuthHandler(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as { isReadAuth?: boolean }).isReadAuth === true;
}

const readRoutes = app.routes.filter(
  (r) =>
    r.method === 'GET' &&
    r.path.startsWith('/api/v1/') &&
    !r.path.startsWith('/api/v1/admin') &&
    !isReadAuthHandler(r.handler)
);

const readAuthPaths = new Set(
  app.routes.filter((r) => r.method === 'GET' && isReadAuthHandler(r.handler)).map((r) => r.path)
);

describe('read-route auth coverage', () => {
  // Anti-vacuity. Both existing guards in this repo ship one and comment on
  // why: without it, a refactor that changes how routes are mounted leaves
  // this file green while asserting nothing at all.
  beforeAll(() => {
    if (app.routes.length === 0) {
      throw new Error(
        'app.routes is empty — the route table could not be read. This guard ' +
          'would pass vacuously. Hono’s internals or the app export changed; ' +
          'fix this test, do not delete it.'
      );
    }
    if (readRoutes.length !== EXPECTED_READ_ROUTE_COUNT) {
      throw new Error(
        `Expected ${EXPECTED_READ_ROUTE_COUNT} GET routes under /api/v1 (excluding ` +
          `/admin), found ${readRoutes.length}: ${readRoutes.map((r) => r.path).join(', ')}. ` +
          'If you added or removed a read route, update EXPECTED_READ_ROUTE_COUNT ' +
          'in this file — deliberately, after checking readAuth is mounted on it.'
      );
    }
  });

  it.each(readRoutes.map((r) => r.path))('has readAuth mounted: GET %s', (path) => {
    expect(
      readAuthPaths.has(path),
      `GET ${path} has no readAuth mounted. Every read endpoint must be mounted as\n` +
        `  router.get('<path>', readAuth(<resolver>), handler)\n` +
        `where <resolver> reads the target project out of the request — c.req.param('id')\n` +
        `for /projects/:id/* routes, c.req.query('project') for /tests/:testName/* routes.\n` +
        `Routes that are not scoped to one project (${READ_TOKEN_ONLY.join(', ')}) pass no\n` +
        `resolver, but still mount readAuth().\n\n` +
        `Without it, this endpoint stays readable by anyone who can reach the API even\n` +
        `when the operator has set READ_TOKEN — silently, with no error anywhere.`
    ).toBe(true);
  });

  it('detects a known-covered route (guard is not vacuous)', () => {
    expect(readAuthPaths.has('/api/v1/projects/:id/stats')).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer la garde pour vérifier qu'elle échoue**

Run: `pnpm --filter api exec vitest run src/routes-auth-coverage.test.ts`
Expected: FAIL — 11 échecs `has readAuth mounted: GET …`, plus l'échec du test anti-vacuité `detects a known-covered route`. Le `beforeAll` doit passer (11 routes trouvées).

Si le `beforeAll` échoue avec un compte différent de 11, **s'arrêter** : soit une route a été ajoutée depuis la rédaction du plan, soit le filtre est faux. Vérifier avec :
`pnpm --filter api exec vitest run src/routes-auth-coverage.test.ts 2>&1 | grep "found"`

- [ ] **Step 3: Commit (garde rouge, volontairement)**

```bash
git add apps/api/src/routes-auth-coverage.test.ts
git commit -m "test(api): add failing route-auth coverage guard"
```

---

## Task 4: Monter `readAuth` sur les 11 routes (GREEN)

**Files:**
- Modify: `apps/api/src/routes/projects.ts` (8 routes : lignes 62, 80, 100, 153, 209, 269, 366, 419)
- Modify: `apps/api/src/routes/tests.ts` (3 routes : lignes 136, 222, 287)
- Create: `apps/api/src/routes/read-auth.test.ts`

**Interfaces:**
- Consumes: `readAuth` (Task 1)
- Produces: les 11 routes montées, ce qui fait passer la garde de la Task 3.

- [ ] **Step 1: Monter sur `projects.ts`**

Ajouter à l'import en tête de `apps/api/src/routes/projects.ts` :

```typescript
import { readAuth } from '../middleware/auth';
```

Puis modifier les 8 déclarations. `/` ne prend **pas** de résolveur (D6) ; les 7 autres lisent `:id` :

```typescript
projectsRouter.get('/', readAuth(), async (c) => {
projectsRouter.get('/:id/stats', readAuth((c) => c.req.param('id')), async (c) => {
projectsRouter.get('/:id/flaky-tests', readAuth((c) => c.req.param('id')), async (c) => {
projectsRouter.get('/:id/quarantine', readAuth((c) => c.req.param('id')), async (c) => {
projectsRouter.get('/:id/runs', readAuth((c) => c.req.param('id')), async (c) => {
projectsRouter.get('/:id/runs/:runId', readAuth((c) => c.req.param('id')), async (c) => {
projectsRouter.get('/:id/analysis', readAuth((c) => c.req.param('id')), async (c) => {
projectsRouter.get('/:id/trend', readAuth((c) => c.req.param('id')), async (c) => {
```

- [ ] **Step 2: Monter sur `tests.ts`**

Ajouter `readAuth` à l'import existant de `../middleware/auth` (le fichier importe déjà `adminAuth`).

Les deux premières routes sont scopées par la query `?project=` ; `/flaky/:id` n'en prend pas (D5) :

```typescript
testsRouter.get('/:testName/history', readAuth((c) => c.req.query('project') ?? null), async (c) => {
testsRouter.get('/:testName/trend', readAuth((c) => c.req.query('project') ?? null), async (c) => {
testsRouter.get('/flaky/:id', readAuth(), async (c) => {
```

Ne **pas** toucher `testsRouter.patch('/flaky/:id', adminAuth(), …)` ligne 316.

- [ ] **Step 3: Lancer la garde pour vérifier qu'elle passe**

Run: `pnpm --filter api exec vitest run src/routes-auth-coverage.test.ts`
Expected: PASS — 11 tests `has readAuth mounted` verts, plus le test anti-vacuité.

- [ ] **Step 4: Vérifier que la garde mord (mutation)**

Retirer temporairement `readAuth((c) => c.req.param('id')), ` de la ligne `/:id/quarantine`, relancer :

Run: `pnpm --filter api exec vitest run src/routes-auth-coverage.test.ts`
Expected: FAIL, avec le message nommant `GET /api/v1/projects/:id/quarantine`.

**Puis restaurer la ligne** et relancer pour revérifier le vert. Cette étape n'est pas optionnelle : une garde jamais vue échouer n'est pas une garde.

- [ ] **Step 5: Écrire les tests d'intégration du gating**

Créer `apps/api/src/routes/read-auth.test.ts` :

```typescript
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import app from '../index';

/**
 * Behavioural counterpart to routes-auth-coverage.test.ts: that file asserts
 * readAuth is MOUNTED, this one asserts it WORKS. Neither subsumes the other
 * — a mounted middleware with inverted logic passes the coverage guard.
 *
 * The blocks below need no database: every assertion is about the 401 path,
 * which READ_TOKEN short-circuits before any query. The project-token
 * fallback — including the cross-project rejection, which is the security
 * property this whole plan exists to establish — is DB-backed and lives in
 * the describeWithDb block at the bottom of this file.
 */

const PROBE = '/api/v1/projects/00000000-0000-0000-0000-000000000000/stats';

describe('read endpoint gating', () => {
  afterEach(() => {
    delete process.env.READ_TOKEN;
  });

  it('mode ouvert : pas de 401 quand READ_TOKEN est absent', async () => {
    delete process.env.READ_TOKEN;
    const res = await app.request(PROBE);
    expect(res.status).not.toBe(401);
  });

  it('401 sans credential quand READ_TOKEN est défini', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(PROBE);
    expect(res.status).toBe(401);
  });

  it('401 avec un mauvais token', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(PROBE, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('pas de 401 avec le bon READ_TOKEN', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(PROBE, {
      headers: { Authorization: 'Bearer read-secret' },
    });
    expect(res.status).not.toBe(401);
  });

  it('l’énumération des projets est fermée quand READ_TOKEN est défini', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request('/api/v1/projects');
    expect(res.status).toBe(401);
  });

  it('le PATCH admin reste gouverné par ADMIN_TOKEN, pas par READ_TOKEN', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request('/api/v1/tests/flaky/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer read-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ignored' }),
    });
    // READ_TOKEN must NOT grant an admin write. Anything but 2xx is correct
    // here; 401 is the expected value.
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 5b: Le test du rejet inter-projets (adossé à la base)**

C'est **la** propriété de sécurité du plan : un token projet valide, présenté pour un *autre* projet, doit être refusé. Sans ce test, le critère de réussite n°2 n'est adossé à rien.

Ajouter à la fin de `apps/api/src/routes/read-auth.test.ts` :

```typescript
// The admin API returns a project's token exactly once, at creation
// (admin.ts:155) — that is why both projects are created here rather than
// reusing a fixture.
const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeWithDb = hasDatabase && hasAdminToken ? describe : describe.skip;

describeWithDb('read endpoint gating — project-token fallback', () => {
  let adminToken: string;
  let projectA: { id: string; token: string };
  let projectB: { id: string; token: string };

  async function createProject(name: string) {
    const res = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    return { id: body.project.id, token: body.project.token };
  }

  beforeAll(async () => {
    adminToken = process.env.ADMIN_TOKEN!;
    projectA = await createProject(`read-auth-a-${Date.now()}`);
    projectB = await createProject(`read-auth-b-${Date.now()}`);
  });

  afterAll(async () => {
    for (const p of [projectA, projectB]) {
      if (!p?.id) continue;
      const res = await app.request(`/api/v1/admin/projects/${p.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      // Assert so cleanup failures are visible instead of leaking rows.
      expect(res.status).toBe(200);
    }
  });

  afterEach(() => {
    delete process.env.READ_TOKEN;
  });

  it('accepte le token du projet visé', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(`/api/v1/projects/${projectA.id}/stats`, {
      headers: { Authorization: `Bearer ${projectA.token}` },
    });
    expect(res.status).toBe(200);
  });

  it('REJETTE le token d’un autre projet (propriété centrale du plan)', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(`/api/v1/projects/${projectA.id}/stats`, {
      headers: { Authorization: `Bearer ${projectB.token}` },
    });
    expect(res.status).toBe(401);
  });

  it('refuse un token projet sur l’énumération (READ_TOKEN seul, D6)', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request('/api/v1/projects', {
      headers: { Authorization: `Bearer ${projectA.token}` },
    });
    expect(res.status).toBe(401);
  });

  it('scope par la query ?project= sur les routes /tests/*', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const ok = await app.request(
      `/api/v1/tests/some-test/history?project=${projectA.id}`,
      { headers: { Authorization: `Bearer ${projectA.token}` } }
    );
    expect(ok.status).toBe(200);

    const denied = await app.request(
      `/api/v1/tests/some-test/history?project=${projectA.id}`,
      { headers: { Authorization: `Bearer ${projectB.token}` } }
    );
    expect(denied.status).toBe(401);
  });
});
```

Ajouter `beforeAll` et `afterAll` à l'import vitest en tête du fichier.

Run: `pnpm --filter api exec vitest run src/routes/read-auth.test.ts`
Expected sans `DATABASE_URL` : le bloc `describeWithDb` se skippe, les 6 tests sans base passent.
Expected **avec** `DATABASE_URL` et `ADMIN_TOKEN` : tout passe, dont les 4 tests du fallback.

**Ce bloc doit être exécuté au moins une fois contre une vraie base avant de considérer la task terminée.** Un conteneur jetable suffit :

```bash
docker run -d --name flackyness-test-pg-041 -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=flackyness_test -p 5439:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5439/flackyness_test pnpm db:migrate
DATABASE_URL=postgres://postgres:test_password@localhost:5439/flackyness_test \
  ADMIN_TOKEN=test-admin-token pnpm --filter api exec vitest run src/routes/read-auth.test.ts
docker rm -f flackyness-test-pg-041
```

- [ ] **Step 6: Lancer toute la suite API**

Run: `pnpm --filter api exec vitest run`
Expected: PASS. **Aucune suite existante ne doit avoir changé** — elles tournent sans `READ_TOKEN`, donc en mode ouvert. Si une suite existante échoue, c'est une régression à corriger, pas un test à ajuster.

- [ ] **Step 7: Lint + typecheck**

Run: `pnpm lint && pnpm --filter api exec tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/projects.ts apps/api/src/routes/tests.ts apps/api/src/routes/read-auth.test.ts
git commit -m "feat(api): gate all read endpoints behind readAuth"
```

---

## Task 5: Le dashboard présente le token

Le client API du dashboard doit devenir **server-only** avant de pouvoir lire une variable d'environnement privée. `$lib/server/*` est la garantie structurelle de SvelteKit : tout import client-side échoue à la compilation. Le repo a déjà ce précédent (`$lib/server/basicAuth.ts`).

**Files:**
- Move: `apps/dashboard/src/lib/api.ts` → `apps/dashboard/src/lib/server/api.ts`
- Move: `apps/dashboard/src/lib/api.test.ts` → `apps/dashboard/src/lib/server/api.test.ts`
- Modify: 7 fichiers `+*.server.ts` et 5 fichiers de test (imports `$lib/api` → `$lib/server/api`)

**Interfaces:**
- Consumes: `READ_TOKEN` depuis `$env/dynamic/private`
- Produces: mêmes exports qu'avant (`getProjects`, `getProjectStats`, …), à un chemin d'import différent.

- [ ] **Step 1: Déplacer les fichiers**

```bash
git mv apps/dashboard/src/lib/api.ts apps/dashboard/src/lib/server/api.ts
git mv apps/dashboard/src/lib/api.test.ts apps/dashboard/src/lib/server/api.test.ts
```

- [ ] **Step 2: Mettre à jour les 16 sites d'import**

Sur macOS (ce repo) :

```bash
grep -rl '\$lib/api' apps/dashboard/src | xargs sed -i '' 's|\$lib/api|\$lib/server/api|g'
```

Sur Linux, `sed -i` ne prend pas d'argument vide :

```bash
grep -rl '\$lib/api' apps/dashboard/src | xargs sed -i 's|\$lib/api|\$lib/server/api|g'
```

Les 16 sites concernés : 7 fichiers `+*.server.ts`, 6 mocks `vi.mock(…)` dans les fichiers `page.server.test.ts` / `layout.server.test.ts`, et le `describe('lib/api', …)` de `api.test.ts` — ce dernier n'est qu'un libellé, le sed ne le touchera pas et c'est sans conséquence.

Vérifier :
Run: `grep -rn "\$lib/api'" apps/dashboard/src | grep -v server`
Expected: aucune sortie.

- [ ] **Step 3: Injecter le token dans `fetchJson`**

Dans `apps/dashboard/src/lib/server/api.ts`, ajouter l'import de l'env privée sous la ligne 1 :

```typescript
import { env as privateEnv } from '$env/dynamic/private';
```

Puis remplacer `fetchJson` (lignes 27-45) par :

```typescript
async function fetchJson<T>(path: string): Promise<T> {
  try {
    // Server-only by construction: this module lives under $lib/server, which
    // SvelteKit refuses to bundle into client code. READ_TOKEN must never be
    // exposed to the browser, which is also why it is NOT prefixed PUBLIC_
    // (unlike PUBLIC_API_URL above).
    const headers: Record<string, string> = {};
    if (privateEnv.READ_TOKEN) {
      headers.Authorization = `Bearer ${privateEnv.READ_TOKEN}`;
    }

    const response = await fetch(`${API_URL}${path}`, { headers });

    // A 401 here means the API has READ_TOKEN set and this dashboard either
    // has none or has the wrong one. Without this branch the generic message
    // below would blame the network, sending the operator to debug
    // connectivity for a configuration problem.
    if (response.status === 401) {
      throw error(
        500,
        `The Flackyness API rejected this dashboard's read credentials for ${path}. ` +
          'The API has READ_TOKEN set; set the same value as READ_TOKEN in the ' +
          "dashboard's environment."
      );
    }

    if (!response.ok) {
      throw error(
        response.status >= 500 ? 502 : response.status,
        `API request failed (${response.status}) for ${path}`
      );
    }

    return response.json();
  } catch (err) {
    if (isHttpError(err)) {
      throw err;
    }
    // Network errors, etc.
    throw error(503, `Cannot reach the Flackyness API (${API_URL}). Is it running?`);
  }
}
```

- [ ] **Step 4: Ajouter un test du chemin 401**

Ajouter dans `apps/dashboard/src/lib/server/api.test.ts` :

```typescript
it('surfaces a configuration message, not a network message, on 401', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }))
  );

  await expect(getProjects()).rejects.toMatchObject({
    status: 500,
    body: { message: expect.stringContaining('READ_TOKEN') },
  });

  vi.unstubAllGlobals();
});
```

- [ ] **Step 5: Lancer la suite dashboard**

Run: `pnpm --filter dashboard exec vitest run`
Expected: PASS, y compris les 6 fichiers de test dont les mocks `vi.mock('$lib/server/api', …)` ont été réécrits par le sed.

- [ ] **Step 6: Typecheck dashboard**

Run: `pnpm --filter dashboard check`
Expected: aucune erreur. (Ce paquet est épinglé sur TS 6 — voir `AGENTS.md`.)

- [ ] **Step 7: Commit**

```bash
git add -A apps/dashboard/src
git commit -m "feat(dashboard): move api client under \$lib/server and send READ_TOKEN"
```

---

## Task 6: L'Action envoie son token existant

Aucun changement d'interface : `action.yml:12` exige déjà `token`, et `comment.sh` l'a dans `FLACKYNESS_TOKEN`.

**Files:**
- Modify: `.github/action-scripts/comment.sh` (le fetch quarantine, ~ligne 86)

**Interfaces:**
- Consumes: `$FLACKYNESS_TOKEN`, déjà exporté par `action.yml`
- Produces: rien.

- [ ] **Step 1: Ajouter le header**

Dans `.github/action-scripts/comment.sh`, remplacer le `curl` du fetch quarantine par :

```bash
# The project token is already in hand (it authenticated the upload above).
# Sending it here lets a hardened API (READ_TOKEN set, plan 041) serve this
# request without the Action gaining a new input. On an API that has NOT been
# hardened the header is simply ignored, so this is safe to send always.
quarantine_status=$(curl -sS -o "$quarantine_body_file" -w '%{http_code}' \
  -H "Authorization: Bearer ${FLACKYNESS_TOKEN}" \
  "${API_URL%/}/api/v1/projects/${PROJECT_ID}/quarantine" 2>/tmp/flackyness-quarantine-stderr.log)
```

- [ ] **Step 2: Lancer la suite de tests de l'Action**

Run: `pnpm --filter api exec vitest run src/action-comment-sh.test.ts`
Expected: PASS. Ce fichier fait de la preuve par mutation sur `comment.sh` ; si une assertion d'ancrage échoue, l'ancre a bougé — mettre à jour le test **en comprenant pourquoi**, pas mécaniquement.

- [ ] **Step 3: Vérifier la dégradation sur 401**

Le chemin de repli existe déjà (`comment.sh:91` : tout statut ≠ 200 ⇒ `warn` + `exit 0`). Vérifier qu'il est bien toujours là :

Run: `grep -n "quarantine lookup failed" .github/action-scripts/comment.sh`
Expected: la ligne existe, dans une branche qui `exit 0`.

C'est ce qui rend le décalage de version inoffensif : un workflow épinglé sur une version antérieure de l'Action, tapant une API durcie, prend un 401, avertit, et ne casse aucun build.

- [ ] **Step 4: Commit**

```bash
git add .github/action-scripts/comment.sh
git commit -m "feat(action): send project token on the quarantine fetch"
```

---

## Task 7: Documentation

**Files:**
- Modify: `.env.example`, `docs/API.md`, `AGENTS.md`, `plans/README.md`

- [ ] **Step 1: `.env.example`**

Ajouter sous le bloc `# Security`, après `ADMIN_TOKEN` :

```bash
# Read endpoints (GET /api/v1/projects/*, /api/v1/tests/*) — unset means they
# are OPEN to anyone who can reach the API, and GET /api/v1/projects
# enumerates every project on the instance. That is the pre-plan-041 behaviour
# and remains the default so upgrades never break; the API logs a warning at
# boot when this is unset. Set it to require a Bearer token on reads. The
# dashboard must be given the SAME value (it presents it on every SSR call).
# A project token also grants read access to its own project, which is how the
# GitHub Action reads its quarantine list without a second secret.
# Generate a secure token: openssl rand -hex 32
# READ_TOKEN=
```

- [ ] **Step 2: `docs/API.md`**

Étendre la section `## Authentication` (ligne 5). Elle dit aujourd'hui « All write endpoints require Bearer token authentication » — c'est désormais incomplet. Remplacer par :

```markdown
## Authentication

All write endpoints require Bearer token authentication:

```
Authorization: Bearer your-project-token
```

**Read endpoints** (`GET /api/v1/projects/*`, `GET /api/v1/tests/*`) are open
by default. If the server sets `READ_TOKEN`, they require a Bearer token that
is **either**:

| Token | Scope |
|---|---|
| `READ_TOKEN` | every project on the instance |
| a project token | that project only |

`GET /api/v1/projects` and `GET /api/v1/tests/flaky/:id` accept `READ_TOKEN`
only — they are not scoped to a single project.

A project token presented for a *different* project gets `401`, so a project
token can never read another project's data.
```

- [ ] **Step 3: `AGENTS.md`**

Dans la section « Conventions », remplacer la ligne sur les nouveaux endpoints par :

```markdown
- New endpoints: apply rate limiting, update `docs/API.md`, add a route test.
  New **read** endpoints must also mount `readAuth()` — see plan 041. Guarded
  by `apps/api/src/routes-auth-coverage.test.ts`, which fails CI if a `GET`
  under `/api/v1` has no `readAuth` mounted, and which carries a hard-coded
  route count you must bump deliberately.
```

- [ ] **Step 4: `plans/README.md`**

Ajouter une nouvelle section de batch à la suite de « Batch 8 », avec cette ligne exacte :

```markdown
### Batch 9 — roadmap item #0: read-endpoint hardening (planned 2026-07-20 at commit `1607b01`)

Premier item de `docs/STRATEGY.md` après la révision de la roadmap sur le code réel. Écrit comme
un plan de conception (spec séparée dans `docs/superpowers/specs/`), parce que le choix de posture
— ouvert par défaut plutôt que fermé — est une décision produit, pas un détail d'implémentation.

| Plan | Title | Priority | Effort | Follow-up it closes | Status |
|------|-------|----------|--------|---------------------|--------|
| 041 | Gate the 11 read endpoints behind an optional `READ_TOKEN`, with a project-token fallback and a route-auth coverage guard | P2 | M | Roadmap item #0 (`docs/STRATEGY.md`); `.agent/CONTEXT.md:575-576` « revisit if commercialised » | TODO |
```

Mettre `Status` à `DONE (merged via PR #NN)` une fois la PR fusionnée, comme les 40 lignes précédentes.

- [ ] **Step 5: Vérification finale, suite complète**

Run: `pnpm lint && pnpm --filter api exec tsc --noEmit && pnpm --filter dashboard check && pnpm test`
Expected: tout vert.

- [ ] **Step 6: Vérifier que le mode ouvert est vraiment inchangé**

Run: `pnpm --filter dashboard test:e2e`
Expected: PASS sans modification. La suite E2E tourne sans `READ_TOKEN`, donc en mode ouvert — c'est la preuve de bout en bout que le défaut ne casse rien.

- [ ] **Step 7: Commit**

```bash
git add .env.example docs/API.md AGENTS.md plans/README.md
git commit -m "docs: document READ_TOKEN and read-endpoint authentication"
```

---

## Critères de réussite

1. `READ_TOKEN` non défini : comportement identique à aujourd'hui sur les 11 routes, plus un avertissement au démarrage. Prouvé par les suites existantes inchangées et par l'E2E.
2. `READ_TOKEN` défini : 401 sans credential, 200 avec `READ_TOKEN`, 200 avec le token du projet visé sur les 9 routes scopées, **401 avec le token d'un autre projet**.
3. `GET /api/v1/projects` et `GET /api/v1/tests/flaky/:id` refusent tout token projet.
4. L'Action fonctionne sans modification de son interface publique.
5. La garde de couverture échoue si l'on ajoute une route `GET` sous `/api/v1` sans monter `readAuth` — **vérifié par mutation en Task 4 Step 4**, pas supposé.
6. Aucune suite de tests existante n'a été modifiée.
