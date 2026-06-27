// domains/doc/routes/handlers.mjs — product-specific Doc views.
//
// The domain already auto-generated /docs CRUD + history + CRDT room via
// r.resource(). These are the product overrides: the JSON feed the client lib
// boots from, and the HTML file-list page. Bodies are unchanged from the
// baseline routes/docs.mjs — only their HOME moved into the domain.
import { app } from 'express-plus';

// JSON: every doc I own or that is shared with me, tagged for separate render.
export async function feed(req, res, next) {
  const [owned, shared] = await Promise.all([
    app.db.docs.where({ ownerId: req.user.id }).sort('updatedAt', 'desc').exec(),
    app.db.shares.where({ userId: req.user.id }).populate('docId').exec(),
  ]);
  res.json({
    owned: owned.map(strip),
    shared: shared.map((s) => ({ ...strip(s.doc), sharedBy: s.sharedBy, sharedAt: s.createdAt })),
  });
}

// HTML page: the file list. The client lib (public/files.mjs) takes over.
export function home(req, res) {
  res.render('files.html'); // served by the view engine; falls back to public/files.html
}

// Auto-increment updatedAt on any save so the list page bumps a doc to the top
// when it is shared/renamed.
export async function bumpUpdatedAt(req, res, next) {
  if (req.doc) req.doc.updatedAt = new Date();
  next();
}

function strip(doc) {
  return { id: doc.id, title: doc.title, updatedAt: doc.updatedAt, createdAt: doc.createdAt };
}
