# Browser Batch Action Transport

`POST /workbench/actions/batch` is the browser transport for a composed set of
registered public actions. Its package-owned envelope is:

```json
{ "actionId": "package-generated", "scope": "owning-scope", "clientId": "session", "actions": [{ "type": "declared.action", "payload": {} }] }
```

- The client generates one action ID, deep-clones and freezes the envelope, and
  retains it after an indeterminate transport failure.
- `retry(opId)` is explicit and resends that exact retained envelope. There is
  no automatic retry and no new-ID retry path.
- A successful receipt is `{ ok, actionId, confirmedThrough }`. Snapshot-only
  sessions retain their optimistic placeholder until an authorized snapshot
  covers that fence.
- Server identity is `(scope, actionId)`. A retry with identical actions returns
  the original receipt/events; different actions under that identity conflict.
- The route accepts declared public actions only. It does not accept raw log
  events, operation state, cursors, generated entity mutations, or caller IDs.
- Empty browser batches are invalid. Server-side `app.batch([])` retains its
  existing no-op semantics.
