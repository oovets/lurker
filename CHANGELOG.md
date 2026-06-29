# Changelog

All notable changes to this fork are documented here. This file summarises the
`feature/split-panes` branch against `origin/main` (base version `1.0.6`).

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — `feature/split-panes`

Two large additions on top of upstream `1.0.6`: **split-window panes** in the
desktop client, and **Slack support** as a first-class provider behind the
existing Vue web client (the client is driven unchanged — only the server's
connection layer is swapped).

### Added — Composer

- **Emoticon auto-conversion**: typing a standalone ASCII emoticon (`:)`, `<3`,
  `:D`, `;)`, `:P`, ...) rewrites it to the emoji glyph as you type, alongside
  the existing `:shortcode:` conversion. A word-boundary rule keeps URLs safe
  (the `:/` in `http://` is never mistaken for an emoticon).

### Added — Split-window panes

- Multi-pane desktop layout: an auto-wrapping 2D grid of chat panes, each
  showing its own buffer, so several conversations are visible at once.
- One shared message input, bound to the currently focused pane.
- **Right-click → "Open in Split"** on a buffer to open it in a new pane.
- Pane state (`panes[]` + `focusedPaneId`) lives in the networks store;
  `activeKey`/`activeBuffer` remain as getters off the focused pane for
  backwards compatibility, and buffer activation is pane-aware (a buffer shown
  in another pane isn't reset out from under it).

### Added — Slack support

A new `SlackConnection` implements the same `Connection` contract as
`IrcConnection`, so `ircManager`, `wsHub`, persistence, backlog/history and
read-state all work unchanged. Uses the official `@slack/web-api` +
`@slack/socket-mode` SDKs.

**Connectivity & setup**

- Per-network `provider` column plus encrypted `slack_bot_token` /
  `slack_app_token` (via the existing `secretCrypto` at-rest encryption);
  registered in the export schema.
- Network form gains a provider toggle and Slack token fields.
- **OAuth "Add to Slack"** install flow: a public callback endpoint exchanges
  the consent `code` for a bot token (HMAC-signed, time-boxed `state` bound to
  the Lurker user), creates the Slack network and connects — no token
  copy-paste. Config via `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` /
  `SLACK_APP_TOKEN` / `SLACK_OAUTH_REDIRECT_BASE`; falls back to manual token
  entry when unset.
- **Credential-free demo mode**: sentinel `demo` tokens spin up a canned
  in-process workspace (channels, DMs, group DM, history, live drip) that
  exercises the full server→client contract.
- A seed script (`tools/seed-slack-network.ts`) to create a Slack network from
  env tokens.

**Messages & history**

- Conversations become buffers: channels (`#name`), DMs (peer display name),
  and **group DMs / mpim** (named by participants, e.g. `alice, bob`).
- History backfill on connect, live messages via socket mode, send, typing
  indicators, and channel member lists (nicklist).
- **Page-up history**: older messages paged in on scroll via a Slack `ts`
  cursor.
- **Message edits & deletes** reflected live (matched by Slack `ts`).
- **Mark-as-read sync**: reading a buffer in Lurker advances Slack's read
  pointer (`conversations.mark`), so Slack stops showing it unread.

**Rendering**

- Slack markup resolved into Lurker's conventions: mentions (`<@U…>` →
  `@Name`), channel links (`<#C…|name>` → `#name`), URLs, `@here`/usergroups,
  and HTML entity unescaping.
- **Block Kit / rich-text fallback**: app/bot messages that ship only `blocks`
  (no `text`) are walked — `rich_text` (incl. lists, quotes, preformatted),
  `section`, `header`, `context` — instead of rendering blank.
- App/bot messages show their real names (bot_profile / `bots.info`) instead of
  "unknown".
- **Workspace-custom emoji**: the standard `:shortcode:` autocomplete already
  covers Unicode emoji; now a workspace's custom emoji (from `emoji.list`, with
  alias chains resolved) also appear in the `:he…` picker (with image
  thumbnails) and render as inline images in message bodies and reaction chips.
  Selecting a custom emoji inserts its `:name:` (a textarea can't hold an
  image); served per-network via a `slack-emoji` route and cached client-side.

**Interaction**

- **Reactions**: real reaction chips, click a chip to toggle your reaction, and
  an **add-any-reaction** picker (a small popover of common emoji) reusing the
  global context menu.
- **Threads** open in a live side-pane (built on split panes), with replies
  streaming in.
- **@mention completion** inserts `@name` and the server encodes it to
  `<@id>` so Slack notifications actually fire; `#channel` mentions resolve too.
- **File / image attachments**: images render inline and files link out, served
  through a same-origin proxy route that streams Slack's auth-gated
  `url_private` with the bot token.
- **Presence** (online/away) probed on demand for DM peers.
- **Join / leave** a channel the bot isn't in yet (resolves the name to an id
  via the channel directory, joins, backfills, and re-snapshots).
- **Whole-workspace search** via `search.messages` for a Slack-scoped query
  (needs a user token; gracefully falls back to local mirror search otherwise).

### Added — iMessage support (via BlueBubbles)

A third provider, `ImessageConnection`, implementing the same `Connection`
contract. It is a client of a self-hosted **BlueBubbles** server (an iMessage
bridge that runs on a Mac and exposes a REST API + Socket.IO feed), so the Lurker
server talks HTTP+WS to the Mac while the client renders iMessage exactly like
IRC and Slack. `github.com/oovets/imessage-tui` is the reference for the
BlueBubbles calls + data model.

- Per-network `provider: 'imessage'` plus an `imessage_server_url` (cleartext)
  and `imessage_password` (encrypted at rest); a provider toggle + two fields in
  the network form.
- Chats become buffers: 1:1 chats as DMs (contact-resolved name), group chats as
  participant-named buffers with a member list. Contacts resolve handle
  addresses to display names, matching on the last 9 digits so formatting
  differences (spaces/dashes, present/absent country code) still resolve.
- The sidebar orders Slack/iMessage buffers by **recent activity** (newest on
  top, like the native apps) instead of alphabetically, so active chats rise, a
  new message bumps its chat up, and one-off numbers sink. IRC keeps its
  channels-first alphabetical order.
- History backfill on connect, live messages via the Socket.IO feed, sending
  (`POST /message/text`), and **mark-as-read** sync (`POST /chat/{guid}/read`).
  A reconciliation poll re-fetches chats + recent messages so brand-new chats
  and any socket-missed messages still appear, and de-dups against the mirror so
  reconnects don't re-insert history.
- **Tapbacks** (love/like/dislike/laugh/emphasize/question) fold onto the target
  message as reaction chips, and click-to-react sends a tapback.
- **Image / file attachments** stream through a same-origin proxy route
  (`/api/networks/:id/imessage-attachment/:guid`).
- A credential-free demo mode (sentinel `demo` server/password) with a canned
  1:1 + group chat, a tapback, and a live drip.

### Added — Rich media (all providers)

- **Link previews**: messages containing a URL show a rich card (title,
  description, thumbnail, site) for Spotify, YouTube, news sites, etc. Unfurled
  server-side (`GET /api/link-preview`) via provider oEmbed → noembed →
  OpenGraph/Twitter-card HTML, SSRF-guarded and cached. The client fetches each
  card lazily (IntersectionObserver) so opening a long history never fires a
  request per link.
- **Inline video**: video attachments (iMessage/Slack) render as an inline
  `<video controls>` player instead of a download link, alongside the existing
  inline images.

### Changed

- `ircManager` is provider-aware: `byUser` holds an `IrcConnection |
SlackConnection | ImessageConnection` union and `startNetwork` branches on
  `network.provider`; IRC-only paths (E2E, away/MONITOR, raw, modes) guard on the
  provider. The Slack-scoped `wsHub` hooks (react, mark-read) now cover both
  non-IRC providers.
- `IrcConnection` now explicitly `implements Connection` and gained a
  `selfName()` helper; shared event/state types are exported.
- New dependencies: `@slack/web-api`, `@slack/socket-mode`, `socket.io-client`.

### Notes & limitations

- Slack uses **socket mode**, so the app-level token (`xapp-…`) stays a shared
  server secret; OAuth only automates the per-workspace bot token. A
  multi-tenant deployment would move to the Events API (out of scope).
- Global search needs a **user token** (`xoxp`, `search:read`); a bot token
  returns `not_allowed_token_type` and search falls back to the local mirror.
- Search hits carry a synthetic id: "jump to result" opens the channel buffer
  but does not scroll to the exact message (a hit may live outside the mirrored
  window).
- Block Kit rendering is a text/markup fallback, not full visual block layout.
- iMessage requires a reachable **BlueBubbles** server on a Mac; full send +
  tapback support needs its Private API enabled. Lurker connects over HTTP+WS, so
  the Mac must be reachable from wherever the Lurker server runs.

### Tests

- Server + client test suite green: **1504 tests**.
- New coverage includes `slackConnection.test.ts` (connect, history, live,
  send, threads, reactions, click-to-react, edits/deletes, presence, page-up,
  mentions, bot names, markup, mark-read, Block Kit, mpim naming, join, search,
  custom emoji), `imessageConnection.test.ts` (connect, history, tapbacks,
  attachments, live, send, react, mark-read, demo), `slackOauth` service + route
  tests, the `slackEmoji` store, and `networks` store/pane tests.
