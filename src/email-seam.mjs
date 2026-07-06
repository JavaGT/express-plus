// email-seam.mjs — a pluggable post-commit email delivery seam.
//
// Email delivery is an out-of-band effect (post-commit projection) — it must
// never block the transaction. The framework ships a `noopTransport` that logs
// to console and does nothing; the app plugs in its own transport (SMTP, Resend,
// etc.). The seam registers itself as a post-commit consumer that watches for
// `email.send` events and calls the transport for each one.
//
//   - emailSeam({ transport }) → { install(app), send(app, {to, subject, body}) }
//     Creates the email seam with a user-provided transport function.
//   - noopTransport  — the default transport: logs to console, does nothing.
//   - install(app)   — registers the seam as a post-commit consumer on the app.
//     Must be called before `app.listen()` so the consumer is wired into the
//     pipeline by buildKernel.
//   - send(app, {to, subject, body}) — enqueues an email job for immediate
//     delivery. The transport is called as a post-commit side effect, never
//     blocking the calling transaction.

export const noopTransport = async ({ to, subject, body }) => {
  console.log(`[email] to=${to} subject="${subject}" body=${String(body ?? '').length} chars`);
};

export function emailSeam({ transport = noopTransport } = {}) {
  const consumer = async (events, { db }) => {
    for (const ev of events) {
      // Look for events with an email payload: type 'email.send' with
      // { to, subject, body } in the data.
      if (ev.type === 'email.send' && ev.data) {
        const { to, subject, body } = ev.data;
        if (to != null && subject != null && body != null) {
          try {
            await transport({ to, subject, body });
          } catch (err) {
            // Email delivery is best-effort — a transport failure must never
            // roll back the committed transaction. Log and continue.
            console.error('[email] transport error:', err.message);
          }
        }
      }
    }
  };

  // send(app, { to, subject, body }) — enqueue an email for delivery through the
  // post-commit pipeline. This is a convenience for server-side code that wants
  // to trigger an email without declaring a durable effect on an entity.
  function send(app, { to, subject, body }) {
    if (!app || !app.jobs) {
      console.warn('[email] cannot send — no job queue configured on the app');
      return;
    }
    app.jobs.enqueue({
      id: `email:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      kind: 'email',
      payload: { to, subject, body },
    });
  }

  return {
    install(app) {
      // Store the consumer on the app so buildKernel can wire it into the
      // postCommitConsumers pipeline. The consumer processes events from the
      // event log and calls the transport for email.send events.
      app._emailConsumer = consumer;
    },
    consumer,
    send,
    transport,
  };
}
