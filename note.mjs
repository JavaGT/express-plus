// note.mjs — THE FLOOR. A working collaborative-doc app in three lines.
//
// `owner` is an explicit FK to User with `role: 'owner'`; the framework
// auto-derives both the zero-to-one default grant (owner ⇒ all, else hide) and
// `checks.owner` (so `note.isOwner(user)` exists) — one source of truth. The
// route gate (requireAuth) is default-on, so the floor is AUTHED by
// construction: the smoothest path is the safe path. Omit `routes` and
// `grant` → auto-CRUD through grant + live subscription on the body field's
// CRDT events over the baked-in WS /events stream.
import expressPlus, { entity, text, ref } from 'express-plus';

export const Note = entity('Note', {
  fields: { body: text.crdt(), owner: ref('User', { role: 'owner', readonly: true }) },
});

expressPlus().mount('/notes', Note).listen(3000);