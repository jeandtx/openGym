# openGym sur Vercel + Supabase

Ce fork ajoute un **mode Postgres** à l'API pour faire tourner openGym sans serveur à gérer :
le front et l'API sur Vercel, les données dans Supabase. Sans `DATABASE_URL`, rien ne change :
l'API garde ses fichiers JSON dans `DATA_DIR`, exactement comme l'image Docker de l'amont.

Instance de référence : **https://opengym-jeandtx.vercel.app**
(projet Vercel `opengym-jeandtx`, projet Supabase `opengym`, réf. `pwhfvxybkspiwdzcetbj`, Paris).

## Architecture

```
iPhone (PWA)  ──HTTPS──▶  Vercel, une seule origine (opengym-jeandtx.vercel.app)
                           ├─ /            fichiers statiques : build Vite + exercise-media/ (CDN Vercel)
                           └─ /api/*       UNE fonction Node 22 (cdg1, Paris) = api/server.js bundlé
                                             │  pooler Supabase, mode transaction (6543), 1 connexion/instance
                                             ▼
                                    Supabase Postgres (eu-west-3, Paris)
                                             ▲
                           pg_cron + pg_net ─┘  POST /api/cron/tick (rappels, minuteur de repos, purges)
```

### Pourquoi une « unit of work »

`api/server.js` garde tout en mémoire : `db.json` comme un objet modifié en place, les défis
WebAuthn, codes d'appairage, présence, minuteurs et compteurs de connexion dans des `Map`. En
serverless, aucun processus ne survit à une requête, et deux requêtes peuvent arriver sur deux
instances. `api/pg-store.js` fait donc de **chaque requête une transaction** :

1. verrou consultatif `pg_advisory_xact_lock` (les écritures se suivent, entre toutes les instances) ;
2. chargement depuis Postgres dans les objets mêmes que `server.js` utilise ;
3. exécution du handler **inchangé**, sa réponse retenue dans un tampon ;
4. écriture des seules lignes modifiées, `COMMIT`, et seulement ensuite envoi de la réponse.

Une réponse n'est donc jamais envoyée pour une écriture qui n'a pas abouti, et le code des routes
reste celui de l'amont (ce qui limite les conflits à chaque mise à jour). Les requêtes de lecture
pure (`GET /api/data/rev`, `/api/config`, `/api/me`…) ne prennent pas le verrou.

### La synchro (409)

`PUT /api/data` garde la sémantique de l'amont (`baseRev`, `baseWid`, tampons de `sync-stamps.js`,
`_rev`, `_wid`, `_wids`) et écrit le document par
`UPDATE user_state SET … WHERE user_id = $1 AND revision = $2`. Si aucune ligne n'est modifiée,
la réponse est le 409 habituel avec le document courant, que le client fusionne.
`GET /api/data/rev` (interrogé toutes les 30 s) ne lit que la colonne `revision`.

### Tables (`supabase/migrations/`)

| Table | Contenu |
|---|---|
| `users`, `credentials`, `push_subs`, `invites`, `device_links` | ce que contenait `db.json` (enregistrement complet en `json` + colonnes clés) |
| `user_state` | un document par profil (`doc json`) + `revision` |
| `audit_log` | journal d'activité (rétention `AUDIT_DAYS` / `AUDIT_MAX` appliquée par le tick) |
| `challenges`, `pairings` | défis WebAuthn et codes d'appairage, avec `expires_at` |
| `rate_limits` | compteurs de `api/rate-limit.js` |
| `presence`, `rest_timers` | « en train de s'entraîner », minuteurs de repos à envoyer |
| `cron_config` | URL du tick et Bearer, écrits par l'API elle-même |

Colonnes `json` (et non `jsonb`) : le texte est conservé tel que l'API l'a écrit, ordre des clés
compris, comme dans les fichiers.

**Sécurité** : RLS activé sur toutes les tables ; les seules policies sont pour le rôle
`opengym_api`, qu'utilise `DATABASE_URL`. `anon` et `authenticated` n'ont aucun droit : les clés
publiques Supabase ne donnent accès à rien. Aucune clé Supabase n'est utilisée par le front.

## Variables d'environnement (Vercel, environnement Production)

| Variable | Valeur | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://opengym_api.<ref>:<mot de passe>@aws-1-eu-west-3.pooler.supabase.com:6543/postgres?sslmode=require` | **secret** ; active le mode Postgres |
| `SESSION_SECRET` | 32 octets hex | **secret** ; signe les cookies. Le changer déconnecte tout le monde |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | clés Web Push | la privée est **secrète** ; les changer coupe les abonnements push (ils se réinscrivent) |
| `CRON_SECRET` | ≥ 16 caractères | **secret** ; Bearer attendu par `/api/cron/tick` |
| `RP_ID` | `opengym-jeandtx.vercel.app` | sans `https://` ; un passkey est lié à ce nom |
| `ORIGIN` | `https://opengym-jeandtx.vercel.app` | |
| `FIRST_USER_ADMIN` | `1` | le premier profil créé devient admin et propriétaire |
| `INVITE_ONLY` | `1` **après** la création du premier profil | sinon personne ne pourrait créer le premier |
| `ALLOW_GUEST` | `0` | pas de mode invité |
| `TRUST_PROXY` | `1` | Vercel réécrit `X-Forwarded-For` |
| `COACH_DISABLED`, `MEDIA_UPLOADS` | `1`, `0` | forcés de toute façon par la fonction |
| `DEFAULT_LANG` | `fr` | optionnel |

Les secrets ne sont jamais dans le dépôt. Pour les générer :

```bash
node scripts/vercel/gen-secrets.mjs          # SESSION_SECRET, VAPID_*, CRON_SECRET → .env.local (gitignoré)
node scripts/vercel/db-password.mjs <ref> aws-1-eu-west-3.pooler.supabase.com
#   → DATABASE_URL dans .env.local, et .vercel/db-verifier.sql :
#     alter role opengym_api password 'SCRAM-SHA-256$…'
```

Le second script ne laisse jamais sortir le mot de passe : il calcule son *verifier* SCRAM, que l'on
exécute dans l'éditeur SQL de Supabase. Un verifier permet au serveur de vérifier une connexion,
pas de se connecter. Le script ne remplace que les variables absentes, sauf `DATABASE_URL`, qu'il
régénère à chaque fois.

## Déploiement depuis zéro

1. **Supabase** : créer un projet (région Paris `eu-west-3`), puis exécuter dans l'éditeur SQL, dans
   l'ordre, les trois fichiers de `supabase/migrations/`. Le troisième (`*_opengym_cron.sql`)
   active `pg_cron` et `pg_net` et planifie les tâches.
   L'éditeur SQL peut dépasser son délai sur la boucle de droits du deuxième fichier : on peut
   l'exécuter en plusieurs fois, les instructions sont idempotentes.
2. Générer les secrets (ci-dessus) et exécuter `.vercel/db-verifier.sql` dans l'éditeur SQL.
3. **Vercel** : importer le dépôt, sans framework. `vercel.json` déclare un seul build
   (`@vercel/static-build`, qui lance `npm run vercel-build`, donc `scripts/vercel/build.mjs`) et
   reprend tel quel le `.vercel/output` qu'il produit. Renseigner les variables
   ci-dessus pour l'environnement Production. Mettre la *Deployment Protection* sur
   « Preview » uniquement : la production doit être publique, pour le téléphone comme pour `pg_cron`.
4. Pousser sur la branche de production. Le build :
   - compile le front (Vite) et copie `catalogue/media` dans `static/exercise-media/` ;
   - bundle `api/server.js` avec esbuild en **une seule** fonction (`functions/api.func`), qui
     sert aussi le MCP sur `/api/mcp` (`mcp/src/http.js`, `docs/MCP_CLAUDE_CODE.md`) ;
   - écrit les routes : `/api/*` vers la fonction, puis les fichiers, avec les en-têtes et la CSP
     du conteneur web (lue dans `web/Dockerfile`).
5. Ouvrir l'URL, créer **ton** profil (il devient admin), puis mettre `INVITE_ONLY=1` et redéployer.
6. Vérifier : `https://<domaine>/api/health` répond `{"ok":true,…}`, et dans Supabase
   `select tick_url from cron_config;` renvoie l'URL du tick (écrite à la première requête).

### Pourquoi pas la détection automatique de Vercel

Vercel transforme chaque fichier d'un dossier racine `api/` en fonction séparée. Le dossier `api/`
de ce dépôt contient un serveur, ses modules et ses tests : le premier déploiement a été refusé
pour ça (« No more than 12 Serverless Functions … on the Hobby plan »). Le renommer créerait un
conflit à chaque mise à jour de l'amont. `vercel.json` liste donc explicitement un seul build
(`builds`), ce qui coupe la détection automatique, et ce build écrit directement le format
*Build Output API v3*.

### Médias d'exercices

Les 13 108 images et animations (180 px, ~216 Mo) sont servies comme fichiers statiques par le CDN
de Vercel, depuis ce déploiement, avec un cache d'un mois. **Pas de jsDelivr ni d'autre CDN tiers** :
leur licence (Gym visual, `catalogue/media/NOTICE.md`) interdit le hotlink et les réserve à
l'application openGym. Si un déploiement devenait trop gros, `OPENGYM_NO_CLIPS=1` au build ne
déploie que les images fixes.

## Ce qui est différent du mode Docker

| Fonction | Mode Vercel + Supabase |
|---|---|
| Connexion par passkey, synchro, admin, invitations, journal | identique |
| Minuteur de repos (push quand l'appli est en arrière-plan) | **jusqu'à ~10 s de retard** : `pg_cron` regarde toutes les 10 s s'il y a un minuteur échu |
| Rappel du jour / relance de séance manquée | tick chaque minute (la logique amont tolère déjà 15 min de retard) |
| Photos/vidéos d'exercices perso | **désactivées** (corps de requête limité à 4,5 Mo sur Vercel, pas de disque) : l'appli propose un lien |
| Coach IA | **désactivé** (processus de fond, fichiers) |
| Serveur MCP (`mcp/`) | ne fonctionne pas (il lit `DATA_DIR`) |
| Requêtes | sérialisées par un verrou ; sans effet pour quelques profils |
| Taille du document de synchro | **limite de 4,5 Mo** par requête Vercel (l'amont accepte 5 Mo) |

## Sauvegarde

- **Export de l'appli** (le plus simple) : Réglages → Données → « Exporter une sauvegarde (JSON) ». Tout
  ton historique, réimportable dans n'importe quelle instance openGym.
- **Supabase** : le plan gratuit n'inclut pas de sauvegardes téléchargeables. Pour un dump complet
  depuis ta machine (chaîne de connexion « Session pooler » ou directe du tableau de bord,
  utilisateur `postgres`) :
  ```bash
  pg_dump "$SUPABASE_DB_URL" --schema=public --no-owner -Fc -f opengym-$(date +%F).dump
  ```
  ou, en JSON, une table à la fois depuis l'éditeur SQL :
  `select json_agg(t) from user_state t;`
- **Revenir à Docker** : il n'y a pas de script inverse. Le plus sûr est l'export JSON de l'appli,
  réimporté dans la nouvelle instance.

### Importer un `./data` existant

Depuis une machine qui peut joindre Supabase, avec la chaîne de connexion de l'utilisateur
`postgres` (pas `opengym_api`, qui ne peut pas vider les tables) :

```bash
cd api && npm install
DATABASE_URL='postgresql://postgres.<ref>:…@aws-1-eu-west-3.pooler.supabase.com:5432/postgres' \
  node ../scripts/vercel/import-data.mjs ../data            # base vide uniquement ; --replace pour écraser
```

Pour garder tout le monde connecté, mettre `SESSION_SECRET` au contenu de `data/secret`, et les
clés VAPID à celles de `data/vapid.json`.

## À surveiller

- **Pause Supabase** : un projet gratuit est mis en pause après 7 jours sans activité. Les appels
  de `pg_cron` comptent sans doute comme activité, mais ce n'est pas garanti. En cas de pause,
  l'appli garde tes données sur le téléphone, et un clic sur « Restore » dans le tableau de bord
  suffit.
- **Quotas** : Vercel Hobby (usage personnel non commercial) ; environ 45 000 invocations par mois
  pour le cron, bien en dessous du quota.
- **Logs** : Vercel → projet → Logs (`unit of work failed` signale un problème de base), et
  `select * from net._http_response order by created desc limit 10;` côté Supabase pour les
  appels du cron.

## Mettre à jour depuis l'amont

```bash
git fetch upstream
git checkout main && git merge upstream/main     # conflits éventuels : api/server.js surtout
cd api && npm test                               # mode fichiers : la suite de l'amont
PG_TEST_URL=postgres://postgres@127.0.0.1:5432/postgres npm test   # + le mode Postgres
git push origin main                             # Vercel redéploie
```

Points à vérifier à chaque mise à jour :

1. **Nouvel état global dans `api/server.js`** (une `Map`, un compteur, un `setInterval`) : en
   mode Postgres, il serait perdu entre deux requêtes. Il faut le brancher sur `pg-store.js`
   (`maps`, `limiters`) ou le désactiver quand `PG` est défini.
2. **Nouvelle lecture synchrone d'un état** (`readState`, `readStateCached`) dans une route : ajouter
   la route à `statesFor()` dans `server.js`. Sinon l'erreur
   `state of … was not loaded for this route` apparaît dans les logs.
3. **Nouveau fichier écrit dans `DATA_DIR`** : il n'existe que le temps d'une instance.
4. **Nouveau module à la racine de `api/`** : rien à faire pour Vercel (esbuild suit les imports),
   mais le test `dockerfile-copy` de l'amont l'exige dans le `COPY` du Dockerfile.
5. **Nouvelle collection dans `db.json`** : l'ajouter à `COLLECTIONS` dans `pg-store.js`, avec une
   table dans une nouvelle migration.
6. **Changement de la CSP** dans `web/Dockerfile` : repris automatiquement au build.
7. **Nouvelles variables d'environnement** documentées dans `.env.example` : les reporter dans Vercel.

## Licence

AGPL-3.0-or-later, comme l'amont. Ce fork est public, avec le code source de cette version :
https://github.com/jeandtx/opengym (branche `main`, identique à `vercel-supabase`).
