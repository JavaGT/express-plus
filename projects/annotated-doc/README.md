# annotated-doc

The floor demo for Workbench **`annotatedText()`** — collaborative CRDT text
with recipient-projected delivery, without Scope Studio chrome.

This is deliberately smaller than chat/gdoc: one document field, a fixed demo
principal, and browser **insert/delete** only.

## Run

```sh
cd /path/to/workbench
PORT=3460 node projects/annotated-doc/server.mjs
```

- Local: <http://127.0.0.1:3460>
- Public (nginx): <https://test.javagrant.ac.nz>

nginx vhost (from workbench root):

```sh
cp projects/annotated-doc/nginx-test.javagrant.ac.nz.conf \
  /opt/homebrew/etc/nginx/servers/test.javagrant.ac.nz.conf
nginx -t && nginx -s reload
```

The public URL is a reverse proxy to `127.0.0.1:3460` — the Node process must be
running or nginx returns 502.

1. Click **New document**
2. Type in the editor
3. Reload — text persists
4. Open a second tab on the same document — edits converge over live delivery

DB file defaults to `projects/annotated-doc/annotated-doc.db` (override with
`ANNOTATED_DOC_DB`).

## What this shows

| Piece | Role |
| --- | --- |
| `Doc.body: annotatedText(...)` | Decision-0010 document field (blocks + CRDT bodies) |
| Stub `note` annotation + `words` measurement | Satisfies declaration grammar; unused in UI |
| Fixed principal `demo` | No auth ceremony while refining the field |
| `POST /docs` → `annotatedTextCreateAction` | Create through the package action only |
| `createAnnotatedTextHttpSession` | Typed insert/delete; no raw CRDT ops |
| `/live-delivery` | Recipient snapshot + ingest recovery |

## Non-goals (v1)

- Annotation apply/detach UI
- Block split / merge / continue controls
- Carets / multi-user presence
- Login, sharing, or multi-principal grants
- Scope entities, coding, speakers, or Studio
- `text.crdt()` (see `projects/note.mjs` / `projects/gdoc.mjs` for that floor)

## Client handle

`GET /client-handle.mjs` serializes the compiled `Doc.body` handle. The browser
does not maintain a second declaration or manually mirror annotation and
measurement families.

## Mutation path

```text
contenteditable beforeinput
  → bindAnnotatedTextEditor
  → createAnnotatedTextHttpSession.replace
  → POST /workbench/actions (package)
  → committed log + projection
  → live delivery recipient snapshot
  → session.subscribe re-render
```

There is no second write path and no hand-rolled CRDT reduce in the demo page.
