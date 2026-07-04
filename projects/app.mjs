// app.mjs — thin global wiring.
//
// Sensible defaults (security, body, sessions, req.principal hydration, rate
// limit, cors, logs, views, static, error handling, graceful shutdown, AND
// the baked-in WS /events subscription stream re-authorized per push) live in
// workbench — nothing to mount, nothing to hand-apply.
//
// Persisted product domains are entities (`app.mount('/docs', Doc)`); the
// child Comment entity is mounted as a sub-resource of Doc (grant inherits
// through the typed FK). Cross-cutting auth is plain routers (`app.use`).
import workbench from 'workbench';
import { Doc } from './doc.mjs';
import { sessionRoutes, userRoutes } from './session.mjs';

const app = workbench({ db: 'gdoc.db' });

app.mount('/sessions', sessionRoutes());    // auth boundary (login opts out, rest authed)
app.mount('/users',    userRoutes());        // user views (authed)
app.mount('/docs',   Doc);                 // Doc + /docs/:id/feed + /home + /:docId/shares + /:docId/comments
                                            // Comment inherits Doc's grant via the typed FK

app.listen(() =>
  console.log(`gdocs-clone on http://localhost:${app.config.port} [${app.config.env}]`));