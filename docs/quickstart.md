# Quickstart

Get a workbench app running in minutes. No npm install of runtime dependencies —
Node’s built-ins only.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 22+** (26 recommended) | Uses `node:http`, `node:sqlite`, `node:crypto`, `node:fs` |
| This repository | Clone or open the workbench monorepo; the package name is `workbench` |

From the **repository root**, Node resolves `import … from 'workbench'` to
`build/index.mjs` via `package.json` `exports`.

```sh
cd /path/to/workbench
node --test    # optional: confirm the suite is green
```

## Option A — Minimal Note API (curl)

A self-contained file: **`examples/minimal-note.mjs`**.

```sh
node examples/minimal-note.mjs
```

You should see:

```text
minimal-note listening on http://127.0.0.1:3456
```

In another terminal:

```sh
# empty list (or existing notes)
curl -s http://127.0.0.1:3456/notes

# create
curl -s -X POST http://127.0.0.1:3456/notes \
  -H 'content-type: application/json' \
  -d '{"title":"hello"}'

# health
curl -s http://127.0.0.1:3456/health
```

Override the port with `PORT=4000 node examples/minimal-note.mjs`.

What you just used:

1. **`entity('Note', { title: text(), owner: owner(), grant: owner.only })`** — four lines of declaration  
2. **`workbench({ db })`** — open SQLite; schema is prepared on `app.ready`  
3. **`.mount('/notes', Note).listen(port)`** — REST CRUD + framework defaults  

For a process that does not need HTTP, replace `.listen(port)` with
`await app.start()`. It starts the same schema, mutation, recovery, maintenance,
and clock runtime while leaving `app.httpServer` absent.

Authorization is real: the demo forces a fixed principal so curl is easy. Real
apps call `.auth()` and use session cookies (Option B).

Stop the server with **Ctrl-C**.

## Option B — Chat sample (two browser tabs)

The floor demo from the product design:

```sh
node projects/chat/server.mjs
```

Open **http://localhost:3000** in two tabs:

1. Create an account, then sign in to it in the other tab
2. Create a chat in one tab  
3. Send a message — it appears live in the other tab  

Details: [`projects/chat/README.md`](../projects/chat/README.md).

What this shows beyond Option A:

- `.auth()` — registration/login/logout, `sid` cookie
- Parent/child entities (`Chat` / `Message` with `inherit`)  
- Map membership field + compiled membership check  
- Static UI + browser SDK at `/workbench.mjs`  
- Live WebSocket sync on `/events`  

## What to read next

| Doc | When |
| --- | --- |
| **[functionality.md](functionality.md)** | Full public API: fields, grants, live client, jobs, blobs, effects, schedule… |
| **[../CONTEXT.md](../CONTEXT.md)** | Domain nouns (Entity, Grant, Scope handle, Kernel…) |
| **[../AGENTS.md](../AGENTS.md)** | Binding design rules (one path, fail closed, known apps) |
| **[architecture-map.md](architecture-map.md)** | Where modules sit on compile / commit / deliver |

## Package entry points

| Import | Path |
| --- | --- |
| `workbench` | Server app API (`build/index.mjs`) |
| `workbench/client` | Browser SDK (`public/workbench-client.mjs`) — also served as `/workbench.mjs` when listening |
| `workbench/server` | Server-only helpers for sessions, jobs, blobs, and migrations |

## Tests

```sh
npm test                 # full suite
npm run test:coverage    # suite + Node experimental coverage report
```
