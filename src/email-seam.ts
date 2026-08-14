// email-seam.mjs — a pluggable, cursor-backed post-commit email delivery seam.
//
// Email delivery is an out-of-band effect (post-commit projection) — it must
// never block the transaction. The framework ships a `noopTransport` that logs
// to console and does nothing; the app plugs in its own transport (SMTP, Resend,
// etc.). The seam registers itself as a post-commit consumer that watches for
// `email.send` events and calls the transport for each one.
//
// Durability: the same _ConsumerCursor pattern as blob.finalize/projected.async/
// effect.durable (consumer-cursor.mjs) — a per-scope cursor advances only AFTER
// a successful transport call, and a boot-time reconcile sweep
// (reconcileEmailDelivery) replays any scope whose _Log outran its cursor.
//
// UNLIKE blob finalize, the transport call is NOT provably idempotent: sending
// the same email twice is not safe-by-construction the way re-finalizing an
// already-finalized blob is. So this is honestly at-least-once with a
// documented residual risk: a crash (or a blocked cursor write) between a
// successful transport call and its cursor write can cause a duplicate send on
// the next reconcile replay. That is the honest contract external delivery can
// offer here — it is not exactly-once and does not claim to be.
//
//   - emailSeam({ transport }) → { install(app), send(app, {to, subject, body}) }
//     Creates the email seam with a user-provided transport function.
//   - noopTransport  — the default transport: logs to console, does nothing.
//   - install(app)   — registers the seam's consumer + reconcile sweep on the
//     app. Must be called before `app.listen()` so buildKernel wires both into
//     the pipeline / boot sequence.
//   - send(app, {to, subject, body}) — enqueues an email job for immediate
//     delivery. The transport is called as a post-commit side effect, never
//     blocking the calling transaction.

import { sweepBehindCursor, upsertConsumerCursor } from './consumer-cursor.ts';
import { txn, type DbHandle } from './driver.ts';

const CONSUMER = 'email';

interface EmailPayload {
  to: unknown;
  subject: unknown;
  body: unknown;
}

type Transport = (payload: EmailPayload) => unknown;

interface EventRecord {
  type?: string;
  data?: Record<string, unknown>;
  scope?: string;
  seq?: number;
}

interface AppLike {
  jobs?: { enqueue(opts: { id: string; kind: string; payload: Record<string, unknown> }): unknown };
  _emailConsumer?: unknown;
  _reconcileEmailDelivery?: unknown;
}

interface EmailSeam {
  install(app: AppLike): void;
  consumer(events: EventRecord[], opts?: { db?: DbHandle }): Promise<void>;
  reconcileEmailDelivery(db: DbHandle): Promise<{ delivered: number }>;
  send(app: AppLike, payload: EmailPayload): void;
  transport: Transport;
}

export const noopTransport: Transport = async ({ to, subject, body }) => {
  console.log(`[email] to=${to} subject="${subject}" body=${String(body ?? '').length} chars`);
};

function extractEmailPayload(event: EventRecord | null | undefined): EmailPayload | null {
  if (!event || event.type !== 'email.send' || !event.data) return null;
  const { to, subject, body } = event.data;
  if (to == null || subject == null || body == null) return null;
  return { to, subject, body };
}

export function emailSeam({ transport = noopTransport }: { transport?: Transport } = {}): EmailSeam {
  // deliverAndAdvance mirrors blob-lifecycle.mjs's finalizeAndAdvance: the
  // transport call happens OUTSIDE the SQL transaction (it's not a database
  // write), then the cursor write is wrapped in its own txn. Only the
  // checkpoint is atomic; the send itself cannot be rolled back by SQL.
  async function deliverAndAdvance(db: DbHandle, { scope, seq }: { scope: string; seq: number }, payload: EmailPayload | null): Promise<void> {
    if (payload) await transport(payload);
    await txn(db, () => {
      upsertConsumerCursor(db, { consumer: CONSUMER, scope, lastSeq: seq });
    });
  }

  const consumer = async (events: EventRecord[], { db }: { db?: DbHandle } = {}): Promise<void> => {
    // Same per-scope blocking as blob-lifecycle.mjs's consumer, for the same
    // reason: events for one scope arrive in ascending seq order within a
    // batch, and a later same-scope success must not advance the cursor past
    // an earlier same-scope failure (lastSeq only ever goes up — advancing
    // past a miss hides it from every future reconcile run, not just this
    // one). Deferring the rest of a blocked scope to reconcile is simple and
    // safe here too, at the cost this seam already accepts: a re-attempted
    // later send may duplicate one that technically already went out.
    const blockedScopes = new Set<string>();
    for (const event of events) {
      if (event.scope != null && blockedScopes.has(event.scope)) continue;
      const payload = extractEmailPayload(event);
      if (typeof event.seq !== 'number' || !db) {
        // No log seq to anchor a cursor to (a caller driving the consumer
        // outside the committed pipeline, or no db configured) — best-effort,
        // uncursored, matching this seam's pre-durability behavior.
        if (payload) {
          try {
            await transport(payload);
          } catch (err) {
            console.error('[email] transport error:', (err as Error).message);
          }
        }
        continue;
      }
      try {
        await deliverAndAdvance(db, { scope: event.scope as string, seq: event.seq }, payload);
      } catch (err) {
        if (event.scope != null) blockedScopes.add(event.scope);
        console.error('[email] delivery consumer failed:', (err as Error).message);
      }
    }
  };

  async function reconcileEmailDelivery(db: DbHandle): Promise<{ delivered: number }> {
    let delivered = 0;
    await sweepBehindCursor(db, CONSUMER, async (row) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(row.eventData as string) as Record<string, unknown>; } catch { data = {}; }
      const payload = extractEmailPayload({ type: row.eventType, data });
      try {
        await deliverAndAdvance(db, { scope: row.scope, seq: row.seq }, payload);
        if (payload) delivered += 1;
        return 'done';
      } catch (err) {
        console.error('[email] delivery recovery failed:', (err as Error).message);
        return 'block';
      }
    });
    return { delivered };
  }

  // send(app, { to, subject, body }) — enqueue an email for delivery through the
  // post-commit pipeline. This is a convenience for server-side code that wants
  // to trigger an email without declaring a durable effect on an entity.
  function send(app: AppLike, { to, subject, body }: EmailPayload): void {
    if (!app || !app.jobs) {
      console.warn('[email] cannot send — no job queue configured on the app');
      return;
    }
    // enqueue may be coordinated (returns a Promise when the app wired a write
    // coordinator) or synchronous — swallow a coordinated rejection the same way
    // the sync path's throw would be a no-op here (best-effort send).
    const queued = app.jobs.enqueue({
      id: `email:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      kind: 'email',
      payload: { to, subject, body },
    }) as unknown;
    if (queued && typeof (queued as Promise<unknown>).then === 'function') {
      (queued as Promise<unknown>).catch(() => {});
    }
  }

  return {
    install(app: AppLike): void {
      // Store the consumer + reconcile sweep on the app so buildKernel can
      // wire both into the postCommitConsumers pipeline / boot sequence.
      app._emailConsumer = consumer;
      app._reconcileEmailDelivery = reconcileEmailDelivery;
    },
    consumer,
    reconcileEmailDelivery,
    send,
    transport,
  };
}
