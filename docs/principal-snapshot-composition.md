# Principal snapshot composition

A principal snapshot is a read-only, server-projected view of host-owned data,
anchored to one `Principal` (type + id). The machinery is the Decision-0019
bridge: a generic runtime cannot observe host SQL, so the host (1) declares a
projection, (2) invalidates it inside its own transactions, and (3) supplies a
membership-aware reauthorization seam. The runtime owns projection, cursor,
reconnect, and revocation; the host owns when a recipient's view changes and
whether a recipient may still see it.

This page composes every piece end to end: declaration registration, the
transaction mutation pattern, the principal resolver, the reauthorization
adapter, and the client session wiring.

## 1. Declare the projection (server)

A declaration names a principal type and a set of `many` collections projected
from one table, filtered by a `via` column that holds the principal id.

```ts
import { projectionSource, principalSnapshot } from 'workbench';

const schema = app.schema; // the frozen application schema object

const hubItems = projectionSource(schema, 'HubItem');

const userHub = principalSnapshot('user-hub', {
  principalType: 'user',
  output: principalSnapshot.object({
    items: principalSnapshot.many(hubItems, {
      via: hubItems.field.recipientId,          // WHERE recipientId = <principal.id>
      key: hubItems.field.id,
      select: principalSnapshot.select(hubItems.field.title),
      orderBy: [principalSnapshot.orderBy(hubItems.field.rank)],
    }),
  }),
});
```

Registration happens when you attach live delivery (section 2). The runtime
validates the declaration against the application schema: every projected
table and column must exist, and every field handle must come from the declared
source. Only declared columns are ever projected — an undeclared sensitive
column never leaves the server.

## 2. Attach delivery (server)

The application seam is `app.attachLiveDelivery(options)`. It registers your
declarations, wires the wake hook to the delivery, and mounts `/bootstrap` and
`/events` routes (and the WebSocket upgrade) at `options.path`.

```ts
import type { Principal } from 'workbench';

app.attachLiveDelivery({
  principalOf: async (req) => sessionPrincipalOf(req), // request -> Principal (type + id)
  principalSnapshots: [userHub],
  // Host membership/authorization for snapshots — see section 4.
  principalSnapshotAuthorize: ({ declaration, principal, trigger }) => {
    return membershipAllows(principal, declaration); // host policy
  },
  // Optional: the same authorization adapter used for entity delivery.
  authorization,
});
```

Every access to a principal snapshot fails closed if `principalSnapshotAuthorize`
is omitted (a deployment MUST supply it) or if it returns anything other than
strictly `true`.

## 3. Mutate host state, then invalidate (server)

Host mutations go through the app transaction seam so the durable invalidation
lands in the SAME SQLite transaction as the host mutation. Rollback undoes
both; commit survives restart; duplicate invalidations coalesce.

```ts
await app.principalSnapshots.transaction((tx) => {
  // 1. Ordinary host-owned mutation — any SQL, any table.
  db.prepare('UPDATE HubItem SET title = ? WHERE id = ?').run('Renamed', 'a');
  // 2. Bump the recipient's snapshot revision inside the same transaction.
  tx.invalidate(userHub, { type: 'user', id: 'u1' });
});
```

The callback is synchronous — no awaits, no returned promises. The transaction
refuses nested `transaction()` calls, unregistered or foreign declarations, and
`invalidate` after the callback returns. Only the `_PrincipalSnapshotRevision`
row and `tx.db` are touched: no `_Log` rows, receipts, or committed revisions
are written, so the wake is not a second collaborative mutation authority.

After commit, the runtime wakes the attached delivery, which reauthorizes
(section 4) and delivers a `resync` envelope to open subscriptions for that
recipient.

## 4. The reauthorization adapter (server)

`PrincipalSnapshotAuthorize` is the ONLY host authority over whether a recipient
may receive a snapshot. Scope-level admission (declaration name + principal type
+ exact principal id from the scope string) is a grammar gate, not an
authorization gate — a revoked membership does not change the grammar.

```ts
type PrincipalSnapshotAuthorize =
  (input: {
    declaration: PrincipalSnapshotDeclaration;
    principal: { type: string; id: string };
    trigger: 'bootstrap' | 'catchup' | 'subscribe' | 'resync';
  }) => boolean | Promise<boolean>;
```

The runtime invokes it **before every recipient projection**:

- `bootstrap` — one-shot initial snapshot (`GET /live-delivery/bootstrap`)
- `catchup` — stale-cursor recovery (`mode=catchup`)
- `subscribe` — SSE / WebSocket subscription admission (`GET /live-delivery/events`)
- `resync` — every replacement/resync drain on a long-lived subscription

A denial, an authorizer error, or a non-`true` result fails closed:

- bootstrap / catchup return `{ kind: 'revoked' }`;
- subscription admission revokes the transport first, then rejects with the
  terminal `live-delivery-revoked` code (the HTTP skin maps it to HTTP 403);
- a **resync drain** revokes the subscription **before** any replacement
  projection is delivered — a principal whose membership was revoked never
  receives another row.

A membership-aware implementation (what Scope supplies) checks the host's own
tables inside the trigger callback — e.g. a live `Membership` row keyed by
recipient:

```ts
const membershipAllows = ({ declaration, principal }) => {
  const row = db.prepare(
    'SELECT 1 FROM Member WHERE hub = ? AND memberId = ? AND active = 1',
  ).get(declaration.name, principal.id);
  return row !== undefined;
};
```

`resync` runs on every drain, so a long-lived connection is re-checked whenever
a replacement is about to be delivered — the HTTP layer's one-time principal
resolution per request is not the authorization boundary.

## 5. Client session (browser)

The client uses `createPrincipalSnapshotHttpSession` from `workbench/client`.
It owns the scope string, cursor, reconnect, and opaque-resync replacement; it
exposes no mutation, reducer, or cursor-configuration seam.

```js
import { createPrincipalSnapshotHttpSession } from 'workbench/client';

const session = createPrincipalSnapshotHttpSession({
  baseUrl: '/live-delivery',
  declaration: 'user-hub',
  principal: { type: 'user', id: 'u1' },
  validateSnapshot(value) {
    // Reject a malformed payload from the server before it reaches state.
    if (!value || !Array.isArray(value.items)) throw new Error('invalid snapshot');
    return value;
  },
});

await session.ready;
console.log(session.snapshot.items); // recipient-only rows, already validated

session.subscribe((snapshot) => renderHub(snapshot));
// session.reconnect(); session.close();  // lifecycle as needed
```

## End-to-end flow

```
host mutation ──> app.principalSnapshots.transaction ──> [_PrincipalSnapshotRevision +1, same txn]
                                                            │ commit
                                                            v
                                          wake hook → delivery.wake(decl, principal)
                                                            │
                                        subscription drain (long-lived) ──> reauthorize
                                                            │
                                          admitted  ──> resync envelope ──> client re-bootstrap
                                          denied    ──> revoke (stream ends) — nothing delivered
```

One-shot reads (`bootstrap`/`catchup`) run the same reauthorization before any
projection; denials surface as `revoked` — the HTTP skin returns the explicit
revoked JSON result for the one-shot request (bootstrap/catchup), and for a
long-lived subscription ends the stream. A one-shot denial is not an HTTP 403;
it is the same `{ kind: 'revoked' }` envelope the transport uses.

## Files

- `src/principal-snapshot-declaration.ts` — declaration grammar, `projectionSource`
- `src/principal-snapshot-scope.ts` — `PrincipalSnapshot:<declaration>/<type>/<id>` scope grammar
- `src/principal-snapshot-transaction.ts` — transaction-bound atomic invalidation
- `src/principal-snapshot-delivery.ts` — bootstrap/catchup/subscribe/resync/revoke,
  the `PrincipalSnapshotAuthorize` seam
- `src/live-delivery-public.ts`, `src/application-live-delivery.ts` — app integration
- `public/workbench-client.mjs` — `createPrincipalSnapshotHttpSession`