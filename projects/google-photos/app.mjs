// projects/google-photos/app.mjs — thin global wiring for the photo library.
//
// Express-style: app mounts entities at path prefixes, wires cross-cutting
// routes (sessions), and starts listening. All sensible defaults (security,
// body, sessions, req.user hydration, rate limit, cors, logs, views, static,
// error handling, graceful shutdown) are baked into express-plus.
//
// BACKGROUND JOBS: thumbnail generation, face clustering, and OCR indexing are
// NOT wired here — there is no `queue` or `pipeline` or `afterCreate` hook
// construct in the framework. They must be handled by an external job runner
// (bull, pg-boss, etc.) that either (a) polls for unprocessed rows, or (b)
// receives events from an app-level `hooks.afterSave` if the framework exposed
// one on entities. Neither path is native express-plus. Documented in
// PAIN-POINTS.md.
import expressPlus from 'express-plus';
import { MediaItem, Album, FaceCluster } from './index.mjs';

const app = expressPlus();

// === CROSS-CUTTING ROUTES ===
// login/logout/user views — the framework provides User and Session entities
// with auth default-on, so these follow the pattern from domain-modules.
// (Route files are aspirational imports — not created on disk.)
import { sessionRoutes, userRoutes } from './routes/sessions.mjs';
import { userList } from './routes/handlers.mjs';

app.get('/', userList);
app.use('/sessions', sessionRoutes());
app.use('/users', userRoutes());

// === PRODUCT ENTITIES ===
// `mount()` wires: auto-CRUD + custom routes + auth (grant/access/checks) +
// live WS field subscriptions at the entity prefix. The baked-in /events
// WS stream pushes field mutations (`:changed`, `:added:<id>`, `:removed:<id>`)
// to authorized subscribers, re-authorized per push through the same auth
// engine.
app.mount('/media', MediaItem);
app.mount('/albums', Album);
app.mount('/faces', FaceCluster);

// === SEARCH ENDPOINT (PAIN POINT: limited to typed-handle equality predicates) ===
// The framework's query language is typed-field-handle predicates. These
// support `.is(val)` (equality) and `.has(id)` (set membership). There is NO:
//   - full-text search predicate (.match('paris'), .contains('dog'))
//   - date range predicate (.gte(), .lte(), .between())
//   - geo-radius predicate
//   - combined predicate builder (AND/OR across field handles)
//
// The search handler below demonstrates what IS possible — equality filter on
// owner + album + sort by capture time. For rich search, you'd drop to raw
// SQL or an external search index (Elasticsearch / Postgres full-text) —
// breaking the typed-handle model entirely.
import { router } from 'express-plus';

function searchRoutes() {
  const r = router();

  r.get('/', async (req, res) => {
    const me = req.user.id;
    const { albumId } = req.query;

    // What we CAN do: filter by album + owner, sort by capture time.
    // What we CANNOT do with typed handles (would need raw SQL):
    //   - "photos from Paris 2023 with a dog" (fulltext over description + ocrText)
    //   - "photos taken in December" (date range .gte / .lte on capturedAt)
    //   - "photos near lat,lng" (geo-radius filter)
    let query = MediaItem.findAll(MediaItem.owner.is(me));
    if (albumId) {
      query = MediaItem.findAll(MediaItem.album.is(albumId));
    }
    const results = await query
      .sort(MediaItem.capturedAt, 'desc')
      .limit(50);

    res.json({ results });
  });

  return r;
}

app.use('/search', searchRoutes());

// === LISTEN ===
const port = process.env.PORT ?? 3000;
app.listen(port, () =>
  console.log(`google-photos on http://localhost:${port}`));
