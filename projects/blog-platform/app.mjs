// projects/blog-platform/app.mjs — thin global wiring.
//
// Sensible defaults (security, body parsing, session hydration, rate limit,
// CORS, logging, static files, error handling, graceful shutdown, WS /events)
// are baked into express-plus — nothing to hand-mount.
//
// Mounting is Express-style: persisted entities mount with `app.mount()`;
// cross-cutting auth is plain routers with `app.use()`.
//
// The blog platform has THREE entities (Blog, Post, Comment) mounted at
// separate paths. Blog subscriptions and comment identity are unified across
// all blogs through the global User FK — no per-tenant User table.
import expressPlus from 'express-plus';
import { Blog, Post, Comment } from './index.mjs';
import { sessionRoutes, userRoutes } from '../../domain-modules/domains/session/routes.mjs';

const app = expressPlus();

// Cross-cutting: auth boundary and user views (shared with the doc module).
app.use('/sessions', sessionRoutes());
app.use('/users', userRoutes());

// Blog entity: public discovery + owner-only CRUD + subscriptions.
app.mount('/blogs', Blog);

// Post entity: public feed + blog-scoped posts + author CRUD + state machine.
app.mount('/posts', Post);

// Comment entity: public read (approved on published posts) + unified identity
// + moderation (approve/spam/delete) by blog owner.
app.mount('/comments', Comment);

// Landing page: redirect to the activity feed.
app.get('/', (req, res) => res.redirect('/posts/feed'));

app.listen(process.env.PORT || 3000, () =>
  console.log(`blog-platform on http://localhost:${process.env.PORT || 3000}`));
