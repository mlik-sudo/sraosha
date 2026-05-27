# Sraosha

**Wake layer minimal pour Claude Code** — un daemon Node.js qui réveille Claude Code et lance le canal Telegram officiel, le tout depuis un iPhone.

## Le problème

Claude Code est un outil CLI puissant, mais toutes ses fonctionnalités (Remote Control, Channels, `/schedule`, `claude agents`) nécessitent une session active. Si le terminal est fermé, tout est mort.

**Sraosha comble ce "cold start gap"** : un daemon léger, toujours à l'écoute, qui peut démarrer une session Claude Code depuis n'importe où.

## Architecture

```
iPhone → Telegram → Sraosha (daemon @your_sraosha_bot)
                         ├─ /wake   → claude --remote-control → App Claude
                         ├─ /tg     → tmux → claude --channels (Telegram officiel)
                         └─ /status → état complet
```

Trois couches distinctes :

| Couche                  | Responsable                | Rôle                           |
| ----------------------- | -------------------------- | ------------------------------ |
| **Wake layer**          | Sraosha                    | Réveiller / préparer Claude    |
| **Communication layer** | claude-tg / Remote Control | Conversation avec Claude       |
| **Permission boundary** | macOS TCC                  | Permissions locales uniquement |

## Commandes

| Commande      | Description                                         |
| ------------- | --------------------------------------------------- |
| `/ping`       | Vérifier que Sraosha est vivant                     |
| `/status`     | État complet : daemon, sessions, claude-tg, TCC     |
| `/wake`       | Lancer Claude Code en Remote Control                |
| `/wake force` | Forcer le lancement même si une session existe      |
| `/tg`         | Lancer claude-tg via tmux (canal Telegram officiel) |
| `/task`       | ⚠️ Expérimental, restreint (blocklist TCC)          |
| `/help`       | Afficher les commandes                              |

## Installation

### Prérequis

- macOS
- Node.js 20+
- Claude Code CLI (`claude`)
- tmux (`brew install tmux`)
- Un bot Telegram dédié (créé via [@BotFather](https://t.me/BotFather))

### Setup

```bash
# 1. Cloner
git clone https://github.com/mlik-sudo/sraosha.git ~/.sraosha
cd ~/.sraosha

# 2. Installer les dépendances
npm install

# 3. Configurer
cp .env.example .env
# Éditer .env avec votre token Telegram et user ID
chmod 600 .env

# 4. Trouver le chemin de Claude
which claude
# Mettre le chemin complet dans .env

# 5. Installer le daemon launchd
cp com.sraosha.plist.example ~/Library/LaunchAgents/com.sraosha.plist
# IMPORTANT: éditer le plist pour adapter les chemins à votre système
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sraosha.plist

# 6. Vérifier
launchctl list | grep sraosha
tail ~/.sraosha/sraosha.log
```

### Obtenir votre Telegram User ID

Envoyez `/start` à [@userinfobot](https://t.me/userinfobot) sur Telegram.

## Comment ça marche

### `/tg` — la commande clé

`claude --channels` nécessite un TTY (terminal interactif). Un daemon launchd n'en a pas.

**Solution** : Sraosha crée une session tmux détachée qui fournit le TTY :

```bash
tmux new-session -d -s claude-tg -c $HOME \
  "claude --channels 'plugin:telegram@claude-plugins-official'"
```

- Le CWD `$HOME` est déjà trusté → pas de dialogue "workspace trust"
- tmux fournit le TTY → Claude démarre en mode interactif
- La session persiste en arrière-plan sans fenêtre visible

### `/wake` — Remote Control

Lance `claude --remote-control` en arrière-plan. Utilisez l'app Claude sur iPhone pour prendre le contrôle.

### `/task` — expérimental

Lance `claude -p` avec des outils restreints (`Read`, `Bash(git *)`). Bloque les commandes qui déclenchent macOS TCC (osascript, Apple Music, Finder, etc.).

## Sécurité

- Le token Telegram est stocké dans `.env` avec permissions `600`
- Seul l'utilisateur autorisé (via `ALLOWED_USER_ID`) peut envoyer des commandes
- Les messages d'utilisateurs non autorisés sont silencieusement ignorés
- Aucun port réseau n'est ouvert (long polling = connexion sortante uniquement)
- `/task` utilise une blocklist TCC pour éviter les dialogues de permissions macOS
- `/task` restreint les outils Claude à `Read` et `Bash(git *)` uniquement

## Design Philosophy

Sraosha est un **interrupteur**, pas un intermédiaire.

- Elle réveille Claude, elle ne le remplace pas
- Elle rapporte l'état, elle ne prend pas de décisions
- Elle respecte la frontière des permissions macOS (TCC)

Voir [SRAOSHA_DESIGN.md](SRAOSHA_DESIGN.md) pour le document d'architecture complet.

## Nom

Sraosha est l'ange zoroastrien de l'écoute et de l'obéissance — celui qui est toujours à l'écoute, le messager divin.

## Licence

MIT
