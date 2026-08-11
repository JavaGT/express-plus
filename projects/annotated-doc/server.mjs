// annotated-doc — the floor demo for Workbench annotatedText().
//
// One document field, fixed demo principal, browser editing, and a generic
// comment marker. No comment thread/entity, split/merge chrome, auth, or
// Scope domain nouns.
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
  annotatedTextRetireAction,
  annotationEntityAction,
  annotation,
  boolean,
  entity,
  ephemeral,
  everyone,
  grant,
  protectingAnnotation,
  read,
  readAnnotatedTextForRecipient,
  ref,
  scope,
  subscribe,
  text,
  write,
} from 'workbench';

const DEMO_USER = 'demo';
const DEMO_PROJECT = 'p1';
const PORT = Number(process.env.PORT) || 3460;
const DB_PATH = process.env.ANNOTATED_DOC_DB
  || new URL('./annotated-doc.db', import.meta.url).pathname;
const INDEX_HTML = new URL('./public/index.html', import.meta.url);
const COMMENT_COLORS = Object.freeze(['#fef08a', '#fecaca', '#bfdbfe', '#bbf7d0', '#e9d5ff']);

export const Project = entity('Project', {
  owner: ref('User', { role: 'owner' }),
  grant: [scope(() => everyone()).can(() => grant(read, write, subscribe, admin))],
});

// Comment is deliberately only reachable through the document's declared
// annotation projection. It is not a Project collection/list.
export const Comment = entity('Comment', {
  project: ref('Project', { immutable: true }),
  author: ref('User'),
  body: text(),
  resolved: boolean({ default: false }),
  grant: [scope(() => everyone()).can(() => grant(write))],
});

export const Doc = entity('Doc', {
  project: ref('Project'),
  owner: ref('User', { role: 'owner' }),
  // Ephemeral recipient-projected caret presence. The annotatedText field
  // declares the `caret` cell of this side-table; it never persists and never
  // becomes placeholder text. Restricted recipients receive only an opaque
  // edge, never an offset.
  presence: ephemeral({ caret: true }),
  body: annotatedText({
    project: 'project',
    owner: 'owner',
    carets: { field: 'presence', cell: 'caret' },
    annotations: [
       annotation('comment', {
         empty: 'orphan',
         fields: {
           color: text({ oneOf: COMMENT_COLORS, default: COMMENT_COLORS[0] }),
           comment: ref('Comment'),
         },
         actions: { compose: annotationEntityAction({
           relation: 'comment',
           project: 'project',
           author: 'author',
           capability: write,
           input: { body: 'body' },
         }) },
       }),
      // `sensitive` is the protected target that a confidential span covers. It
      // is projection-internal: it never renders as a comment card, so marking
      // confidential does not surface a user-visible comment.
      annotation('sensitive', { empty: 'delete' }),
      protectingAnnotation('confidential', {
        protects: 'sensitive',
        placeholder: '[restricted]',
        access: async ({ is }) => (await is.owner()) ? grant(read) : grant(),
      }),
    ],
  }),
  grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});
const DocClient = annotatedTextClientHandle(Doc, Doc.body);

const demoPrincipal = Object.freeze({ type: 'user', id: DEMO_USER, attributes: {} });
const readerPrincipal = Object.freeze({ type: 'user', id: 'reader', attributes: {} });

/** The demo has a fixed owner (demo) and a fixed reader (reader). The reader is
 * denied the `confidential` protecting annotation, so the same document shows
 * the real text for demo and the redacted placeholder for reader.
 *
 * The view-as is per-request (each browser tab carries its own `viewAs` in its
 * live-delivery query string / action document), NOT a shared cookie — two tabs
 * in one browser can be owner and reader independently. */
function principalOfFromRequest(req, { viewAs } = {}) {
  const url = new URL(req.url, 'http://localhost');
  const queryViewAs = url.searchParams.get('viewAs');
  const resolved = viewAs ?? queryViewAs;
  return resolved === 'reader' ? readerPrincipal : demoPrincipal;
}

function seed(app) {
  app.db.prepare(
    `INSERT OR IGNORE INTO User (id, username) VALUES (?, ?)`,
  ).run(DEMO_USER, DEMO_USER);
  app.db.prepare(
    `INSERT OR IGNORE INTO User (id, username) VALUES (?, ?)`,
  ).run('reader', 'reader');
  app.db.prepare(
    `INSERT OR IGNORE INTO Project (id, owner) VALUES (?, ?)`,
  ).run(DEMO_PROJECT, DEMO_USER);
}

function migrateCommentColors(db) {
  // Existing demo comments predate the required color field.
  const columns = db.prepare('PRAGMA table_info(Doc_body_annotation_comment)').all();
  if (!columns.some((column) => column.name === 'color')) {
    db.exec(`ALTER TABLE Doc_body_annotation_comment ADD COLUMN color TEXT NOT NULL DEFAULT '${COMMENT_COLORS[0]}'`);
  }
  db.prepare(
    `INSERT OR IGNORE INTO Doc_body_annotation_comment (annotation_id, color)
     SELECT id, ? FROM Doc_body_annotation WHERE family = 'comment'`,
  ).run(COMMENT_COLORS[0]);
}

// The demo declaration grew a `confidential` protecting annotation family. The
// annotation table's CHECK constraint is baked in at first DDL; rebuild it so
// the family column accepts both 'comment' and 'confidential', preserving rows.
function migrateAnnotationFamilies(db) {
  const existing = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'Doc_body_annotation'`).get();
  if (!existing || existing.sql.includes("'confidential'")) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE Doc_body_annotation_new (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      family TEXT NOT NULL CHECK (family IN ('comment', 'confidential')),
      FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES Project(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES User(id) ON DELETE CASCADE
    );
    INSERT INTO Doc_body_annotation_new (id, document_id, project_id, owner_id, family)
      SELECT id, document_id, project_id, owner_id, family FROM Doc_body_annotation;
    DROP TABLE Doc_body_annotation;
    ALTER TABLE Doc_body_annotation_new RENAME TO Doc_body_annotation;
    PRAGMA foreign_keys = ON;
  `);
}

// v3: the declaration added the `sensitive` protected-target family. Rebuild the
// annotation CHECK again when it predates `sensitive` (idempotent).
function migrateSensitiveFamily(db) {
  const existing = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'Doc_body_annotation'`).get();
  if (!existing || existing.sql.includes("'sensitive'")) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE Doc_body_annotation_new (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      family TEXT NOT NULL CHECK (family IN ('comment', 'sensitive', 'confidential')),
      FOREIGN KEY (document_id) REFERENCES Doc(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES Project(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES User(id) ON DELETE CASCADE
    );
    INSERT INTO Doc_body_annotation_new (id, document_id, project_id, owner_id, family)
      SELECT id, document_id, project_id, owner_id, family FROM Doc_body_annotation;
    DROP TABLE Doc_body_annotation;
    ALTER TABLE Doc_body_annotation_new RENAME TO Doc_body_annotation;
    PRAGMA foreign_keys = ON;
  `);
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
  const app = workbench({
    db,
     entities: [Project, Comment, Doc],
    migrations: [
      { version: 1, up: migrateCommentColors },
      { version: 2, up: migrateAnnotationFamilies },
      { version: 3, up: migrateSensitiveFamily },
    ],
  });
  const principalOf = principalOfFromRequest;
  const publicDir = new URL('./public', import.meta.url).pathname;

  app.attachLiveDelivery({ principalOf });

  app.use('/client-handle.mjs', (req, res, next) => {
    if (req.method !== 'GET') return next();
    // Preserve the typed compose handle across this zero-import browser
    // boundary rather than exposing a raw action name or payload path.
    const clientHandle = {
      ...DocClient,
      body: {
        ...DocClient.body,
        annotations: {
          ...DocClient.body.annotations,
          comment: {
            ...DocClient.body.annotations.comment,
            actions: {
              compose: DocClient.body.annotations.comment.actions.compose,
            },
          },
        },
      },
    };
    const handle = `export const DocClient = Object.freeze(${JSON.stringify(clientHandle)});\n`;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(handle) });
    res.end(handle);
  });

  // Thin read/create helpers so the page does not invent a second mutation
  // pipeline. Create still dispatches Doc.create through the package action.
  // Handlers use the Express-style facade (res.json / res.status); return values
  // are ignored — ending the response marks the intercept handled.
  app.use('/docs', async (req, res) => {
    const tail = useTail(req);
    if (tail !== '' && req.method === 'GET') {
      const id = decodeURIComponent(tail);
      const principal = principalOf(req);
      const document = app.db.prepare('SELECT id, project FROM Doc WHERE id = ?').get(id);
      if (!document || !principal?.id) {
        res.status(404).json({ error: 'document not found' });
        return;
      }
      // Comment bodies are a related projection of the recipient-authorized
      // document, never a raw document-id join. Unavailable/retry is opaque.
      let recipient;
      try {
        recipient = await readAnnotatedTextForRecipient({
          app,
          entity: Doc,
          field: Doc.body,
          documentId: id,
          expectedOwningScope: { entity: Project, id: document.project },
          principal,
        });
      } catch {
        res.status(404).json({ error: 'document not found' });
        return;
      }
      if (recipient.kind !== 'snapshot') {
        res.status(404).json({ error: 'document not found' });
        return;
      }
      const threads = [];
      const seenPairs = new Set();
      for (const annotation of recipient.document.annotations) {
        if (annotation.family !== 'comment') continue;
        const commentId = annotation.fields?.comment;
        if (typeof commentId !== 'string') continue;
        const pair = `${annotation.id}\u0000${commentId}`;
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        const thread = app.db.prepare(
          `SELECT annotation.id AS annotationId, comment.id, comment.author, comment.body, comment.resolved
           FROM Doc_body_annotation AS annotation
           JOIN Doc_body_annotation_comment AS annotationComment ON annotationComment.annotation_id = annotation.id
           JOIN Comment AS comment ON comment.id = annotationComment.comment
           WHERE annotation.id = ? AND annotation.document_id = ? AND annotation.family = 'comment'
             AND annotationComment.comment = ?`,
        ).get(annotation.id, id, commentId);
        if (thread) threads.push(thread);
      }
      res.status(200).json({ threads });
      return;
    }
    if (tail !== '' && req.method !== 'DELETE') return;
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
      return;
    }
    if (req.method === 'DELETE') {
      if (tail === '') {
        res.status(400).json({ error: 'missing document id' });
        return;
      }
      const id = decodeURIComponent(tail);
      const action = annotatedTextRetireAction(Doc, id);
      const result = await app.dispatch({
        actionId: `retire-${id}`,
        principal: principalOf(req),
        clientId: 'demo-tab',
        ...action,
      });
      if (!result.ok) {
        res.status(result.failure?.category === 'denied' ? 403 : 400)
          .json({ ok: false, failure: result.failure ?? null });
        return;
      }
      res.status(200).json({ ok: true, id });
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

  return { app, principalOf, Doc, Project, Comment };
}

// Only auto-start when run directly (projects-smoke + demos).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { app, principalOf } = createAnnotatedDocApp();
  app.listen(PORT, { principalOf });
  await app.ready;
  seed(app);
  console.log(`annotated-doc listening on http://127.0.0.1:${PORT}`);
  console.log('  fixed principal: demo');
  console.log('  GET/POST /docs, DELETE /docs/:id');
  console.log('  package actions + /live-delivery for body edits');
}
