// app.mjs — thin global wiring.
//
// Sensible defaults (security, body, sessions, req.user hydration, rate limit,
// cors, logs, views, static, error handling, graceful shutdown, AND the WS
// /events subscription stream) are baked into express-plus — nothing to apply,
// nothing to hand-mount.
//
// Mounting is Express-style: you declare the endpoint path. Persisted product
// domains are entities (`app.mount('/docs', DocEntity)`); cross-cutting auth
// is plain routers (`app.use('/sessions', ...)`). The live /events WS endpoint
// is framework-baked and not declared here.
//
// NOTE: a standalone demo, not linked to hello.mjs (which spins its own app
// instance on its own port).
import expressPlus from 'express-plus';
import { config } from './config.mjs';
import DocEntity from './domains/doc/index.mjs';
import { sessionRoutes, userRoutes } from './domains/session/routes.mjs';
import { userList } from './domains/session/handlers.mjs';

const app = expressPlus();

app.get('/', userList);                         // cross-cutting landing page (authed)
app.use('/sessions', sessionRoutes());           // auth boundary (login opts out, rest authed)
app.use('/users', userRoutes());                  // user views (authed)
app.mount('/docs', DocEntity);                    // Doc entity: CRUD + /:id/chat + /:id/presence + /feed + /home + /:docId/shares + live fields

app.listen(config.port, () =>
  console.log(`gdocs-clone on http://localhost:${config.port} [${config.env}]`));
