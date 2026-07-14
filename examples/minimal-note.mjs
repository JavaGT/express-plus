// Minimal workbench app — declare an entity, open a server, CRUD over HTTP.
//
// From the repo root:
//   node examples/minimal-note.mjs
//
// Then (another terminal):
//   curl -s http://127.0.0.1:3456/notes
//   curl -s -X POST http://127.0.0.1:3456/notes \
//     -H 'content-type: application/json' \
//     -d '{"title":"hello"}'
//
// Stop with Ctrl-C. Uses PORT env or 3456. DB file: examples/minimal-note.db

import workbench, { entity, text, owner } from 'workbench';

const Note = entity('Note', {
  title: text({ required: true }),
  owner: owner(),
  grant: owner.only,
});

const port = Number(process.env.PORT) || 3456;

// Fixed demo principal so curl works without login. Production apps use
// .auth() + session cookies (see projects/chat/server.mjs).
const demo = { type: 'user', id: 'demo' };

const app = workbench({ db: new URL('./minimal-note.db', import.meta.url).pathname });

app.mount('/notes', Note).listen(port, {
  principalOf: () => demo,
  onListening: () => {
    console.log(`minimal-note listening on http://127.0.0.1:${port}`);
    console.log(`  GET  /notes`);
    console.log(`  POST /notes  {"title":"..."}`);
    console.log(`  GET  /health`);
  },
});

await app.ready;
