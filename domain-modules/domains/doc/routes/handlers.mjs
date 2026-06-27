// domains/doc/routes/handlers.mjs — product-specific Doc views.
//
// The entity already auto-generated /docs CRUD + history + live subscription
// via r.resource(). These are the product overrides: the JSON feed the client
// lib boots from, and the HTML file-list page.
//
// Handlers that need the entity class receive it as a factory arg (no circular
// import). `feed(Doc)` returns the route handler; queries use typed field
// handles (Document.owner, Document.shares.has(me), Document.updatedAt) — no
// magic strings for field references. Queries are thenable (no .exec()).
// FKs auto-populate; `updatedAt` is `touch:true` so it bumps itself (no
// bumpUpdatedAt middleware needed).
export function feed(Document) {
  return async (req, res) => {
    const me = req.user.id;
    const [owned, shared] = await Promise.all([
      Document.findAll({ owner: me }).sort(Document.updatedAt, 'desc').limit(10),
      Document.findAll(Document.shares.has(me)).sort(Document.updatedAt, 'desc').limit(10),
    ]);
    res.json({ owned: owned.map(strip), shared: shared.map(strip) });
  };
}

// HTML page: the file list. The client lib (public/files.mjs) takes over and
// subscribes to the baked-in WS /events stream for live updates.
export function home(req, res) {
  res.render('files.html'); // served by the view engine; falls back to public/files.html
}

function strip(doc) {
  return { id: doc.id, title: doc.title, updatedAt: doc.updatedAt, createdAt: doc.createdAt };
}
