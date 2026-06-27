// hello.mjs — THE FLOOR. A working collaborative-doc app: 3 entity lines + 2 app lines.
//
// `owner` is an explicit FK to User with `role: 'owner'`. Because no `checks`
// or `grant` is declared, the framework default applies: owner ⇒ all, else
// hide() (the zero-to-one default keys off the owner FK). The route gate
// (requireAuth) is default-on, so the floor is AUTHED by construction — the
// smoothest path is the safe path.
//
// Omit `routes` → auto-CRUD (list/get/create/update/destroy) THROUGH grant.
// Omit everything but fields → live WS subscription on the entity's fields
// is baked in (presence/chat absent here; the body field's CRDT events and the
// auto-CRUD still flow over the baked-in /events stream).
import expressPlus, { entity, text, ref } from 'express-plus';

const Note = entity('Note', {
  fields: {
    body:  text.crdt(),
    owner: ref('User', { role: 'owner', readonly: true }),   // FK to User; default = req.user.id
  },
});

expressPlus().mount('/notes', Note).listen(3000);
