# Design — durcissement des routes de lecture (`READ_TOKEN`)

Date : 2026-07-20 · Repo à `1607b01` · Item **#0** de `docs/STRATEGY.md`

## Problème

Les 11 routes de lecture de l'API sont non authentifiées, et
`GET /api/v1/projects` énumère tous les projets de l'installation
(`routes/projects.ts:30` — seul `apiRateLimit` est monté). Les UUID ainsi
obtenus suffisent à lire stats, runs, tests flaky et quarantine de n'importe
quel projet.

C'est un choix assumé et documenté au stade concept
(`.agent/CONTEXT.md:575-576`, « Accepted by design (revisit if commercialised /
multi-tenant) »). Il devient bloquant face à la cible retenue par
`docs/STRATEGY.md` — secteur public, santé, finance — où il fait échouer la
revue de sécurité avant la démo.

## Objectif

Permettre à un opérateur de fermer la lecture avec un secret unique, **sans
casser aucune installation existante ni aucun workflow client déjà déployé**.

Hors périmètre : multi-tenant, comptes utilisateurs, SSO, rôles, routes admin,
et le rate limiter en mémoire. Ce sont les items #5 et #6 de la roadmap.

## Décisions

### D1 — `READ_TOKEN` absent ⇒ lecture ouverte, plus un avertissement au boot

Le repo contient les deux précédents opposés : `METRICS_TOKEN` non défini ⇒ 404
(fermé), `DASHBOARD_PASSWORD` non défini ⇒ aucune protection plus un
avertissement (ouvert). On suit **`DASHBOARD_PASSWORD`**.

Raison : fermer par défaut casserait toute installation existante à la montée
de version et rendrait le démarrage impossible sans configuration. En
self-hosted, l'opérateur connaît son réseau — le durcissement est sa décision,
pas la nôtre. L'avertissement au boot garantit qu'elle est prise sciemment et
non subie.

### D2 — Deux credentials acceptés, avec des portées différentes

| Credential | Portée | Usage |
|---|---|---|
| `READ_TOKEN` | tous les projets | dashboard SSR |
| token d'un projet | ce projet uniquement | Action CI |

Le token projet est déjà un credential d'écriture sur ce projet
(`middleware/auth.ts:57-86`) ; lui accorder la lecture du même projet
n'élargit pas la confiance.

Deux conséquences :

1. **L'Action ne change pas d'interface.** `action.yml:12` exige déjà `token`,
   et `comment.sh` l'a dans `FLACKYNESS_TOKEN` — il suffit de l'envoyer sur le
   fetch quarantine, qui part aujourd'hui sans header. Aucun nouvel input,
   aucun secret supplémentaire à configurer côté client.
2. **La fuite inter-projets se ferme structurellement.** Un token projet ne
   peut pas lire un autre projet, garanti par le middleware et non par la
   vigilance de chaque handler.

### D3 — Ordre d'évaluation : `READ_TOKEN` avant le token projet

Load-bearing pour la performance, pas seulement pour la lisibilité.

```
READ_TOKEN absent de l'env  ──────────────► next()   mode ouvert
Bearer == READ_TOKEN        ──────────────► next()   comparaison mémoire, 0 SQL
Bearer == token du projet visé ───────────► next()   1 lookup indexé
sinon                                       401
```

Mesures qui motivent cet ordre :

- Le dashboard émet 2 à 5 appels API par page vue, dont
  `GET /api/v1/projects` sur **chaque** page via `+layout.server.ts:8`.
- 7 des 11 routes de lecture n'exécutent qu'une seule requête aujourd'hui : un
  lookup d'auth systématique serait un +100 % de statements.
- Le pool est à 20 connexions sans pooler externe (`db/index.ts:16`).

Avec cet ordre, le dashboard ne paie **aucune** requête SQL d'auth. Seul le
repli token-projet en coûte une — c'est-à-dire l'Action, une fois par run de
CI, sur un index existant (`projects_token_hash_idx`, `schema.ts:27`).

### D4 — Montage route par route, pas `.use('*')`

`testsRouter` est mixte : 3 lectures publiques plus un
`PATCH /flaky/:id` déjà gardé par `adminAuth()` (`tests.ts:316`). Un
`.use('*', readAuth())` toucherait aussi le PATCH, qui exigerait alors
`READ_TOKEN` **et** le token admin — cassant l'action de mute du dashboard.

`projectsRouter` est homogène et accepterait `.use('*')`, mais on garde le
montage par route pour que les deux fichiers se lisent pareil et que la garde
de couverture (D7) n'ait qu'une seule forme à vérifier.

Ce point mérite d'être explicité parce qu'il va **à contre-courant du reste du
repo**, où toute auth est montée à l'échelle du routeur
(`reports.ts:62`, `admin.ts:16`). La garde de couverture est ce qui rend ce
choix sûr.

### D5 — `GET /tests/flaky/:id` : `READ_TOKEN` seul

Cette route n'expose aucun identifiant de projet dans la requête ; un repli
token-projet exigerait une lecture de `flaky_tests.project_id`. Seul le
dashboard la consomme. On paierait une requête pour un cas d'usage qui n'existe
pas — donc pas de repli : sans `READ_TOKEN` valide, 401.

### D6 — `GET /api/v1/projects` : `READ_TOKEN` seul, jamais de réponse conditionnelle

Le repo répond déjà à « même ressource, deux niveaux de privilège » par **deux
routes distinctes** : `GET /api/v1/projects` (publique, 3 champs) et
`GET /api/v1/admin/projects` (admin, 11+ champs). On suit ce patron.

Une réponse dont la forme dépend du credential rendrait le filtre load-bearing
et invisible : un refactor qui le contourne renvoie tous les projets au lieu
d'un seul, et c'est un mode de défaillance difficile à asserter en négatif. Or
`/projects` est précisément la route qui constitue le trou d'énumération — le
plus mauvais endroit pour ce patron.

Le besoin d'auto-découverte n'existe pas (`action.yml:16` exige `project-id`
en input). S'il apparaît, il se sert mieux par une route dédiée
`GET /api/v1/project` sous `projectAuth()`, avec un contrat à valeur unique.

### D7 — Une garde de couverture, pas une convention

`AGENTS.md` porte déjà quatre conventions écrites. Les deux qui ont été violées
en pratique — enregistrement ECharts, couverture Dependabot — ont toutes deux
été converties en garde statique après coup
(`chart-registration.test.ts`, `dependabot-coverage.test.ts`). La réponse
démontrée du projet à une convention violée est de cesser de s'appuyer sur la
convention.

Le risque est réel et mesuré : **4 des 11 routes de lecture actuelles sont
postérieures au commit initial, et deux d'entre elles ont été ajoutées le même
jour (2026-07-13) par deux plans différents.** L'ajout de routes est continu et
par rafales.

(Chiffre corrigé le 2026-07-20 : une première recherche annonçait 5 routes et la
date du 2026-07-15. Vérification par `git log -S` route par route pendant la
revue de la Task 3 : 7 routes datent du commit initial `b057d79`, et les 4
ajouts sont `/:id/trend` le 2026-02-05, `/:id/quarantine` et
`/:testName/trend` le 2026-07-13, `/:id/runs/:runId` le 2026-07-15.)

## Composants

| # | Quoi | Où |
|---|---|---|
| 1 | `readAuth(resolveProjectId?)` | `apps/api/src/middleware/auth.ts` |
| 2 | Avertissement au boot si `READ_TOKEN` absent | `apps/api/src/index.ts` |
| 3 | Montage sur 8 routes | `apps/api/src/routes/projects.ts` |
| 4 | Montage sur 3 routes | `apps/api/src/routes/tests.ts` |
| 5 | Injection du token sur les appels SSR | `apps/dashboard/src/lib/api.ts` |
| 6 | Header sur le fetch quarantine | `.github/action-scripts/comment.sh` |
| 7 | Garde de couverture des routes | `apps/api/src/routes-auth-coverage.test.ts` (nouveau) |
| 8 | Documentation | `.env.example`, `docs/API.md`, `AGENTS.md` |

`readAuth` réutilise `extractBearerToken`, `tokensMatch` et `hashToken`
(`middleware/auth.ts:25`, `:44`, `:10`) — aucune primitive cryptographique
nouvelle n'est écrite.

Le dashboard est **100 % SSR** : les 7 consommateurs de `lib/api.ts` sont tous
des `.server.ts`, et il n'existe aucun `+page.ts` universel. Le token peut donc
vivre en variable d'environnement privée. Il ne doit **jamais** porter le
préfixe `PUBLIC_`, qui l'exposerait au bundle navigateur — contrairement à
`PUBLIC_API_URL` (`api.ts:14`).

## Gestion d'erreur

- **401** via `HTTPException`, même forme que `projectAuth`/`adminAuth`.
  Message générique : ne pas révéler si c'est le token ou le projet visé qui ne
  correspond pas.
- **Décalage de version de l'Action** — un workflow épinglé sur une version
  antérieure verra son fetch quarantine renvoyer 401 le jour où l'API est
  durcie. Déjà géré : `comment.sh:91` dégrade sur tout statut ≠ 200 avec un
  `warn` et `exit 0`. Aucun build ne casse ; l'utilisateur perd la partition
  known-flaky, ce que le warn signale. Rien à ajouter.
- **Dashboard mal configuré** (API durcie, dashboard sans token) — à corriger :
  `fetchJson` ne distingue pas aujourd'hui les erreurs HTTP du réseau et
  renverrait « Cannot reach the Flackyness API » (`api.ts:44`), message faux
  pour un 401. Il faut un message dédié indiquant que `READ_TOKEN` manque côté
  dashboard.

## Tests

**Unitaires `readAuth`** — mode ouvert ; `READ_TOKEN` valide ; token projet sur
son propre projet ; token projet sur **un autre** projet ⇒ 401 ; header
absent ⇒ 401 ; format non-Bearer ⇒ 401.

**Garde de couverture** (`routes-auth-coverage.test.ts`) — lit `app.routes`,
propriété publique typée de Hono 4.12, aplatie avec les préfixes de montage
fusionnés et préservant l'identité des fonctions handler (aucun sous-routeur ne
définit d'`errorHandler`, donc pas de wrapping). Le test tourne sans base
(`db/index.ts:23-31` est un Proxy paresseux) et sans ouvrir de port
(`index.ts:92` gate `serve()` sur `VITEST`).

L'assertion est une **jointure exacte** (même méthode, même chemin). Vérifié
dans la source installée : `app.get(path, mw, handler)` appelle `#addRoute` une
fois par handler (`hono-base.js:47-49`), donc un middleware monté par route
produit sa propre entrée dans `app.routes`, avec la même méthode et le même
chemin que le handler. L'assertion est donc : pour chaque chemin distinct
servant un `GET` sous `/api/v1` hors `/admin`, il existe une autre entrée
`GET` de même chemin dont le handler est un `readAuth`.

**`readAuth` doit marquer le middleware qu'il retourne.** Chaque appel
`readAuth(resolver)` produit une closure distincte, donc une comparaison par
identité de référence ne peut pas fonctionner. La fonction retournée porte une
propriété marqueur (par exemple `isReadAuth = true`) que la garde teste. Ce
marqueur fait partie du contrat du middleware et doit être commenté comme tel :
le supprimer rend la garde silencieusement vacante.

Note : si un futur routeur homogène monte `readAuth` via `.use('*')`, l'entrée
devient `ALL` sur un chemin en `/*` et la jointure exacte ne la verra pas. La
garde doit donc échouer bruyamment sur une route non couverte plutôt que
supposer un style de montage — et D4 (montage par route, uniformément) est ce
qui garde cette hypothèse vraie.

**Anti-vacuité** — obligatoire, les deux gardes existantes l'embarquent et
commentent pourquoi. Asserter que `app.routes` est non vide, que le nombre de
routes `GET` sous `/api/v1` hors `/admin` trouvées est **exactement 11**
(chiffre à mettre à jour sciemment quand une route est ajoutée — c'est le
point qui force la relecture), et que `GET /api/v1/projects/:id/stats` est
détectée comme couverte. Sans ça, un refactor du montage laisse la garde verte
sur un ensemble vide.

**Suites existantes** — elles tournent sans `READ_TOKEN`, donc en mode ouvert,
donc **aucune ne change**. Idem pour la suite E2E. Zéro churn attendu ; tout
churn observé est le signe d'une régression.

**Nouvelle suite de gating** — un bloc qui définit `READ_TOKEN` et vérifie
qu'une route de lecture renvoie 401 sans header et 200 avec.

## Critères de réussite

1. `READ_TOKEN` non défini : comportement identique à aujourd'hui, sur toutes
   les routes, plus un avertissement au démarrage.
2. `READ_TOKEN` défini : les 11 routes de lecture renvoient 401 sans
   credential et 200 avec `READ_TOKEN`. Sur les **9 routes scopées à un
   projet** (7 dans `projects.ts`, 2 dans `tests.ts`) : 200 avec le token du
   projet visé, et **401 avec le token d'un autre projet**. Les 2 routes
   restantes — `GET /api/v1/projects` (D6) et `GET /api/v1/tests/flaky/:id`
   (D5) — renvoient 401 avec tout token projet.
3. L'Action fonctionne sans modification de son interface publique.
4. La garde de couverture échoue si l'on ajoute une route `GET` sous
   `/api/v1` sans monter `readAuth` — vérifié par mutation, pas supposé.
5. Aucune suite de tests existante ne nécessite de modification.
