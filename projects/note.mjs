// note.mjs — THE FLOOR. Three fields, one grant, under 10 lines of declaration.
// `owner.only` is the transparent expansion of the most common grant pattern:
// the owner gets [read, write, subscribe, admin], everyone else gets nothing.
import workbench, { entity, text, owner } from 'workbench';

export const Note = entity('Note', {
  body: text.crdt(), owner: owner(),
  grant: owner.only,
});

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  workbench({ db: 'note.db' }).mount('/notes', Note).listen();
}