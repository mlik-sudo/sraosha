# Sraosha — Design Document

## Rôle

Sraosha est un **wake layer minimal** : un daemon Telegram léger qui réveille et prépare Claude Code sur le Mac, depuis un iPhone.

```
iPhone (Telegram) → Sraosha (@your_sraosha_bot) → réveille Claude Code
                                                 → lance claude-tg
                                                 → l'utilisateur communique avec Claude
                                                    via le canal officiel
```

## Ce que Sraosha est

- Un interrupteur à distance pour Claude Code
- Un rapporteur d'état (sessions, daemon, claude-tg)
- Un lanceur de `claude --remote-control` et `claude-tg`
- Un daemon launchd fiable qui tourne en permanence

## Ce que Sraosha n'est PAS

- Pas un mini-Claude ou proxy permanent
- Pas un canal de conversation avec Claude
- Pas un intermédiaire pour exécuter des tâches complexes
- Pas un contrôleur d'apps macOS (Apple Music, Finder, etc.)

## Trois couches distinctes

| Couche                  | Responsable                      | Exemple                                |
| ----------------------- | -------------------------------- | -------------------------------------- |
| **Wake layer**          | Sraosha                          | `/wake`, `/tg`, `/status`              |
| **Communication layer** | Claude Telegram / Remote Control | Conversation directe avec Claude       |
| **Permission boundary** | macOS TCC                        | Permissions locales, non contournables |

## Commandes

| Commande      | Sûre à distance | Description                                                 |
| ------------- | :-------------: | ----------------------------------------------------------- |
| `/ping`       |       ✅        | Vérifier que le daemon est vivant                           |
| `/status`     |       ✅        | État complet : daemon, sessions, claude-tg, TCC             |
| `/wake`       |       ✅        | Lancer une session Remote Control                           |
| `/wake force` |       ✅        | Forcer une nouvelle session même si d'autres existent       |
| `/tg`         |       ✅        | Lancer claude-tg via tmux (ou vérifier s'il est déjà actif) |
| `/task`       |       ⚠️        | Expérimental, restreint, pas d'osascript/TCC                |

## Limite macOS TCC

macOS TCC (Transparency, Consent, Control) exige une validation **locale** pour que `node` puisse interagir avec d'autres apps (Contacts, Calendar, Finder, Apple Music, etc.).

Depuis l'iPhone, il est **impossible** de cliquer sur le dialogue TCC qui apparaît sur le Mac. Donc :

- Sraosha ne doit **jamais** lancer de commandes qui déclenchent TCC
- `/task` bloque les mots-clés TCC (osascript, apple music, finder, etc.)
- Pour les tâches nécessitant TCC → directement sur le Mac

## Différence Sraosha vs claude-tg

|                  | Sraosha                  | claude-tg                                |
| ---------------- | ------------------------ | ---------------------------------------- |
| **Bot**          | Votre bot Sraosha dédié  | Votre bot Claude Telegram                |
| **Rôle**         | Wake layer / status      | Conversation complète avec Claude        |
| **Daemon**       | Oui (launchd, permanent) | Non (lancé à la demande via tmux)        |
| **Intelligence** | Aucune (commandes fixes) | Claude complet                           |
| **TCC risk**     | Aucun                    | Possible (selon la tâche)                |
| **Lancement**    | Automatique (launchd)    | Via Sraosha `/tg` (tmux) ou manuellement |

### Comment Sraosha lance claude-tg

`claude --channels` nécessite un TTY. Un daemon launchd n'en a pas.

**Solution : tmux.** Sraosha crée une session tmux détachée qui fournit le TTY :

```bash
tmux new-session -d -s claude-tg -c $HOME \
  "claude --channels 'plugin:telegram@claude-plugins-official'"
```

- Le CWD `$HOME` est déjà trusté → pas de dialogue "workspace trust"
- tmux fournit le TTY → Claude démarre en mode interactif
- La session persiste en arrière-plan sans fenêtre visible
- Prérequis : tmux installé (`brew install tmux`)

## Architecture

```
launchd (com.sraosha)
  └─ node sraosha.mjs (PID permanent)
       ├─ Telegram long-polling
       ├─ /wake   → spawn claude --remote-control
       ├─ /tg     → tmux new-session → claude --channels (TTY fourni)
       └─ /task   → spawn claude -p (expérimental, restreint)
```

## Fichiers

- `~/.sraosha/sraosha.mjs` — code principal
- `~/.sraosha/.env` — secrets (ne jamais afficher)
- `~/.sraosha/sraosha.log` — logs runtime
- `~/Library/LaunchAgents/com.sraosha.plist` — config launchd
