// Shared test fakes for the client transport seam — the ONE canonical copy.
// Previously these were copy-pasted across test files and drifted (e.g.
// makeFakeFetch had two incompatible signatures; one channel lacked
// checkpoint/resync). Extend HERE when a test needs a new capability; never
// re-add a divergent local copy.
//
// Reconcile decisions (issue #40):
// - makeFakeChannel: superset of every file's needs — subscribe parses both
//   the options-object and the onEvent-function forms, records a `calls` log,
//   throws on duplicate subscribe, registers onCheckpoint/onResync option
//   callbacks, and exposes `checkpoint`/`resync`/`_setAck`/`emit`.
// - makeFakeFetch: the routes-array signature is canonical
//   ([{ match, response|responseFn, status?, headers?, ok? }]); the old
//   snapshot/seq signature (fold-golden only) was migrated onto it. emit on
//   the channel takes ONE envelope argument (the envelope carries entity/id);
//   local-store's old 3-arg emit(entity, id, envelope) call sites were
//   migrated to the envelope form.

/** Build a FakeChannel compatible with LiveChannel's subscribe interface. */
export function makeFakeChannel() {
  const subs = new Map();
  const checkpoints = new Map();
  const resyncs = new Map();
  const calls = [];
  let subscribeAck = { currentSeq: 1 };

  const channel = {
    calls,
    _setAck(ack) { subscribeAck = ack; },
    subscribe(entity, id, optionsOrOnEvent, maybeOnEvent) {
      const options = typeof optionsOrOnEvent === 'function' ? {} : (optionsOrOnEvent ?? {});
      const onEvent = typeof optionsOrOnEvent === 'function' ? optionsOrOnEvent : maybeOnEvent;
      const key = `${entity}\0${String(id)}`;
      if (subs.has(key)) throw new Error(`already subscribed to ${entity}:${id}`);
      subs.set(key, onEvent);
      if (typeof options.onCheckpoint === 'function') checkpoints.set(key, options.onCheckpoint);
      if (typeof options.onResync === 'function') resyncs.set(key, options.onResync);
      calls.push({ entity, id, options });
      return Promise.resolve(subscribeAck);
    },
    unsubscribe(entity, id) {
      const key = `${entity}\0${String(id)}`;
      subs.delete(key);
      checkpoints.delete(key);
      resyncs.delete(key);
      return Promise.resolve();
    },
    close() {},
    emit(envelope) {
      const key = `${envelope.entity}\0${String(envelope.id)}`;
      const onEvent = subs.get(key);
      if (onEvent) onEvent(envelope);
    },
    checkpoint(entity, id, currentSeq) {
      checkpoints.get(`${entity}\0${String(id)}`)?.({ currentSeq });
    },
    resync(entity, id, control) {
      resyncs.get(`${entity}\0${String(id)}`)?.(control);
    },
  };
  return channel;
}

/** Build a fake fetch with routes: [{ match, response }] or [{ match, responseFn }]. */
export function makeFakeFetch(routes) {
  return async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : String(url);
    for (const route of routes) {
      if (urlStr.includes(route.match)) {
        const body = typeof route.responseFn === 'function'
          ? route.responseFn(urlStr, opts)
          : route.response;
        return {
          ok: route.ok ?? true,
          status: route.status ?? 200,
          headers: {
            get(name) {
              return route.headers?.[name.toLowerCase()] ?? null;
            },
          },
          json: async () => body,
        };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: 'not found' }) };
  };
}
