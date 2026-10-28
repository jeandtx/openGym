---
name: bilan-mensuel
description: Bilan d'entraînement openGym sur le dernier mois (ou une période donnée) et proposition de la semaine suivante, via le serveur MCP opengym. À utiliser quand l'utilisateur demande son bilan mensuel, « comment s'est passé mon mois », l'impact de ses séances, ou de lui préparer / optimiser la semaine prochaine. Ne modifie rien sans accord explicite.
---

# Bilan mensuel et semaine suivante

Tu travailles avec le serveur MCP `opengym` (outils `mcp__opengym__*`). Les chiffres viennent
des outils, qui utilisent les mêmes fonctions que l'app : ne recalcule pas à la main ce qu'un
outil donne déjà, et n'invente aucun chiffre.

Si les outils `opengym` ne sont pas disponibles, ou répondent `ENOCONFIG` / `EAUTH`, arrête-toi
et renvoie l'utilisateur à `docs/MCP_CLAUDE_CODE.md` (appairage, `OPENGYM_TOKEN`).

## 1. Rassembler

Un seul appel par outil, en parallèle quand c'est possible :

- `training_review` : la période demandée (par défaut les 28 derniers jours) comparée à la
  précédente. Pour « le mois d'octobre », passe `from` / `to`. Tout y est de la muscu, sauf
  `other_sports` : les séances de natation, d'escalade, de padel… (séances, minutes, RPE moyen,
  par sport et par semaine).
- `recovery_status` : la fatigue de chaque muscle aujourd'hui.
- `get_week_plan` et `list_routines` : ce qui est prévu, et s'il y a déjà une « coach week ».
- `get_routine` pour chaque routine qui sert dans la semaine ou dont tu proposes de changer
  quelque chose.

## 2. Le bilan (court, factuel)

En français, avec des titres courts :

1. **Régularité** : séances de muscu par semaine face au plan (`planned_sessions_per_week`),
   semaine par semaine, durée moyenne. Les autres sports se comptent à part (section 6), jamais
   dans ce rapport au plan.
2. **Charge et effort** : volume et séries de travail face à la période précédente, % de séries
   à l'échec, RIR/RPE moyen s'il est noté.
3. **Progression** : les exercices principaux avec le 1RM estimé (meilleur, évolution face à la
   période précédente, tendance), les PR, les exercices **stagnants** (`stalled`) et ceux
   abandonnés.
4. **Équilibre musculaire** : séries effectives par muscle et par semaine. Signale les muscles
   sous environ 8 séries par semaine (ou non travaillés) et ceux au-dessus d'environ 20. Ce sont
   des repères, pas des règles.
5. **Poids de corps** : premier / dernier / variation, comparés à l'objectif.
6. **Autres sports** (si `other_sports.sessions` > 0) : séances et minutes par sport, face à la
   période précédente, RPE moyen, et les semaines où ils se sont empilés sur la muscu.
7. **Impact** : 3 à 5 constats qui relient ce qui a été fait aux résultats. Par exemple « +2
   séances de dos → tirage +8 % », « développé couché stagnant malgré 4 séances à l'échec »,
   « ischios sous-entraînés ». Les autres sports en font partie : « escalade la veille du
   tirage → tractions en baisse », « padel le lendemain des jambes ».

## 3. Proposer la semaine suivante

Une proposition concrète, justifiée par le bilan :

- **Les séances, dans l'ordre**, en partant des routines existantes. Tiens compte de
  `recovery_status` : ne mets pas en premier un muscle encore `fatigued`.
- **Les autres sports** : demande les jours où l'utilisateur les fait d'habitude (ou déduis-les
  de `other_sports.weeks`), et place la muscu autour. Pas de tirage ni de bras le lendemain de
  l'escalade, pas de jambes lourdes la veille du padel, épaules légères autour de la natation.
  `schedule_week` ne planifie que des routines : les sports figurent dans la proposition, pas
  dans la coach week.
- **Les changements de routine**, chacun avec sa raison :
  - lift stagnant → baisser les séries ou les reps, changer la plage de reps, ou remplacer
    l'exercice (`swap-exercise`), une seule de ces options par lift ;
  - muscle sous-entraîné → `add-exercise` ou `sets` en plus ;
  - trop d'échec ou fatigue élevée → moins de séries cette semaine.
- **Pas de charges inventées** : la politique de progression de la routine décide des poids.
  Pour dire à quel poids une séance s'ouvrira, demande `preview_session`.
- Un exercice nouveau se cherche avec `find_exercise`. Si le nom est ambigu, fais choisir
  l'utilisateur.

Présente la proposition sous forme de liste et **demande l'accord** (tout, une partie, ou des
modifications). N'écris rien avant.

## 4. Appliquer (après accord seulement)

1. `apply_plan_changes` avec `dry_run: true`, puis sans, avec un `summary` d'une ligne (« Bilan
   octobre : +volume dos, développé couché en 5×5 »). Passe `before` pour chaque changement
   chiffré, en reprenant la valeur lue dans `get_routine`. Si la réponse contient `stale` ou
   `problems`, rien n'a été appliqué : relis, corrige, redemande si besoin.
2. `schedule_week` avec les ids des séances dans l'ordre (y compris ceux renvoyés dans
   `new_routines`), `starts_on` = le lundi qui vient (ou la date convenue), un `label` court
   (« S45 »). Si une semaine tourne encore, `replace: true` seulement après accord. Si la réponse
   contient `weekday_plan_still_active`, dis-le et propose de mettre ces jours en repos (`week`
   → `"rest"`).
3. Termine par un récapitulatif de ce qui a changé, et rappelle que `revert_last_plan_change`
   annule le dernier changement de plan.

## Règles

- Une séance de sport racontée pendant le bilan (« j'ai aussi fait 1h de padel jeudi ») se
  note avec `log_sport`, après accord comme toute écriture.
- Aucune écriture (`log_*`, `apply_plan_changes`, `schedule_week`, `revert_last_plan_change`)
  sans accord explicite dans la conversation.
- Une erreur `ECONFIRM` demande une confirmation de l'utilisateur. Ne la contourne pas avec
  `replace: true` sans la lui poser.
- Les ids viennent des outils, jamais d'une supposition.
