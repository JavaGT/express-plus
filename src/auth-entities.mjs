// The framework-provided auth entities: User and Session.
//
// session.mjs (the binding exemplar) imports these FROM the framework rather than
// declaring them, because authentication is the framework's concern, not the
// app's: the app should not have to hand-roll a user table, a password digest, or
// the session→principal mapping the request pipeline already depends on.
//
//   - User  — username + a one-way hash() password. Served by the generic query
//             API: User.findOne(User.username.is(name)), User.create({...}),
//             user.password.verify(pw), User.findAll().select(...), getOrFail(id).
//   - Session — the minted capability record the request pipeline reads to build
//             a principal. sessionPrincipalOf runs
//             `SELECT principalType, principalId FROM Session WHERE token = ?`,
//             so Session's STORED row is (token, principalType, principalId).
//
// Both carry a fail-closed grant: they are never mounted as request-facing
// entity-CRUD (the exemplar mounts /users and /sessions as imperative routers),
// so their read-scope grants nothing — `never()`/`deny`. The auth layer reaches
// them only through the UNSCOPED, trusted query API, never a request path.

import { entity } from './entity.mjs';
import { text, hash, ref } from './field.mjs';
import { scope } from './scope.mjs';
import { never } from './scope-sql.mjs';
import { grant, deny, read, subscribe } from './grant.mjs';

// A framework auth entity is never request-readable: its rows are reached only
// by trusted server code (login lookup, principal hydration), never dispatched
// to a request principal. The most fail-closed valid grant: a never() scope (no
// row is request-visible) whose .can denies every capability.
const notRequestReadable = (which) =>
  scope(() => never()).can(() =>
    deny(`${which} is a framework auth entity, reached only by trusted server ` +
      `code (the unscoped query API), never request-dispatched`));

export const User = entity('User', {
  fields: {
    username: text(),
    password: hash(),
  },
  grant: () => [notRequestReadable('User')],
});

// The two session intents are a CLOSED set, each a named whole mapped to the one
// canonical stored row { token, principalType, principalId }:
//   - { userId }            -> a user session   (principalType 'user', principalId = userId)
//   - { kind: 'link', token } -> a link session (principalType 'link', principalId = the share token)
// The minted `token` is a fresh, unguessable SESSION token (distinct from a
// link's share token). Anything else is rejected — fail closed. This create
// policy mints server-side cells it owns, so it does not run validateMutation;
// it composes the entity's trusted `insert` core (one write path).
function mintSession(payload, { insert, mintToken }) {
  const token = mintToken();
  if (payload && typeof payload.userId !== 'undefined') {
    return insert({ token, principalType: 'user', principalId: String(payload.userId) });
  }
  if (payload && payload.kind === 'link' && typeof payload.token !== 'undefined') {
    // The link principal carries WHICH share granted it: the incoming share
    // token (the grant identity), not the doc id. A fresh session token is minted
    // for the cookie; the share token becomes the principal id.
    return insert({ token, principalType: 'link', principalId: String(payload.token) });
  }
  throw new Error(
    `Session.create accepts a closed set of session intents: { userId } for a ` +
      `user session or { kind: 'link', token } for a link session. Received ` +
      `${JSON.stringify(payload)} (fail closed).`,
  );
}

export const Session = entity('Session', {
  // The stored cells are framework-owned and readonly: an app never writes them
  // by hand; the create policy mints them. Declaring them keeps the table schema
  // typed and inspectable (Session.token.is(...) is a first-class handle).
  fields: {
    token: text({ readonly: true }),
    principalType: text({ readonly: true }),
    principalId: text({ readonly: true }),
  },
  grant: () => [notRequestReadable('Session')],
  create: mintSession,
});

// Inbox — the framework's per-user notification store. An app projects rows into
// it via a declared effect (doc.mjs: when a collaborator is added to a Doc, a row
// is created with { recipient: delta.member, doc: entity.id, kind: 'invite' }),
// and a user reads their OWN inbox. Like User/Session it is the framework's
// concern (every collaborative app needs the same per-user notification shape),
// imported FROM express-plus, never app-declared.
//
//   - recipient — a User ref carrying the `recipient` role, so the entity
//                 compiler derives is.recipient() and the grant's scope compiles
//                 to `t0.recipient = :principalId`: a user reads ONLY their own
//                 inbox rows (recipient-scoped, fail-closed default-on).
//   - doc       — the Doc the notification is about (a typed FK).
//   - kind      — the notification kind ('invite', ...): a plain text facet.
//
// The grant's SCOPE filters rows to the recipient (compiled to SQL, never run as
// JS, so its is.recipient() is correctly un-awaited); the .can body then confers
// read + subscribe on those already-recipient-scoped rows (a one-shot REST fetch
// and a sustained WS push of new notifications). It needs no is.* call — the row
// is already the principal's own — so it is trivially guard-clean.
export const Inbox = entity('Inbox', {
  fields: {
    recipient: ref('User', { role: 'recipient' }),
    doc: ref('Doc'),
    kind: text(),
  },
  grant: () => [scope(({ is }) => is.recipient()).can(() => grant(read, subscribe))],
});
