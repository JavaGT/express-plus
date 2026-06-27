// hello.mjs — THE FLOOR. A working collaborative-doc app: 3 domain lines + 2 app lines.
//
// `owner()` is one token. It marks the ownership relation AND, because no
// `predicates.owner`/`grant` is declared, auto-derives:
//   - predicates.owner  = (doc, user) => doc.ownerId === user.id  (per-module)
//   - grant             = owner ⇒ all, else hide()                (invariant 8)
// Module-level `require` defaults to requireAuth (fail-closed), so the floor is
// AUTHED by construction — the smoothest path is the safe path.
//
// Omit `rooms`  → one default collaborative room at /notes/:id (presence + chat).
// Omit `routes` → auto-CRUD (list/get/create/update/destroy) THROUGH grant/access.
import expressPlus, { module, crdt, owner } from 'express-plus';

const Note = module('Note', { schema: { body: crdt.text(), owner: owner() } });

expressPlus().mount(Note).listen(3000);
