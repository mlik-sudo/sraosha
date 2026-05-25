# Sraosha

**Wake-on-LAN intelligent pour Claude Code** — un daemon Node.js qui réveille Claude Code à distance via Telegram.

## Le problème

Claude Code est un outil CLI puissant, mais toutes ses fonctionnalités (Remote Control, Channels, `/schedule`, `claude agents`) nécessitent une session active. Si le terminal est fermé, tout est mort.

**Sraosha comble ce "cold start gap"** : un daemon léger, toujours à l'écoute, qui peut démarrer une session Claude Code depuis n'importe où.

## Architecture

```
iPhone → Telegram → Sraosha (daemon) → claude --remote-control → App Claude (Remote Control)
                                      → claude -p (tâche headless) → résultat → Telegram
```

- **Long polling Telegram** : connexion passive, quasi-zero CPU/réseau
- **launchd** : persistance système macOS (survit reboot + crash)
- **Bot dédié** : séparé du canal Claude Code pour éviter les conflits de polling
- **Health check silencieux** : toutes les 6h, log-only, alerte après 3 échecs

## Commandes

| Commande         | Description                                         |
| ---------------- | --------------------------------------------------- |
| `/wake`          | Lancer une session Claude Code en Remote Control    |
| `/wake!force`    | Forcer le lancement même si une session existe      |
| `/status`        | Voir les sessions Claude Code actives               |
| `/task <prompt>` | Exécuter une tâche headless et recevoir le résultat |
| `/ping`          | Vérifier que Sraosha est vivant                     |
| `/help`          | Afficher les commandes                              |

## Installation

### Prérequis

- macOS
- Node.js 20+
- Claude Code CLI installé (`claude`)
- Un bot Telegram (créé via [@BotFather](https://t.me/BotFather))

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
cp com.saheb.sraosha.plist ~/Library/LaunchAgents/
# IMPORTANT: éditer le plist pour adapter les chemins à votre système
launchctl load ~/Library/LaunchAgents/com.saheb.sraosha.plist

# 6. Vérifier
launchctl list | grep sraosha
cat ~/.sraosha/sraosha.log
```

### Obtenir votre Telegram User ID

Envoyez `/start` à [@userinfobot](https://t.me/userinfobot) sur Telegram.

## Sécurité

- Le token Telegram est stocké dans `.env` avec permissions `600`
- Seul l'utilisateur autorisé (via `ALLOWED_USER_ID`) peut envoyer des commandes
- Les messages d'utilisateurs non autorisés sont silencieusement ignorés
- Aucun port réseau n'est ouvert (long polling = connexion sortante uniquement)
- Le health check ne notifie que sur anomalie (pas de spam)

## Design Philosophy

> Sraosha doit rester connectée, mais pas constamment active.
> Comme un gardien à la porte : elle écoute, elle note, elle réveille seulement quand il y a une vraie raison.

- **v1.x** : écoute passive événementielle (réactif uniquement)
- **v2.0** (futur) : heartbeat léger toutes les 5h pour digest et routage conditionnel

## Nom

Sraosha est l'ange zoroastrien de l'écoute et de l'obéissance — celui qui est toujours à l'écoute, le messager divin.

## Licence

MIT
