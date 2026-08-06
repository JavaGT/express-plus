# annotated-doc

The floor demo for Workbench **`annotatedText()`** — collaborative CRDT text
with recipient-projected delivery, without Scope Studio chrome.

One document field, a fixed demo principal, browser typing via
`createAnnotatedTextHttpSession` + `bindAnnotatedTextEditor`, and **comment**
markers with colors (apply/delete). Optional live JSON debug on the page.

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

1. Click **New document** (or pick one from the list)
2. Type in the editor — inserts/deletes go through the session binding
3. Select a range → **Add comment marker** (choose a color first)
4. Delete a marker from the Comments panel
5. Expand **Live JSON state** for the folded document snapshot (optional)
6. Reload — text and comments persist; a second tab converges over live delivery

DB file defaults to `projects/annotated-doc/annotated-doc.db` (override with
`ANNOTATED_DOC_DB`).

## What this shows

| Piece | Role |
| --- | --- |
| `Doc.body: annotatedText(...)` | Decision-0010 document field (blocks + CRDT bodies) |
| `annotation('comment', { empty: 'orphan', fields: { color: text({ oneOf: [...] }) } })` | Comment family; color required, one of five palette hexes |
| `protectingAnnotation('confidential', { protects: 'sensitive', ... })` | Confidential span: a protecting annotation over a range; the reader principal sees the real text replaced by the placeholder |
| Fixed principals `demo` (owner) + `reader` | The demo shows both sides of the per-recipient projection: owner sees real text, reader sees the redacted placeholder |
| `?view-as` / **View as** toggle | Switch between the owner and reader views of the same document |
| `GET/POST /docs` → list + `annotatedTextCreateAction` | Doc list/create through package create only |
| `createAnnotatedTextHttpSession` + `bindAnnotatedTextEditor` | Typed text + `applyAnnotation` / `removeAnnotation`; no raw CRDT ops |
| `/live-delivery` | Recipient snapshot fold + ingest recovery |
| Comments panel + color select | Marker apply/delete UI with highlight colors |
| Live JSON state (`<details>`) | Optional debug of the session document snapshot |

## Confidential spans

Select a range and click **Mark confidential**. This applies an invisible
`sensitive` target annotation, then a `confidential` protecting annotation over
the same range. The target is projection-internal — it never renders as a
comment card, so marking confidential does not create a user-visible comment.
Switch **View as** to `Reader` — the reader is denied the `confidential` access,
so the same document renders the placeholder (`[restricted]`) where the owner
sees the real text. The redaction is computed server-side in the recipient
projection; the reader's client never receives the hidden text. Ordinary
comments remain independent and deletable.

The **View as** choice is **per tab** (kept in `sessionStorage` and carried in
each tab's request identity), so you can open two tabs in one browser — one as
Owner, one as Reader — and edit from the owner tab while the reader tab stays
redacted. It is not a shared cookie; changing one tab does not flip the other.

Confidential content is styled so the boundary is visible in both views: the
owner sees the real text on a black background with white text, and the reader
sees the `[restricted]` placeholder (square brackets kept) on the same black
background — signalling that the placeholder is a redaction, not the content.

## Non-goals (v1)

- Comment thread/entity (markers only — no reply body)
- Block split / merge / continue controls
- Carets / multi-user presence
- Login, sharing, or multi-principal grants (the demo uses two fixed principals)
- Scope entities, coding, speakers, or Studio
- `text.crdt()` (see `projects/note.mjs` / `projects/gdoc.mjs` for that floor)

## Client handle

`GET /client-handle.mjs` serializes the compiled `Doc.body` handle. The browser
does not maintain a second declaration or manually mirror annotation families.

## Mutation path

```text
contenteditable beforeinput
  → bindAnnotatedTextEditor
  → createAnnotatedTextHttpSession (replace / applyAnnotation / removeAnnotation)
  → package actions (one write path)
  → committed log + projection
  → live-delivery recipient snapshot fold
  → session.subscribe re-render
```

Doc create uses `POST /docs` → `annotatedTextCreateAction` on the same package
dispatch surface. There is no second write path and no hand-rolled CRDT reduce
in the demo page.
