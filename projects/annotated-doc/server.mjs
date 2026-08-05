// annotated-doc — the floor demo for Workbench annotatedText().
//
// One document field, fixed demo principal, browser insert/delete only.
// No annotations UI, split/merge chrome, auth, or Scope domain nouns.
//
//   node projects/annotated-doc/server.mjs
//   open http://127.0.0.1:3460
//
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import workbench, {
  admin,
  annotatedText,
  annotatedTextClientHandle,
  annotatedTextCreateAction,
  entity,
  everyone,
  grant,
  read,
  ref,
  scope,
  subscribe,
  write,
} from 'workbench';

const DEMO_USER = 'demo';
const DEMO_PROJECT = 'p1';
const PORT = Number(process.env.PORT) || 3460;
const DB_PATH = process.env.ANNOTATED_DOC_DB
  || new URL('./annotated-doc.db', import.meta.url).pathname;
const INDEX_HTML = new URL('./public/index.html', import.meta.url);

export const Project = entity('Project', {
  owner: ref('User', { role: 'owner' }),
  grant: [scope(() => everyone()).can(() => grant(read, write, subscribe, admin))],
});

export const Doc = entity('Doc', {
  project: ref('Project'),
  owner: ref('User', { role: 'owner' }),
  body: annotatedText({ project: 'project', owner: 'owner' }),
  grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});
const DocClient = annotatedTextClientHandle(Doc, Doc.body);

const demoPrincipal = Object.freeze({ type: 'user', id: DEMO_USER });

function seed(app) {
  app.db.prepare(
    `INSERT OR IGNORE INTO User (id, username) VALUES (?, ?)`,
  ).run(DEMO_USER, DEMO_USER);
  app.db.prepare(
    `INSERT OR IGNORE INTO Project (id, owner) VALUES (?, ?)`,
  ).run(DEMO_PROJECT, DEMO_USER);
}

function listDocs(app) {
  return app.db.prepare(
    `SELECT id, project, owner FROM Doc ORDER BY id`,
  ).all();
}

function readJson(rawReq) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    rawReq.on('data', (chunk) => chunks.push(chunk));
    rawReq.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    rawReq.on('error', reject);
  });
}

/** Path tail under an app.use(prefix) intercept (empty string at the prefix itself). */
function useTail(req) {
  if (typeof req.params?.path === 'string') return req.params.path;
  return '';
}

export function createAnnotatedDocApp({ db = DB_PATH } = {}) {
  const app = workbench({ db, entities: [Project, Doc] });
  const principalOf = () => demoPrincipal;
  const publicDir = new URL('./public', import.meta.url).pathname;

  app.attachLiveDelivery({ principalOf });

  app.use('/client-handle.mjs', (req, res, next) => {
    if (req.method !== 'GET') return next();
    const handle = `export const DocClient = Object.freeze(${JSON.stringify(DocClient)});\n`;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(handle) });
    res.end(handle);
  });

  // Thin read/create helpers so the page does not invent a second mutation
  // pipeline. Create still dispatches Doc.create through the package action.
  // Handlers use the Express-style facade (res.json / res.status); return values
  // are ignored — ending the response marks the intercept handled.
  app.use('/docs', async (req, res) => {
    if (useTail(req) !== '') return;
    if (req.method === 'GET') {
      res.status(200).json({ docs: listDocs(app) });
      return;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req.raw);
      } catch {
        res.status(400).json({ error: 'invalid json' });
        return;
      }
      const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : randomUUID();
      const action = annotatedTextCreateAction(Doc, Doc.body, {
        id,
        projectId: DEMO_PROJECT,
        ownerId: DEMO_USER,
      });
      const result = await app.dispatch({
        actionId: `create-${id}`,
        principal: demoPrincipal,
        clientId: typeof body.clientId === 'string' ? body.clientId : 'demo-tab',
        ...action,
      });
      if (!result.ok) {
        res.status(400).json({ ok: false, failure: result.failure ?? null });
        return;
      }
      res.status(201).json({ ok: true, id });
    }
  });

  // serveStatic does not map bare `/` → index.html; do it explicitly.
  app.use('/', (req, res, next) => {
    const tail = useTail(req);
    if (req.method === 'GET' && (tail === '' || tail === 'index.html')) {
      const html = readFileSync(INDEX_HTML);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': html.byteLength,
      });
      res.end(html);
      return;
    }
    next();
  });

  app.static('/', publicDir);

  return { app, principalOf, Doc, Project };
}

// Only auto-start when run directly (projects-smoke + demos).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { app, principalOf } = createAnnotatedDocApp();
  app.listen(PORT, { principalOf });
  await app.ready;
  seed(app);
  console.log(`annotated-doc listening on http://127.0.0.1:${PORT}`);
  console.log('  fixed principal: demo');
  console.log('  GET/POST /docs');
  console.log('  package actions + /live-delivery for body edits');
}
