# Flackyness — Stratégie, roadmap & chiffrage

> Révision du 2026-07-20, calée sur l'état réel du code à `babee07`.
> Chaque affirmation « existe / n'existe pas » est adossée à un `fichier:ligne`.
> La version précédente raisonnait comme si on partait de zéro ; plusieurs
> briques étaient déjà livrées, et une brique annoncée comme livrée ne l'est pas.

Repo : https://github.com/jeremN/flakyness

## Positionnement

Ne pas concurrencer frontalement BuildPulse / Trunk.io / Datadog Test
Optimization sur les features (quarantine auto, AI fix, dashboards enterprise)
— ce sont des acteurs financés (Trunk : $28.5M levés) qui occupent le haut du
marché via la confiance enterprise (SSO, SLA, compliance), pendant que
l'open-source gratuit (Trunk free < 5 committers) bouffe le bas. Le milieu
classique du SaaS solo est écrasé entre les deux.

**Axe retenu : self-hosted-only, GPL-3.0.** (Licence déjà en place, `LICENSE`.)

- Zéro donnée de test qui sort de l'infra client
- Zéro coût qui grimpe avec le nombre de committers/tests
- Cible : boîtes avec contraintes de souveraineté des données (secteur public,
  santé, finance, DSI méfiantes du cloud US) — un segment que les gros SaaS ne
  peuvent pas efficacement servir

Le revenu ne vient pas du logiciel (gratuit) mais du **service** : installation,
customisation, contrat de support. Le produit sert aussi de vitrine technique
pour décrocher des missions d'audit fiabilité CI/tests E2E.

Ce positionnement tient. Ce qui suit ne le remet pas en cause — il corrige
l'ordre d'exécution et le chiffrage, et pointe deux failles du modèle de revenu.

## Ce qu'on apprend de la concurrence

| Acteur | Force | Faiblesse identifiée |
|---|---|---|
| BuildPulse | Framework-agnostic (Cypress, Jest, pytest, RSpec...), bien noté (G2) | SaaS uniquement, $99-499/mois |
| Trunk.io | Gratuit < 5 committers, auto-quarantine, intégration Jira | Financé, vise le haut de marché ensuite |
| Datadog Test Optimization | Bundlé si déjà client Datadog | Pricing opaque, surprend au renouvellement ; onboarding lourd si pas déjà sur Datadog ; détection dans la couche observability, quarantine à recâbler séparément |
| CircleCI Test Insights | Zéro friction si déjà sur CircleCI | Inutilisable hors CircleCI — lock-in plateforme |

**Aucun des acteurs analysés n'offre de self-hosted/on-prem** — trou structurel
confirmé.

---

## État réel du produit (relevé au 2026-07-20)

Les 40 plans numérotés (`plans/README.md`) sont tous DONE. Voici ce que ça
donne capacité par capacité.

| Capacité | Statut | Ce qui existe | Ce qui manque |
|---|---|---|---|
| **Ingestion multi-format** | 🟡 Partiel | Playwright JSON (`parsers/playwright.ts:442`) **et JUnit XML** (`parsers/junit.ts:280`), tous deux testés | Aucune abstraction. Le dispatch est un `if/else` sur le 1ᵉʳ octet du body (`routes/reports.ts:104-131`) |
| **Quarantine** | 🟡 Partiel | Endpoint `GET /projects/:id/quarantine` (`routes/projects.ts:153-202`), sortie JSON + `?format=playwright`, **réellement consommé** par `.github/action-scripts/comment.sh:84-96` | **Aucune règle auto.** Un test n'entre en quarantine que par `PATCH` admin manuel (`routes/tests.ts:316`). L'Action annote la PR, elle ne skippe jamais |
| **Notifications** | 🟡 Partiel | Un webhook JSON générique, 38 lignes (`services/notifications.ts:23-38`), par projet (`schema.ts:18`) | **Slack absent** (0 occurrence dans le repo). Pas d'interface `NotificationChannel`, pas de retry, pas de signature |
| **Seuils configurables** | 🟡 Partiel | 3 knobs par projet — `flakeThreshold`, `windowDays`, `minRuns` (`schema.ts:12-14`), bornés côté admin (`routes/admin.ts:25-58`) | Formule figée (`services/flakiness.ts:124`). Pas de règles par branche/tag/fichier, pas d'UI |
| **Multi-tenant** | 🔴 Absent | — | 4 tables, aucune notion d'org/tenant/user (`db/schema.ts`). Le scoping s'arrête à `projectId` |
| **Auth / SSO** | 🔴 Quasi absent | 3 secrets statiques (token projet, `ADMIN_TOKEN`, `METRICS_TOKEN`) + Basic optionnel sur le dashboard | Aucun SSO/OIDC/SAML, aucun compte utilisateur, aucun rôle. **Toutes les API de lecture sont ouvertes** |

### Deux corrections par rapport à la version précédente du doc

1. **JUnit XML est livré** (plan 017, PR #55 ; sniff corrigé par le plan 034,
   PR #77). L'item roadmap #1 le présentait comme à faire. Ce qui reste de #1,
   c'est **l'abstraction seule**.
2. **Slack n'est pas livré.** Le doc écrivait « Slack déjà là ». Ce qui existe
   est un webhook générique dont le payload est propriétaire
   (`services/notifications.ts:9-16`) — il ne s'afficherait pas dans Slack sans
   un formateur dédié.

> **Statut (branche `feat/notification-channels-slack`) :** l'item #3 de la
> roadmap ci-dessous est livré sur cette branche, pas encore mergé sur `main`
> au moment de cette révision. Ce qui a changé : un module
> `services/notifications/` remplace l'ancien webhook générique unique par une
> abstraction de canal — un formateur `generic` (contrat de compatibilité
> figé, identique octet pour octet à l'ancien payload, hormis `dashboardUrl`
> qui peut désormais porter un lien) et un formateur `slack`
> (`{ text, blocks }`, compatible Slack **et** Mattermost auto-hébergé via le
> champ `webhook_kind` en override explicite ; sinon détection automatique sur
> l'hôte `hooks.slack.com`). Les deux formats gagnent des deep-links dashboard
> quand la variable d'environnement globale `DASHBOARD_BASE_URL` est
> configurée. **Teams reste le fast-follow** — un formateur `formatTeams`
> supplémentaire s'ajoute au même point d'extension sans changer
> l'abstraction. Ce qui ne change pas : toujours aucun retry, aucune
> signature de payload (mêmes limites qu'avant, documentées dans
> `docs/API.md`). La correction #2 ci-dessus (« Slack n'est pas livré ») et la
> case « Slack absent » de la ligne Notifications du tableau plus haut sont
> donc résolues par ce travail ; le reste de cette section — écrite avant
> cette livraison — est laissé tel quel.

### Le point bloquant que le doc précédent ne voyait pas

**Toutes les routes de lecture sont non authentifiées, et
`GET /api/v1/projects` énumère tous les projets de l'installation**
(`routes/projects.ts:30` — seul `apiRateLimit` est appliqué). Les UUID ainsi
obtenus suffisent à lire stats, runs, tests flaky et quarantine de n'importe
quel projet.

C'est un choix assumé et documenté (`.agent/CONTEXT.md:575-576` : « Accepted by
design (revisit if commercialised / multi-tenant) ») — parfaitement défendable
au stade validation de concept. Mais le doc marque la cible comme *secteur
public / santé / finance*, et dans ce segment ce n'est pas un item à traiter
« sur demande client » : **c'est ce qui fait échouer la première revue de
sécurité, avant même la démo.** Le correctif est par ailleurs peu coûteux (un
read-token gardé par variable d'environnement, que les loads SSR du dashboard
présentent), très loin des 3-5 j du SSO complet.

C'est la principale raison de réordonner la roadmap.

> **Statut (branche `design/read-hardening`) :** l'item #0 ci-dessous est
> livré sur cette branche, pas encore mergé sur `main` au moment de cette
> révision. Ce qui a changé : un `READ_TOKEN` optionnel (variable d'env)
> gate désormais les 11 routes de lecture — absent = comportement inchangé
> (lecture ouverte, avertissement au boot) ; présent = Bearer requis
> (`READ_TOKEN` global ou le token du projet ciblé, qui ne donne accès qu'à
> ce projet-là). Une garde de couverture (`routes-auth-coverage.test.ts`)
> échoue en CI si une nouvelle route `GET` sous `/api/v1` est ajoutée sans
> monter ce middleware. Le reste de cette section — écrite avant ce
> correctif — est laissé tel quel : c'est l'état qui a motivé la décision.

### Contraintes techniques qui gouvernent le chiffrage « hébergement »

Indépendantes des six capacités, mais bloquantes dès qu'on héberge pour
plusieurs clients (positionnement agence) :

- **Rate limiter en mémoire** (`.agent/CONTEXT.md:584`) — une seule réplique API
  possible. Passer à un store partagé (Redis) avant de scaler horizontalement.
- **Agrégation de flakiness en mémoire** (`services/flakiness.ts:162-179`) —
  charge toute la fenêtre en RAM. OK à l'échelle actuelle, à pousser en SQL
  `GROUP BY` si les volumes montent.

---

## Roadmap révisée

Changement principal : le durcissement de la lecture passe en tête (nouveau #0),
parce que la cible ne peut pas installer sans. Le reste suit la logique
d'origine, re-chiffré sur ce qui existe.

| # | Feature | Pourquoi cet ordre | Effort révisé | Effort doc v1 |
|---|---|---|---|---|
| **0** | **Read-token gardé par env + arrêt de l'énumération globale de `/projects`** | **Prérequis d'évaluation** dans le segment souveraineté, pas un upsell. Coût dérisoire au regard du blocage qu'il lève | **0,5-1 j** | *(absent)* |
| 1 | Abstraction `ReportParser` (registry + module de types neutre + dispatch par forme) | JUnit est déjà livré : le marché est ouvert. Ce qui reste, c'est ce qui rend vraie la ligne « 2-3 j par framework » | **1-1,5 j** | 3-4 j |
| 2 | Auto-quarantine réelle (règle de promotion + TTL + traçabilité du mute) | Met à parité avec BuildPulse/Trunk. Toute la plomberie aval existe déjà — **mais exige une décision produit, voir ci-dessous** | **2-3 j** | 4-6 j |
| 3 | Interface `NotificationChannel` + formateur Slack (+ Teams) — **livré** (branche `feat/notification-channels-slack`, voir statut plus haut) ; Teams reste le fast-follow | Gain rapide, visible en démo. Le transport générique existe, il manque l'abstraction et le formatage | **1-1,5 j** | 1-2 j |
| 4 | 4a — UI admin ; 4b — rule engine de seuils (règles par branche/tag/fichier, compteurs consécutifs). **4a livrée** (branche `feat/admin-console-ui`, voir statut plus haut) ; 4b reste à faire, spec/plan séparé | Dépend de #2 pour 4b. Les 3 knobs numériques existent déjà et sont per-project ; 4a couvre l'accès sans `curl`, 4b reste à écrire pour l'expressivité | **UI 1 j (fait) + règles 2-3 j** | 3-4 j |
| 5 | Multi-tenant (+ store de rate-limit partagé) | Utile seulement en hébergement multi-clients. Le blocage mono-réplique s'ajoute au chantier | **7-10 j** | 5-8 j |
| 6 | SSO / comptes / rôles | Après #0, ce n'est plus un prérequis d'évaluation mais un vrai upsell enterprise. À déclencher sur demande | 4-6 j | 3-5 j |
| — | Modules par framework (Cypress, Jest, pytest, RSpec…) | S'ouvre une fois #1 posé — chaque parseur devient un module indépendant | ~1,5-2,5 j / framework | ~2-3 j |

**Total #0→#4 : ~8-11 j** (contre 11-16 j au chiffrage v1) pour un produit
vendable et différenciant, sécurité de lecture incluse.

> **Statut (branche `feat/admin-console-ui`) :** 4a est livrée sur cette
> branche, pas encore mergée sur `main` au moment de cette révision. Ce qui a
> changé : un `/admin` gardé par le même `DASHBOARD_PASSWORD` (Basic Auth,
> `hooks.server.ts`) que le reste du dashboard donne accès à la liste des
> projets, la création (avec révélation du token une seule fois, jamais
> re-consultable), l'édition des réglages par projet, la rotation de token, le
> prune en deux temps (dry-run → confirm) et la suppression avec confirmation
> tapée. Aucune nouvelle route API : le console appelle les endpoints admin
> existants via un client serveur-only (`$lib/server/adminApi.ts`) qui porte
> `ADMIN_TOKEN` — le token ne quitte jamais le serveur, la vraie frontière de
> sécurité reste l'API elle-même (le SSO de #6 la remplacera plus tard). 4b
> (règles par branche/tag/fichier) n'est pas commencé et reste une
> spec/plan séparée.

> **Statut (branche `feat/quarantine-rule-engine`) :** 4b est maintenant
> livrée sur cette branche, pas encore mergée sur `main` au moment de cette
> révision — la dernière phrase du callout ci-dessus (« 4b n'est pas commencé »)
> date d'avant ce travail. Ce qui a changé : une table `quarantine_rules` par
> projet (règles ordonnées par `position`, sélecteurs glob branche/fichier/tag,
> condition `flake_rate` ou `consecutive`, action `quarantine` ou `exempt`), un
> moteur d'évaluation pur (`services/rules.ts`, first-match-wins) et son
> intégration dans `reconcileQuarantine` : dès qu'un projet a ≥1 règle activée,
> la promotion passe par les règles — avec repli sur le seuil legacy du projet
> quand aucune règle ne matche un test donné, pour un comportement identique à
> la 051 en l'absence de règles. Une règle `consecutive` peut mettre en
> quarantaine un test pas encore globalement flaky (aucune ligne `flaky_tests`
> active) : la promotion fait donc un *upsert* plutôt qu'un update. Chaque mute
> déclenché par une règle garde `mute_source='auto'` et écrit une ligne
> `quarantine_events` désormais tracée par `rule_id` ; les mutes manuels
> (`mute_source` `'manual'`/`NULL`) restent immuables, comme avant. Mesure de
> base de la flakiness et `buildGrepInvert` inchangés. CRUD + réordonnancement
> des règles est exposé côté API admin
> (`/api/v1/admin/projects/:id/rules`) ; **l'UI console pour gérer les règles
> reste le fast-follow sanctionné** (spec/plan séparée, réutilisant le
> `adminApi` serveur-only et les form actions de 4a).

### Le piège technique de #1

Le sniff actuel est binaire : `<` ⇒ JUnit, sinon ⇒ Playwright. Le `else`
appelle `parsePlaywrightReport` **sans condition**. Un deuxième format JSON
(Cypress, Jest) n'a donc aucun discriminant : il faut *remplacer* le dispatch,
pas l'étendre. Fait maintenant, c'est 1-1,5 j ; fait au 4ᵉ parseur, on paie
en plus les régressions des trois premiers. C'est le seul item de la liste
dont le coût augmente strictement avec le temps.

### La décision produit cachée dans #2

`routes/projects.ts:191-193` exclut délibérément les tests auto-détectés du
`grepInvert`, avec ce motif : *« Auto-skipping a machine-detected test without
human sign-off would silently hide a real regression. »*

Livrer « l'auto-quarantine réelle » revient donc à **révoquer une décision de
sécurité réfléchie**, pas à combler un oubli. Trois options, à trancher avant
d'ouvrir le chantier :

- **A — Auto-quarantine avec sign-off.** La règle *propose* (nouveau statut
  `proposed`), un humain confirme. Conserve la garantie, coûte un aller-retour
  et n'atteint pas la parité perçue avec Trunk.
- **B — Auto-quarantine avec TTL + notification.** La règle mute
  automatiquement mais l'expiration est obligatoire et la transition est
  notifiée. Parité fonctionnelle, garantie affaiblie mais bornée dans le temps.
- **C — Auto-quarantine opt-in par projet.** Défaut = comportement actuel ;
  option activable par le client. Le plus vendable en self-hosted (« c'est
  votre politique, pas la nôtre ») et le plus cohérent avec le positionnement
  souveraineté.

Recommandation : **C, avec B comme comportement de l'option activée.** Ça
préserve la posture par défaut, ça donne un argument de démo, et ça transforme
la question en paramètre de calibration — donc en prestation facturable au
Setup.

---

## Chiffrage indicatif

Hypothèses à deux TJM (à ajuster selon le TJM réel appliqué) :

| Bloc | Contenu | Effort | @600€/j | @800€/j |
|---|---|---|---|---|
| Setup | Install self-hosted, intégration CI (GitHub Actions ou GitLab), calibration seuils, formation courte | 2-3 j | 1 200-1 800 € | 1 600-2 400 € |
| Support | Updates, bugfixes prioritaires, hotline légère (réponse sous 48-72h) | ~1 j/mois équiv. | 300-500 €/mois | 400-650 €/mois |
| Custom (nouveau parseur, SSO, multi-tenant, intégration Jira...) | Variable | à la journée | 600 €/j | 800 €/j |
| Audit "flaky tax" (diagnostic amont, porte d'entrée commerciale) | 1-2 j | 600-1 200 € | 800-1 600 € |

**Point d'attention (v1, toujours valide) :** le forfait Setup doit rester bas
(quasi loss-leader). C'est l'Audit et le Support récurrent qui doivent porter la
marge — sinon on retombe dans le piège classique du consulting solo : vendre du
temps one-shot sans base récurrente.

### Deux failles du modèle de revenu

**1. Il n'y a pas de funnel.** Self-hosted + GPL = zéro télémétrie, zéro
visibilité sur qui installe. Le Support récurrent à 300-500 €/mois n'a de sens
qu'avec N clients, et rien dans le produit ne génère ce N : on n'apprend
l'existence d'un utilisateur que le jour où il écrit. C'est le trou structurel
du modèle — pas le niveau de prix.

Pistes, par ordre de compatibilité avec le positionnement :

- **L'Audit comme porte d'entrée réelle, pas comme ligne de tarif.** Il est déjà
  listé ; il doit devenir le produit d'appel *principal* et se conclure
  systématiquement sur une install. C'est le seul canal où le prospect se
  manifeste avant d'avoir installé.
- **Un « check de santé » explicitement opt-in** (endpoint que l'opérateur
  active sciemment, en échange d'un rapport de configuration). Défendable en
  souveraineté seulement s'il est off par défaut, documenté, et sans donnée de
  test.
- **Le contrat de support attaché à la version**, pas à l'usage : la GPL
  n'empêche pas de facturer la garantie de compatibilité de montée de version.

**2. La cible et l'ordonnancement se contredisaient.** Le doc v1 reléguait le
SSO en « à la demande client explicite ». Dans le secteur public / santé /
finance, on ne reçoit pas la demande : on reçoit un refus silencieux. Le
nouveau #0 lève la partie bloquante pour ~0,5-1 j ; le SSO complet (#6) peut
alors légitimement rester sur signal client.

---

## Ce qui n'a pas bougé

Le positionnement, la lecture de la concurrence, la structure du chiffrage et
l'avertissement sur le forfait Setup sont repris tels quels de la v1 — l'analyse
tenait. Ce qui a changé, c'est l'ordre d'exécution (#0 en tête), les efforts
(re-calés sur le code existant), et l'explicitation de deux décisions qui
étaient implicites : la politique d'auto-quarantine, et l'absence de funnel.
