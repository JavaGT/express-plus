// hello.mjs — THE FLOOR. A working collaborative-doc app: 3 entity lines + 2 app lines.
//
// `owner` is an explicit FK to User with `role: owner` (a typed handle). Two
// things fall out of it automatically — the zero-to-one default grant (owner ⇒
// all, else hide) AND an auto-derived `checks.owner` (so `note.isOwner(user)`
// exists even though no `checks` block is declared). The owner default
// (`req.user.id`) is framework-derived from `role: owner` — not hand-written.
// The route gate (requireAuth) is default-on, so the floor is AUTHED by
// construction — the smoothest path is the safe path.
//
// Omit `routes` → auto-CRUD (list/get/create/update/destroy) THROUGH grant.
// Omit everything but fields → live WS subscription on the entity's fields
// is baked in (presence/chat absent here; the body field's CRDT events and the
// auto-CRUD still flow over the baked-in /events stream).
//
// Standalone demo — spins its own app instance on its own port, not linked to
// app.mjs.
import expressPlus, { entity, text, ref, owner } from 'express-plus';

const Note = entity('Note', {
  fields: {
    body:  text.crdt(),
    owner: ref('User', { role: owner, readonly: true }),   // FK to User; default + checks.owner auto-derived
  },
});

expressPlus().mount('/notes', Note).listen(3000);
