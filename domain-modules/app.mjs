// app.mjs — thin global wiring. One module + one .mount() per domain.
//
// Sensible defaults (security, body, sessions, req.user hydration, rate limit,
// cors, logs, views, static, error handling, graceful shutdown) are baked into
// express-plus — nothing to apply, nothing to hand-mount. mount() infers the
// prefix from the module name (Doc → /docs); pass a second arg to override.
// mount() is chainable; .listen() boots.
//
// Routes live INSIDE the domains. The ONLY thing app-level here is the truly
// cross-cutting landing route `/`, which spans no single resource.
import expressPlus from 'express-plus';
import { config } from './config.mjs';
import DocDomain from './domains/doc/index.mjs';
import SessionDomain from './domains/session/index.mjs';
import { userList } from './domains/session/handlers.mjs';

const app = expressPlus();

// Cross-cutting landing page — belongs to no single domain.
app.get('/', userList);

app
  .mount(SessionDomain)            // /sessions, /users — routes-only, require: null
  .mount(DocDomain)               // /docs CRUD + /feed + /home + /:docId/shares + rooms + hooks
  .listen(config.port, () =>
    console.log(`gdocs-clone on http://localhost:${config.port} [${config.env}]`));
