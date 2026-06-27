// routes/docs.mjs — the file-list page + product-specific overrides.
//
// The framework already auto-generated /docs CRUD + history from app.doc('Doc').
// This router only adds the product view: /docs/home renders the HTML page, and
// GET /docs/feed returns the JSON the client library boots from (owned + shared).
import expressPlus from 'express-plus';

const router = expressPlus.Router();

// JSON: every doc I own or that is shared with me. The framework's default list
// handler filters by the acl.read predicate, but we union owned + shared
// explicitly so the page gets both buckets tagged for separate rendering.
router.get('/feed', async (req, res, next) => {
  const [owned, shared] = await Promise.all([
    app.db.docs.where({ ownerId: req.user.id }).sort('updatedAt', 'desc').exec(),
    app.db.shares.where({ userId: req.user.id }).populate('docId').exec(),
  ]);
  res.json({
    owned: owned.map(strip),
    shared: shared.map((s) => ({ ...strip(s.doc), sharedBy: s.sharedBy, sharedAt: s.createdAt })),
  });
});

// HTML page: the file list. The client lib (public/files.mjs) takes over.
router.get('/home', (req, res) => {
  res.render('files.html'); // served by the view engine; falls back to public/files.html
});

// Auto-increment updatedAt on any save. Hooks already cover the body, but we
// also want the list page to bump a doc to the top when shared/renamed.
router.use('/:docId', async (req, res, next) => {
  if (req.doc) req.doc.updatedAt = new Date();
  next();
});

function strip(doc) {
  return { id: doc.id, title: doc.title, updatedAt: doc.updatedAt, createdAt: doc.createdAt };
}

export default router;
