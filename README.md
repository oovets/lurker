<h1>
  <img src="lurker-icon.png" alt="" width="48" height="48" align="top">&nbsp;&nbsp;Lurker
</h1>

[![codecov](https://codecov.io/github/amiantos/lurker/graph/badge.svg?token=2KAFLPWKHG)](https://codecov.io/github/amiantos/lurker)

Lurker is a self-hosted modern IRC client with a retro flair, most easily described as "your personal [IRCCloud](https://www.irccloud.com), with [Weechat](https://weechat.org) looks".

Lurker runs as an always-on server that stays connected to IRC on your behalf, keeps full message history, and lets you reattach from any browser — desktop or mobile — picking up exactly where you left off. Open it on as many devices and tabs as you like; read state, settings, and history stay in sync everywhere; when all clients are disconnected, auto-away sets your status, and web push notifications inform you of highlights. Oh, and the icon rules.

# Features
- **Always-on and multi-user.** Each invited user connects to their own set of IRC networks, and Lurker stays connected when they're away.
- **Full history and search.** Every message is stored *and* searchable. Auto-away triggers after your last client disconnects, and smart push notifications fire on highlights.
- **IRC with Modern Convienences.** Peer presence, automatic nick regain, join/part summarization, tab nickname completion, message drafts, saved messages, user notes, and a searchable channel browser w/ cache.
- **Image uploads.** Paste, drag, or pick an image; Lurker optimizes it, uploads it to [x0.at](https://x0.at) or [catbox.moe](https://catbox.moe), inserts the link into your message, and keeps a history of all your uploads.
- **Customizable UI.** The beautiful retro terminal-style interface has 40+ settings to customize it how you want, and you can freely pin and rearrange channels and DMs.
- **Installable.** Lurker is a PWA — install it as a native-feeling app on your phone, Mac, or PC straight from the browser.

# Screenshot (as macOS PWA)

<img src="screenshot.png" alt="Lurker IRC client screenshot" width="100%">

# Rave Reviews

- `<cfuser> amiantos: holy shit, you made something better than irccloud`
- `<amigojapan> great, now that amiantos's chat client is catching up to IRC cloud, I think I can switch to it as my daily driver`
- `<skdoo> amiantos makes cool shit`

# Stack
- **Server** — Express, `irc-framework`, `ws`, `better-sqlite3`, `sharp`, `web-push`
- **Client** — Vue 3, Vite, Pinia, `vue-router`

# Installation

## Install (Docker — Recommended)

```bash
curl -O https://raw.githubusercontent.com/amiantos/lurker/main/docker-compose.yml
docker compose up -d
```

Then open <http://localhost:8015> and create your admin account. Username + password is the default; passkeys are optional. See [SELF_HOSTING.md](SELF_HOSTING.md) for the full guide — reverse proxy + HTTPS, enabling passkeys, push notifications, updating, and backups.

## Manual Install (without Docker)

```bash
npm run install:all
npm run client:build
npm start
```

The server listens on port 8010 by default and stores everything in `./data/`. Override with the envvars documented in [`.env.example`](.env.example).

## Development

```bash
npm run install:all
cp .env.example .env   # defaults assume the local hostname documented in the file
npm run dev
```

# Community

- Chat in **#lurker** on [Libera.Chat](https://libera.chat).
- Follow what's planned and in progress on the [project kanban](https://kanban.bradroot.me/projects/12/45#share-auth-token=heTq3lrceDTKVlNYHKTH6MPaDqA2pJowusiqETTL).
- Say hi — I'm **amiantos** on Libera.Chat and [MansionNET](https://inthemansion.com).

# License
Elastic License 2.0 — see [LICENSE](LICENSE). Source-available: you can use, copy, modify, and redistribute it, but you may not offer it to third parties as a hosted or managed service.

If you are a cloud hosting provider and wish to offer managed hosting for Lurker to your customers, or charge users for access to your Lurker instance, please contact [Brad Root](mailto:bradroot@me.com) for licensing details.
