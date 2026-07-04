// server.mjs — the WhatsApp-clone floor from the design doc (§1.8).
//
// Two entities (Chat + Message) and six lines of wiring, and two browser tabs
// sync. Run:  node projects/chat/server.mjs  then open localhost:3000 in two
// tabs. Every line below is domain or visible wiring — the framework owns auth,
// CRUD, schema, the live /events transport, and serving the browser SDK.
//
// Start:  node projects/chat/server.mjs

import workbench, {
  entity, text, date, ref, map,
  grant, read, write, subscribe,
  scope, anyOf, inherit,
} from 'workbench';

// Chat — a conversation. The owner (auto-set from the logged-in user) and any
// member can read/write/subscribe. `members` is a valued set keyed by User; the
// `member` check is the single source of truth for "is this user in this chat"
// and is compiled into the read scope (a correlated EXISTS over the membership
// side-table) — no second auth path.
const Chat = entity('Chat', {
  title:   text(),
  owner:   ref('User', { role: 'owner', readonly: true }),  // auto-derives checks.owner
  members: map(ref('User'), { default: {} }),
  checks:  { member: ({ Chat, principal }) => Chat.members.has(principal.id) },
  grant: () => [
    scope(({ is }) => anyOf(is.owner(), is.member()))
      .can(() => grant(read, write, subscribe)),
  ],
  routes: (r) => {
    r.resource();
    // Invite a member over HTTP — `members` is a map field, which cannot be set
    // via a create/update payload (membership is mutated through the row
    // handle). `req.chat` is auto-loaded from the `:chatId` path segment. Only
    // the owner may invite (the row grant's write capability decides; a non-
    // owner's PATCH to the membership side-table is denied by the field's
    // strong-inherited row grant).
    r.post('/:chatId/members', async (req, res) => {
      await req.chat.members.set(req.body.userId, {});
      res.status(201).json({ added: req.body.userId });
    });
  },
});

// Message — a line in a chat. Its grant INHERITS the parent Chat's (typed-FK
// traversal via the `chat` field): a user who can read the chat can read its
// messages, and the compiled read scope is a correlated EXISTS through the FK
// into the Chat membership — one engine, both layers.
const Message = entity('Message', {
  chat:   ref('Chat', { required: true }),
  author: ref('User', { role: 'author', readonly: true }),  // auto-derives checks.author
  body:   text({ validate: (v) => (v && v.length) > 0 || 'empty message' }),
  sentAt: date({ default: () => new Date() }),
  grant:  inherit(Chat, { via: 'chat' }),
});

workbench({ db: 'chat.db' })
  .auth()                                            // /auth login+logout, sets sid cookie
  .mount('/chats', Chat)
  .mount('/chats/:chatId/messages', Message)
  .static('/', new URL('./public', import.meta.url).pathname)  // index.html; /workbench.mjs is served by default
  .listen();
