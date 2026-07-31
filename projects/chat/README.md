# workbench chat

A WhatsApp-style chat built on the `workbench` framework — the demo that sells
it. Two entities (`Chat` + `Message`) and six lines of wiring; two browser tabs
see each other's messages without a refresh.

## Run

```sh
node projects/chat/server.mjs
```

Open <http://localhost:3000> in **two browser tabs**. Create an account, sign in
to that account in the other tab, create a chat, send a message, and
watch it appear in the other tab.

## What this shows

- `workbench({ db: 'chat.db' })` — a string db is opened by the framework,
  schema auto-created.
- `.auth()` — `/auth/register`, `/auth/login`, and `/auth/logout` set or clear a fail-closed `sid` cookie.
- `Chat` — owner + `members` map; the `member` check compiles into the read
  scope (a correlated `EXISTS` over the membership side-table).
- `Message` — `grant: inherit(Chat, { via: 'chat' })` inherits the parent's
  read scope AND `.can` over the typed FK, so a chat member reads its messages.
- `GET /workbench.mjs` — the framework serves its browser SDK by default (the
  server owns both ends of its live `/events` protocol); the page imports it
  with no build step.

## SDK gap

The browser SDK (`/workbench.mjs`) has no live-collection / live-query
primitive — a store subscribes to **one** `(entity, id)` row. The message list
is a separate entity whose ids are unknown ahead of time, so it can't be
subscribed to as a set. The page polls `GET /chats/:chatId/messages` every
~1.5s as a fallback. The `Chat` row itself (title, members) syncs live over
the `/events` WebSocket.
