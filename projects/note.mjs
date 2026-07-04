// note.mjs — THE FLOOR. A working collaborative-doc app: declare the entity,
// declare the grant. Two things, not "three magic lines".
//
// `owner` is an explicit FK to User with `role: 'owner'`; the framework
// auto-derives `checks.owner` from it (so `is.owner()` exists) — one source of
// truth for "who owns this row". That is the ONLY thing the FK derives: there
// is no zero-to-one default grant. An entity with no `grant` is a LOAD-TIME
// ERROR (DECISIONLOG ADR #7), so the floor below declares one explicitly. There
// is no `hide()` / visibility axis either (ADR #1): a denied read simply removes
// the row from the result set.
//
// The route gate (requireAuth) is default-on, so the floor is AUTHED by
// construction: the smoothest path is the safe path. With `routes` omitted the
// framework auto-CRUDs through the grant and live-subscribes the body field's
// CRDT events over the baked-in WS /events stream.
import workbench, { entity, text, ref, grant, deny, read, write, subscribe, scope } from 'workbench';

export const Note = entity('Note', {
  body: text.crdt(), owner: ref('User', { role: 'owner', readonly: true }),
  grant: () => [
    scope(({ is }) => is.owner())
      .can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe) : deny('not the owner')),
  ],
});

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  workbench({ db: 'note.db' }).mount('/notes', Note).listen();
}