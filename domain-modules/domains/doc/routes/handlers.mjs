// domains/doc/routes/handlers.mjs — product-specific Doc views.
//
// The entity already auto-generated /docs CRUD + /:id/chat + /:id/presence +
// live subscription via r.resource(). These are the product overrides: the JSON
// feed the client lib boots from, and the HTML file-list page.
//
// Handlers that need the entity class receive it as a factory arg (no circular
// import). Queries use typed field handles throughout — `Document.owner`,
// `Document.shares.has(me)`, `Document.updatedAt` — never magic field-ref
// strings. Queries are thenable builders (no .exec()). `getOrFail` is the
// baked-in 404 (defaults rule: "sensible defaults baked into the framework").
// FKs auto-populate; `updatedAt` is `touch:true` so it bumps itself.
export function feed(Document) {
  return async (req, res) => {
    const me = req.user.id;
    // One query predicate form, used consistently: typed field handles.
    const [owned, shared] = await Promise.all([
      Document.findAll(Document.owner.is(me)).sort(Document.updatedAt, 'desc').limit(10),
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
