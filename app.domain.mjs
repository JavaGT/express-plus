// app.domain.mjs — OPTION 3 entry point: thin global wiring + explicit domain mounts.
//
// app.mjs stays thin as you grow to Project, Comment, etc. — each domain is one
// module + one app.mount() call. No auto-discovery: registration is greppable.
import expressPlus, { router, requireAuth } from 'express-plus';
import { config } from './config.mjs';
import sessionRoutes from './routes/sessions.mjs';
import docRoutes from './routes/docs.mjs';
import shareRoutes from './routes/shares.mjs';
import DocDomain from './domains/doc.mjs';

const app = expressPlus();

app.get('/', userList);
app.use('/sessions', sessionRoutes);

const users = router();
users.get('/', requireAuth, userList);
users.get('/:id', userPage);
app.use('/users', users);

// mount() registers the domain's schema (CRUD + history + CRDT room), rooms, and
// hooks in one call; product-only routes are passed alongside.
app.mount(DocDomain, {
  routes: { prefix: '/docs', use: [requireAuth],
            mount: [['/', docRoutes], ['/:docId/shares', shareRoutes]] },
});

app.listen(config.port, () =>
  console.log(`gdocs-clone on http://localhost:${config.port} [${config.env}]`));
