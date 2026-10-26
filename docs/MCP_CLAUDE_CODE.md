# openGym dans Claude Code (MCP)

Ce fork branche le serveur MCP d'openGym (`mcp/`) sur l'instance Vercel + Supabase
(`docs/VERCEL_SUPABASE.md`). Depuis Claude Code (ou Claude Desktop), tu peux lire ton
historique, faire un bilan, enregistrer une séance ou une pesée, modifier tes routines et
planifier la semaine suivante.

Deux façons de le brancher :

- **Depuis l'app (le plus simple)** : l'instance sert le MCP elle-même, sur
  `https://opengym-jeandtx.vercel.app/api/mcp`, dans la même fonction Vercel que l'API. Rien à
  installer sur ta machine.
- **En local** : `node mcp/src/index.js`, lancé par Claude Code en stdio. Utile pour développer le
  MCP ou pour un client sans HTTP.

Dans les deux cas, les outils lisent et écrivent **via l'API** avec un jeton d'appareil (comme
l'app mobile appairée). Les données restent dans Supabase : rien n'est copié ailleurs.

```
Claude Code ──HTTPS + Bearer──▶ /api/mcp ──▶ mêmes outils ──HTTPS + même jeton──▶ /api/data …
            (ou stdio ▶ node mcp/src/index.js, en local)
```

## Depuis l'app (recommandé)

1. Dans l'app, connecté : **Réglages → Compte → « Connecter Claude » → Créer la commande**.
2. Copie la commande et lance-la une fois dans un terminal :

   ```bash
   claude mcp add --transport http opengym https://opengym-jeandtx.vercel.app/api/mcp \
     --header "Authorization: Bearer <jeton>"
   ```

3. Dans Claude Code, `/mcp` doit afficher `opengym` comme connecté, avec 17 outils.

La commande contient une **connexion complète à ton profil** : garde-la pour toi. Elle dure
`SESSION_DAYS` (90 jours par défaut), et **« Se déconnecter partout »** la révoque. Il suffit
ensuite d'en créer une nouvelle.

Ce point d'accès sert le Claude Code (et tout client MCP qui accepte un en-tête). Les
« connecteurs » de claude.ai et de Claude Desktop demandent une connexion OAuth, que ce point
d'accès n'a pas (pour ça, voir la PR amont DuarteSantos8/openGym#781).

## En local (stdio)

1. **Dépendances du MCP** :

   ```bash
   cd mcp && npm ci
   ```

2. **Un jeton pour ton profil.** Dans l'app, connecté : **Réglages → Compte → « Pair the mobile
   app »**. Un code s'affiche, valable 5 minutes. Puis :

   ```bash
   node mcp/scripts/pair.mjs https://opengym-jeandtx.vercel.app ABCD-1234
   ```

   Le script affiche le jeton sur la sortie standard. C'est une **connexion complète à ton
   profil** (comme l'app mobile appairée) : garde-le comme un mot de passe. Il dure
   `SESSION_DAYS` (90 jours par défaut), et **« Se déconnecter partout »** le révoque.

3. **Brancher Claude Code**, au choix :

   - **Par le dépôt** : `.mcp.json` à la racine déclare déjà le serveur `opengym`. Exporte le
     jeton avant de lancer `claude` **depuis la racine du dépôt** :

     ```bash
     export OPENGYM_TOKEN='<jeton>'          # par ex. dans ~/.zshrc, ou via un gestionnaire de secrets
     claude
     ```

     Claude Code demande d'approuver le serveur du projet la première fois. `OPENGYM_URL` vaut
     `https://opengym-jeandtx.vercel.app` par défaut ; exporte-le pour viser une autre instance.

   - **Pour tous tes projets** (chemin absolu, jeton dans ta config utilisateur) :

     ```bash
     claude mcp add opengym -s user \
       -e OPENGYM_URL=https://opengym-jeandtx.vercel.app -e OPENGYM_TOKEN='<jeton>' \
       -- node /chemin/absolu/vers/openGym/mcp/src/index.js
     ```

   Vérifie avec `/mcp` dans Claude Code : `opengym` doit être « connected », avec 17 outils.

## Les outils

| Lecture | Écriture (toujours après ton accord) |
|---|---|
| `list_routines`, `get_routine`, `preview_session` (poids réels de la prochaine séance), `get_week_plan` | `log_workout` : une séance décrite en langage naturel |
| `list_workouts`, `get_workout`, `get_bodyweight`, `estimate_1rm`, `muscle_balance` | `log_bodyweight` : une pesée |
| **`training_review`** : bilan d'une période face à la précédente | **`apply_plan_changes`** : modifier les routines et le planning hebdo (tout ou rien, avec un instantané pris avant) |
| **`recovery_status`** : fatigue et récupération par muscle | **`revert_last_plan_change`** : annuler le dernier changement de plan |
| **`find_exercise`** : nom → id dans la bibliothèque | **`schedule_week`** : la semaine suivante en « coach week » (séances dans l'ordre, épinglables à une date) |

Exemples :

- « Fais mon bilan du mois et propose-moi la semaine prochaine » : le skill
  `bilan-mensuel` (`.claude/skills/bilan-mensuel/SKILL.md`) déroule tout le parcours : bilan,
  proposition, accord, application.
- « J'ai fait 3×8 au développé couché à 80 kg, la dernière à l'échec » → `log_workout`.
- « Pesée ce matin : 79,4 » → `log_bodyweight`.
- « Mon squat stagne ? » → `training_review` puis `estimate_1rm`.

## Comment ça écrit

Chaque écriture fait ce que fait l'app : `GET /api/data`, changement sur une copie, puis
`PUT /api/data` avec la révision lue. Si un autre appareil a écrit entre-temps (409),
l'outil refait le changement sur le document renvoyé par le serveur. Le serveur estampille
lui-même les modifications (`api/sync-stamps.js`), donc ton téléphone les garde à sa prochaine
synchro, au plus tard 30 s après.

- `apply_plan_changes` utilise le moteur du Coach (`frontend/src/lib/coach.js`). Si un
  changement ne correspond plus au plan (`before` différent, routine supprimée), rien n'est
  appliqué. Un instantané est pris avant, et `revert_last_plan_change` (ou l'annulation du Coach
  dans l'app) le restaure.
- `schedule_week` écrit `S.queue` (`frontend/src/lib/queue.js`). Home affiche alors la semaine
  et propose la première séance non faite le jour où tu t'entraînes. Les routines du planning
  hebdo restent proposées à côté : l'outil le signale.

## Plus tard : le bilan automatique chaque mois

Le bilan peut tourner seul, en tâche planifiée Claude Code, dans un environnement cloud dont les
secrets contiennent `OPENGYM_TOKEN`, avec `cd mcp && npm ci` dans le script d'installation. Il
écrirait le bilan et la proposition. L'application reste manuelle : le skill n'écrit jamais sans
accord.

## Dépannage

| Message | Cause |
|---|---|
| `ENOCONFIG: … set OPENGYM_URL and OPENGYM_TOKEN` | `OPENGYM_TOKEN` n'est pas exporté dans le shell qui lance `claude`. |
| `EAUTH: … did not accept OPENGYM_TOKEN` | Jeton expiré ou révoqué (« Se déconnecter partout ») : refais l'appairage. |
| `EAPI: … redirects` | `OPENGYM_URL` n'est pas l'adresse https finale de l'instance. |
| `ECONFIRM: …` | L'outil demande ton accord (remplacer une semaine en cours, la rotation, un jour déjà planifié). |
| `opengym` « failed » dans `/mcp` | `npm ci` pas fait dans `mcp/`, ou `claude` lancé ailleurs qu'à la racine du dépôt (avec `.mcp.json`). |
