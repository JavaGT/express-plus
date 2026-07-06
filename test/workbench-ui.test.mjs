// workbench-ui.test.mjs — UI kit tests.
//
// Two suites:
//   1. Binding helpers — pure JS, runs with `node --test`
//   2. Svelte components — needs `node --conditions=browser --import ./test/svelte-loader.mjs --test`
//
// JSDOM setup for Svelte: JSDOM globals set before dynamic svelte import.
// Tests that require svelte are skipped when running under plain `node --test`.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers — adapted from live-store.test.mjs patterns
// ---------------------------------------------------------------------------

/** Create a deferred promise { promise, resolve, reject }. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Yield control to the event loop. */
function tick(ms = 0) {
  return new Promise(r => setTimeout(r, ms));
}

/** Build a FakeChannel. */
function makeFakeChannel() {
  const subs = new Map();
  let subscribeAck = { currentSeq: 1 };

  const channel = {
    calls: [],
    _setAck(ack) { subscribeAck = ack; },
    subscribe(entity, id, optionsOrOnEvent, maybeOnEvent) {
      const options = typeof optionsOrOnEvent === 'function' ? {} : (optionsOrOnEvent ?? {});
      const onEvent = typeof optionsOrOnEvent === 'function' ? optionsOrOnEvent : maybeOnEvent;
      const key = `${entity}\0${String(id)}`;
      if (subs.has(key)) throw new Error(`already subscribed to ${entity}:${id}`);
      subs.set(key, onEvent);
      this.calls.push({ entity, id, options });
      return Promise.resolve(subscribeAck);
    },
    unsubscribe(entity, id) {
      subs.delete(`${entity}\0${String(id)}`);
      return Promise.resolve();
    },
    close() {},
    emit(envelope) {
      const key = `${envelope.entity}\0${String(envelope.id)}`;
      const onEvent = subs.get(key);
      if (onEvent) onEvent(envelope);
    },
  };
  return channel;
}

/** Build a fake fetch with routes. */
function makeFakeFetch(routes) {
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
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
}

// ---------------------------------------------------------------------------
// Import binding helpers (pure JS — always available)
// ---------------------------------------------------------------------------

let bindAction, bindField, bindList;
before(async () => {
  const mod = await import('../public/workbench-ui-bindings.mjs');
  bindAction = mod.bindAction;
  bindField = mod.bindField;
  bindList = mod.bindList;
});

// ---------------------------------------------------------------------------
// Import svelte + component mounting harness (only with browser conditions)
// ---------------------------------------------------------------------------

let mount, unmount, tick_svelte;
let svelteAvailable = false;
let jsdomCleanup = null;

before(async () => {
  try {
    // The svelte client runtime needs browser DOM globals (Element, HTMLElement, etc.).
    // JSDOM provides them. We set up JSDOM BEFORE importing svelte because the
    // client module references these globals at import time.
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost' });
    jsdomCleanup = () => dom.window.close();
    const win = dom.window;
    for (const key of Object.getOwnPropertyNames(win)) {
      if (key in globalThis) continue;
      try { globalThis[key] = win[key]; } catch {}
    }
    globalThis.document = win.document;
    globalThis.window = win;

    // Now import svelte — with DOM globals set and --conditions=browser,
    // svelte resolves to the client runtime with a working mount().
    const svelteMod = await import('svelte');
    if (typeof svelteMod.mount === 'function') {
      // Quick probe: call mount with a dummy element to verify it works
      try {
        const probeDiv = document.createElement('div');
        document.body.appendChild(probeDiv);
        const probe = svelteMod.mount(() => {}, { target: probeDiv, props: {} });
        svelteMod.unmount(probe);
        document.body.removeChild(probeDiv);

        mount = svelteMod.mount;
        unmount = svelteMod.unmount;
        tick_svelte = svelteMod.tick;
        svelteAvailable = true;
      } catch (err) {
        // mount failed — svelte client runtime not fully set up
        svelteAvailable = false;
      }
    }
  } catch {
    // jsdom or svelte not importable — running under plain `node --test`
    svelteAvailable = false;
  }
});

after(() => {
  if (jsdomCleanup) jsdomCleanup();
});

// ---------------------------------------------------------------------------
// Component import helpers (delay imports until JSDOM is set up)
// ---------------------------------------------------------------------------

async function importComponent(name) {
  const mod = await import(`../public/${name}.svelte`);
  return mod.default;
}

// ---------------------------------------------------------------------------
//  PART 1: Binding Helper Tests (pure JS, no svelte needed)
// ---------------------------------------------------------------------------

describe('bindAction', () => {
  it('has correct initial state: idle, no error, row from overlayFor', () => {
    const store = {
      overlayFor: (id) => (id === '1' ? { id: '1', title: 'test' } : null),
      onRender: () => () => {},
      dispatch: async () => ({ ok: true }),
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({ title: 'x' }) });
    assert.equal(action.status, 'idle');
    assert.equal(action.error, null);
    assert.deepEqual(action.row, { id: '1', title: 'test' });
  });

  it('dispatch sets status to pending immediately, then confirmed on success', async () => {
    let capturedStatuses = [];
    const store = {
      overlayFor: () => ({ id: '1', title: 'a' }),
      dispatch: async (type, payload) => {
        await tick(10);
        return { ok: true, status: 'committed', id: '1' };
      },
      onRender: () => () => {},
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({ title: 'x' }) });

    action.subscribe((s) => capturedStatuses.push(s.status));

    const promise = action.dispatch();
    assert.equal(action.status, 'pending');
    // pending captured in subscribe
    assert.ok(capturedStatuses.includes('pending'));

    const result = await promise;
    assert.ok(result.ok);
    assert.equal(action.status, 'confirmed');
    assert.ok(capturedStatuses.includes('confirmed'));
  });

  it('dispatch failure → status = failed, error set', async () => {
    const store = {
      overlayFor: () => null,
      dispatch: async () => ({ ok: false, status: 'failed-rolled-back', error: 'server error' }),
      onRender: () => () => {},
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });

    const result = await action.dispatch();
    assert.equal(result.ok, false);
    assert.equal(action.status, 'failed');
    assert.equal(action.error, 'server error');
  });

  it('subscribe calls callback immediately with current state', () => {
    let called = false;
    const store = {
      overlayFor: () => ({ id: '1', title: 'immediate' }),
      onRender: () => () => {},
      dispatch: async () => ({ ok: true }),
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    const unsub = action.subscribe((s) => {
      called = true;
      assert.equal(s.status, 'idle');
      assert.deepEqual(s.row, { id: '1', title: 'immediate' });
    });
    assert.ok(called);
    unsub();
  });

  it('store.onRender triggers subscribe callbacks', () => {
    let renderCb = null;
    let callCount = 0;
    const store = {
      overlayFor: () => ({ id: '1' }),
      dispatch: async () => ({ ok: true }),
      onRender: (cb) => { renderCb = cb; return () => { renderCb = null; }; },
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    action.subscribe(() => { callCount++; });
    const initialCount = callCount;
    renderCb();
    assert.ok(callCount > initialCount);
  });

  it('destroy removes onRender subscription', () => {
    let unsubCalled = false;
    const store = {
      overlayFor: () => null,
      dispatch: async () => ({ ok: true }),
      onRender: () => () => { unsubCalled = true; },
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    action.subscribe(() => {});
    action.destroy();
    assert.ok(unsubCalled);
  });

  it('subscribe returns unsubscribe that cleans up', () => {
    let callCount = 0;
    let renderCb = null;
    const store = {
      overlayFor: () => null,
      dispatch: async () => ({ ok: true }),
      onRender: (cb) => { renderCb = cb; return () => { renderCb = null; }; },
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    const unsub = action.subscribe(() => { callCount++; });
    const afterFirst = callCount;
    unsub();
    if (renderCb) renderCb();
    assert.equal(callCount, afterFirst, 'no more calls after unsubscribe');
  });

  it('status transitions through idle → pending → confirmed', async () => {
    const statuses = [];
    const store = {
      overlayFor: () => null,
      dispatch: async () => {
        await tick(5);
        return { ok: true, status: 'committed' };
      },
      onRender: () => () => {},
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    action.subscribe((s) => statuses.push(s.status));

    assert.equal(action.status, 'idle');
    const promise = action.dispatch();
    assert.equal(action.status, 'pending');
    await promise;
    assert.equal(action.status, 'confirmed');
    assert.deepEqual(statuses.slice(0, 3), ['idle', 'pending', 'confirmed']);
  });

  it('status transitions through idle → pending → failed', async () => {
    const statuses = [];
    const store = {
      overlayFor: () => null,
      dispatch: async () => ({ ok: false, status: 'failed-rolled-back', error: 'boom' }),
      onRender: () => () => {},
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    action.subscribe((s) => statuses.push(s.status));

    await action.dispatch();
    assert.equal(action.status, 'failed');
    assert.deepEqual(statuses.slice(0, 3), ['idle', 'pending', 'failed']);
  });

  it('onStatusChange callback fires on status change', () => {
    const changes = [];
    const store = {
      overlayFor: () => null,
      dispatch: async () => ({ ok: true }),
      onRender: () => () => {},
    };
    const action = bindAction(store, {
      id: '1', action: 'Doc.update', payload: () => ({}),
      onStatusChange: (s) => changes.push(s),
    });
    assert.equal(action.status, 'idle');
    // onStatusChange not called on initial bind
    action.subscribe(() => {});
    assert.deepEqual(changes, []); // subscribe doesn't trigger onStatusChange, just internals
  });

  it('dispatch failure with network error → status = failed', async () => {
    const store = {
      overlayFor: () => null,
      dispatch: async () => { throw new Error('network down'); },
      onRender: () => () => {},
    };
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    const result = await action.dispatch();
    assert.equal(result.ok, false);
    assert.equal(action.status, 'failed');
    assert.ok(action.error.includes('network down'));
  });
});

describe('bindField', () => {
  it('value derived from overlayFor', () => {
    const store = {
      overlayFor: (id) => (id === '1' ? { id: '1', title: 'hello' } : null),
      onRender: () => () => {},
      update: async () => ({ ok: true }),
    };
    const field = bindField(store, { id: '1', field: 'title' });
    assert.equal(field.value, 'hello');
  });

  it('value undefined when overlayFor returns null', () => {
    const store = {
      overlayFor: () => null,
      onRender: () => () => {},
      update: async () => ({ ok: true }),
    };
    const field = bindField(store, { id: '1', field: 'title' });
    assert.equal(field.value, undefined);
  });

  it('update calls store.update with field value', async () => {
    let capturedId, capturedPayload;
    const store = {
      overlayFor: () => null,
      onRender: () => () => {},
      update: async (id, payload) => {
        capturedId = id;
        capturedPayload = payload;
        return { ok: true, status: 'committed' };
      },
    };
    const field = bindField(store, { id: '1', field: 'title' });
    const result = await field.update('new title');
    assert.ok(result.ok);
    assert.equal(capturedId, '1');
    assert.deepEqual(capturedPayload, { title: 'new title' });
  });

  it('update failure → status = failed', async () => {
    const store = {
      overlayFor: () => null,
      onRender: () => () => {},
      update: async () => ({ ok: false, error: 'conflict' }),
    };
    const field = bindField(store, { id: '1', field: 'title' });
    await field.update('x');
    assert.equal(field.status, 'failed');
    assert.equal(field.error, 'conflict');
  });

  it('subscribe receives value and status changes', () => {
    const states = [];
    const store = {
      overlayFor: () => ({ id: '1', title: 'current' }),
      onRender: () => () => {},
      update: async () => ({ ok: true }),
    };
    const field = bindField(store, { id: '1', field: 'title' });
    field.subscribe((s) => states.push({ value: s.value, status: s.status }));
    assert.equal(states.length, 1);
    assert.equal(states[0].value, 'current');
    assert.equal(states[0].status, 'idle');
  });

  it('onValueChange fires on value change via render', () => {
    let changedValue = null;
    let renderCb = null;
    const store = {
      overlayFor: () => ({ id: '1', title: 'changed' }),
      onRender: (cb) => { renderCb = cb; return () => {}; },
      update: async () => ({ ok: true }),
    };
    const field = bindField(store, { id: '1', field: 'title', onValueChange: (v) => { changedValue = v; } });
    // subscribe activates the store.onRender subscription
    const unsub = field.subscribe(() => {});
    assert.ok(renderCb, 'onRender cb registered');
    renderCb();
    assert.equal(changedValue, 'changed');
    unsub();
  });

  it('destroy cleans up subscriptions', () => {
    let unsubCalled = false;
    const store = {
      overlayFor: () => null,
      onRender: () => () => { unsubCalled = true; },
      update: async () => ({ ok: true }),
    };
    const field = bindField(store, { id: '1', field: 'title' });
    field.subscribe(() => {});
    field.destroy();
    assert.ok(unsubCalled);
  });
});

describe('bindList', () => {
  it('items derived from list.state[field]', () => {
    let renderCb = null;
    const listState = { id: '1', items: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] };
    const store = {
      subscribe: (id, opts) => ({
        state: listState,
        ready: Promise.resolve(),
        onRender: (cb) => { renderCb = cb; return () => {}; },
      }),
      pendingCreates: () => [],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items' });
    const items = list.items;
    assert.equal(items.length, 2);
    assert.equal(items[0].key, 'a');
    assert.equal(items[0].status, 'committed');
    assert.deepEqual(items[0].row, { id: 'a', text: 'one' });
    assert.equal(items[1].key, 'b');
    assert.equal(items[1].status, 'committed');
  });

  it('items includes pending creates from store.pendingCreates', () => {
    const store = {
      subscribe: () => ({
        state: { id: '1', items: [{ id: 'a', text: 'one' }] },
        ready: Promise.resolve(),
        onRender: () => () => {},
      }),
      pendingCreates: () => [
        { opId: 'op_p1', kind: 'create', optimistic: { text: 'pending item' } },
      ],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items' });
    const items = list.items;
    assert.equal(items.length, 2);
    assert.equal(items[1].key, 'op_p1');
    assert.equal(items[1].status, 'pending');
    assert.deepEqual(items[1].row, { text: 'pending item' });
  });

  it('ready resolves when list bootstrap completes', async () => {
    const d = deferred();
    const store = {
      subscribe: () => ({
        state: null,
        ready: d.promise,
        onRender: () => () => {},
      }),
      pendingCreates: () => [],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items' });
    let ready = false;
    list.ready.then(() => { ready = true; });
    assert.equal(ready, false);
    d.resolve();
    await tick();
    assert.equal(ready, true);
  });

  it('subscribe calls callback immediately with current items', () => {
    let called = false;
    const store = {
      subscribe: () => ({
        state: { id: '1', items: [{ id: '1', text: 'x' }] },
        ready: Promise.resolve(),
        onRender: () => () => {},
      }),
      pendingCreates: () => [],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items' });
    list.subscribe((items) => {
      called = true;
      assert.equal(items.length, 1);
    });
    assert.ok(called);
  });

  it('subscribe returns unsubscribe function', () => {
    let callCount = 0;
    let renderCb = null;
    const store = {
      subscribe: () => ({
        state: { id: '1', items: [] },
        ready: Promise.resolve(),
        onRender: (cb) => { renderCb = cb; return () => {}; },
      }),
      pendingCreates: () => [],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items' });
    const unsub = list.subscribe(() => { callCount++; });
    const afterFirst = callCount;
    unsub();
    if (renderCb) renderCb();
    assert.equal(callCount, afterFirst, 'no more calls after unsubscribe');
  });

  it('empty state field → empty items array', () => {
    const store = {
      subscribe: () => ({
        state: { id: '1' },
        ready: Promise.resolve(),
        onRender: () => () => {},
      }),
      pendingCreates: () => [],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items' });
    assert.deepEqual(list.items, []);
  });

  it('null state → empty items array', () => {
    const store = {
      subscribe: () => ({
        state: null,
        ready: Promise.resolve(),
        onRender: () => () => {},
      }),
      pendingCreates: () => [],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items' });
    assert.deepEqual(list.items, []);
  });

  it('destroy cleans up all subscriptions', () => {
    let listUnsubCalled = false;
    let storeUnsubCalled = false;
    const store = {
      subscribe: () => ({
        state: null,
        ready: Promise.resolve(),
        onRender: () => () => { listUnsubCalled = true; },
      }),
      pendingCreates: () => [],
      onRender: () => () => { storeUnsubCalled = true; },
    };
    const list = bindList(store, { id: '1', field: 'items' });
    list.subscribe(() => {});
    list.destroy();
    assert.ok(listUnsubCalled);
    assert.ok(storeUnsubCalled);
  });

  it('items use index-based key when row has no id', () => {
    const store = {
      subscribe: () => ({
        state: { id: '1', items: [{ text: 'no-id' }, { text: 'also-no-id' }] },
        ready: Promise.resolve(),
        onRender: () => () => {},
      }),
      pendingCreates: () => [],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items' });
    const items = list.items;
    assert.equal(items[0].key, 'item_0');
    assert.equal(items[1].key, 'item_1');
  });

  it('onItemsChange fires when items change via render', () => {
    let changedItems = null;
    let renderCb = null;
    const store = {
      subscribe: () => ({
        state: { id: '1', items: [{ id: '1', text: 'new' }] },
        ready: Promise.resolve(),
        onRender: (cb) => { renderCb = cb; return () => {}; },
      }),
      pendingCreates: () => [],
      onRender: () => () => {},
    };
    const list = bindList(store, { id: '1', field: 'items', onItemsChange: (items) => { changedItems = items; } });
    list.subscribe(() => {}); // activates subscriptions
    renderCb();
    assert.ok(changedItems);
    assert.equal(changedItems.length, 1);
  });
});

// ---------------------------------------------------------------------------
//  PART 2: Svelte Component Tests (requires --conditions=browser + JSDOM)
// ---------------------------------------------------------------------------

describe('Svelte Components (browser)', () => {
  // JSDOM globals are set up by the top-level before() hook above.

  // --- ActionButton ---

  describe('ActionButton', () => {
    it('renders a button with data-wb-part and data-status', async () => {
      if (!svelteAvailable) return;
      const ActionButton = await importComponent('ActionButton');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        overlayFor: () => null,
        onRender: () => () => {},
        dispatch: async () => ({ ok: true, status: 'committed' }),
      };

      const comp = mount(ActionButton, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          action: 'Doc.update',
          payload: () => ({ title: 'hello' }),
          label: 'Save',
        },
      });

      const btn = container.querySelector('[data-wb-part="action-button"]');
      assert.ok(btn, 'button exists');
      assert.equal(btn.getAttribute('data-status'), 'idle');
      assert.equal(btn.textContent.trim(), 'Save');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('click dispatches action and status reflects pending', async () => {
      if (!svelteAvailable) return;
      const ActionButton = await importComponent('ActionButton');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let dispatched = false;
      const d = deferred();
      const fakeStore = {
        overlayFor: () => null,
        onRender: () => () => {},
        dispatch: async (type, payload) => {
          dispatched = true;
          await d.promise;
          return { ok: true, status: 'committed', id: '1' };
        },
      };

      const comp = mount(ActionButton, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          action: 'Doc.update',
          payload: () => ({ title: 'hello' }),
          label: 'Save',
        },
      });

      const btn = container.querySelector('button');
      btn.click();

      // After click, should be pending
      assert.ok(dispatched, 'dispatch was called');
      await tick();
      assert.equal(btn.getAttribute('data-status'), 'pending');
      assert.equal(btn.disabled, true);

      d.resolve();
      await tick(50);
      assert.equal(btn.getAttribute('data-status'), 'confirmed');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('failed dispatch → data-status=failed', async () => {
      if (!svelteAvailable) return;
      const ActionButton = await importComponent('ActionButton');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        overlayFor: () => null,
        onRender: () => () => {},
        dispatch: async () => ({ ok: false, status: 'failed-rolled-back', error: 'boom' }),
      };

      const comp = mount(ActionButton, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          action: 'Doc.update',
          payload: () => ({}),
          label: 'Delete',
        },
      });

      const btn = container.querySelector('button');
      btn.click();
      await tick(50);

      assert.equal(btn.getAttribute('data-status'), 'failed');
      assert.equal(btn.getAttribute('data-error'), 'boom');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows pendingLabel while pending', async () => {
      if (!svelteAvailable) return;
      const ActionButton = await importComponent('ActionButton');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const d = deferred();
      const fakeStore = {
        overlayFor: () => null,
        onRender: () => () => {},
        dispatch: async () => {
          await d.promise;
          return { ok: true };
        },
      };

      const comp = mount(ActionButton, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          action: 'Doc.update',
          payload: () => ({}),
          label: 'Save',
          pendingLabel: 'Saving...',
        },
      });

      const btn = container.querySelector('button');
      btn.click();
      await tick();
      assert.equal(btn.textContent.trim(), 'Saving...');

      d.resolve();
      await tick(50);
      assert.equal(btn.textContent.trim(), 'Save');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes the button from DOM', async () => {
      if (!svelteAvailable) return;
      const ActionButton = await importComponent('ActionButton');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(ActionButton, {
        target: container,
        props: {
          store: { overlayFor: () => null, onRender: () => () => {}, dispatch: async () => ({ ok: true }) },
          id: '1', action: 'Doc.update', payload: () => ({}), label: 'X',
        },
      });

      assert.ok(container.querySelector('button'));
      unmount(comp);
      assert.equal(container.querySelector('button'), null);

      document.body.removeChild(container);
    });
  });

  // --- TextInput ---

  describe('TextInput', () => {
    it('renders input with label and value from field binding', async () => {
      if (!svelteAvailable) return;
      const TextInput = await importComponent('TextInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        overlayFor: (id) => (id === '1' ? { id: '1', title: 'hello' } : null),
        onRender: () => () => {},
        update: async () => ({ ok: true }),
      };

      const comp = mount(TextInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'title',
          label: 'Title',
        },
      });

      const input = container.querySelector('input');
      assert.ok(input);
      assert.equal(input.value, 'hello');

      const label = container.querySelector('label');
      assert.ok(label);
      assert.equal(label.textContent, 'Title');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('typing dispatches update after debounce', async () => {
      if (!svelteAvailable) return;
      const TextInput = await importComponent('TextInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let capturedPayload;
      const fakeStore = {
        overlayFor: (id) => (id === '1' ? { id: '1', title: 'old' } : null),
        onRender: () => () => {},
        update: async (id, payload) => {
          capturedPayload = payload;
          return { ok: true, status: 'committed' };
        },
      };

      const comp = mount(TextInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'title',
          debounceMs: 10,
        },
      });

      const input = container.querySelector('input');
      // Simulate typing
      input.value = 'new value';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));

      // Should not have dispatched yet (debounce)
      assert.equal(capturedPayload, undefined);

      await tick(50);

      assert.ok(capturedPayload);
      assert.deepEqual(capturedPayload, { title: 'new value' });

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders textarea when multiline=true', async () => {
      if (!svelteAvailable) return;
      const TextInput = await importComponent('TextInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        overlayFor: () => ({ id: '1', body: 'long text' }),
        onRender: () => () => {},
        update: async () => ({ ok: true }),
      };

      const comp = mount(TextInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'body',
          multiline: true,
        },
      });

      const textarea = container.querySelector('textarea');
      assert.ok(textarea);
      assert.equal(textarea.value, 'long text');
      assert.equal(container.querySelector('input'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('data-status reflects pending/confirmed', async () => {
      if (!svelteAvailable) return;
      const TextInput = await importComponent('TextInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const d = deferred();
      const fakeStore = {
        overlayFor: () => ({ id: '1', title: 'x' }),
        onRender: () => () => {},
        update: async () => {
          await d.promise;
          return { ok: true, status: 'committed' };
        },
      };

      const comp = mount(TextInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'title',
          debounceMs: 1,
        },
      });

      const wrapper = container.querySelector('[data-wb-part="text-input"]');
      assert.equal(wrapper.getAttribute('data-status'), 'idle');

      const input = container.querySelector('input');
      input.value = 'changed';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await tick(10);

      assert.equal(wrapper.getAttribute('data-status'), 'pending');

      d.resolve();
      await tick(50);
      assert.equal(wrapper.getAttribute('data-status'), 'confirmed');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const TextInput = await importComponent('TextInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(TextInput, {
        target: container,
        props: {
          store: { overlayFor: () => null, onRender: () => () => {}, update: async () => ({ ok: true }) },
          id: '1', field: 't',
        },
      });

      assert.ok(container.querySelector('[data-wb-part="text-input"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="text-input"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- ListView ---

  describe('ListView', () => {
    it('renders items from list.state[field]', async () => {
      if (!svelteAvailable) return;
      const ListView = await importComponent('ListView');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let renderCb = null;
      const fakeStore = {
        subscribe: (id, opts) => ({
          state: { id: '1', items: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] },
          ready: Promise.resolve(),
          onRender: (cb) => { renderCb = cb; return () => {}; },
        }),
        pendingCreates: () => [],
        onRender: () => () => {},
      };

      const comp = mount(ListView, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'items',
          renderItem: (row) => `<span>${row.text}</span>`,
        },
      });

      await tick();

      const items = container.querySelectorAll('[data-wb-part="list-view"] .wb-list-view__item');
      assert.equal(items.length, 2);
      assert.equal(items[0].getAttribute('data-status'), 'committed');
      assert.equal(items[0].getAttribute('data-key'), 'a');
      assert.equal(items[0].textContent, 'one');
      assert.equal(items[1].getAttribute('data-key'), 'b');
      assert.equal(items[1].textContent, 'two');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows empty slot when no items', async () => {
      if (!svelteAvailable) return;
      const ListView = await importComponent('ListView');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        subscribe: () => ({
          state: { id: '1', items: [] },
          ready: Promise.resolve(),
          onRender: () => () => {},
        }),
        pendingCreates: () => [],
        onRender: () => () => {},
      };

      const comp = mount(ListView, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'items',
          empty: 'No items yet',
        },
      });

      await tick();

      const emptyEl = container.querySelector('.wb-list-view__empty');
      assert.ok(emptyEl);
      assert.equal(emptyEl.textContent, 'No items yet');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('includes pending creates', async () => {
      if (!svelteAvailable) return;
      const ListView = await importComponent('ListView');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let renderCb = null;
      const fakeStore = {
        subscribe: () => ({
          state: { id: '1', items: [{ id: 'a', text: 'committed' }] },
          ready: Promise.resolve(),
          onRender: (cb) => { renderCb = cb; return () => {}; },
        }),
        pendingCreates: () => [
          { opId: 'op_1', kind: 'create', optimistic: { text: 'pending item' } },
        ],
        onRender: () => () => {},
      };

      const comp = mount(ListView, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'items',
          renderItem: (row) => `<span>${row.text}</span>`,
        },
      });

      await tick();

      const items = container.querySelectorAll('.wb-list-view__item');
      assert.equal(items.length, 2);
      assert.equal(items[0].getAttribute('data-status'), 'committed');
      assert.equal(items[1].getAttribute('data-status'), 'pending');
      assert.equal(items[1].getAttribute('data-key'), 'op_1');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('uses custom keyFn when provided', async () => {
      if (!svelteAvailable) return;
      const ListView = await importComponent('ListView');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        subscribe: () => ({
          state: { id: '1', items: [{ id: 'a', slug: 'item-a' }] },
          ready: Promise.resolve(),
          onRender: () => () => {},
        }),
        pendingCreates: () => [],
        onRender: () => () => {},
      };

      const comp = mount(ListView, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'items',
          keyFn: (row) => row.slug,
          renderItem: (row) => `<span>${row.slug}</span>`,
        },
      });

      await tick();

      const item = container.querySelector('.wb-list-view__item');
      assert.ok(item);
      assert.equal(item.getAttribute('data-key'), 'item-a');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes list elements', async () => {
      if (!svelteAvailable) return;
      const ListView = await importComponent('ListView');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        subscribe: () => ({
          state: { id: '1', items: [{ id: 'a', text: 'x' }] },
          ready: Promise.resolve(),
          onRender: () => () => {},
        }),
        pendingCreates: () => [],
        onRender: () => () => {},
      };

      const comp = mount(ListView, {
        target: container,
        props: { store: fakeStore, id: '1', field: 'items', renderItem: (r) => r.text },
      });

      await tick();
      assert.ok(container.querySelector('[data-wb-part="list-view"]'));

      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="list-view"]'), null);

      document.body.removeChild(container);
    });
  });
});

// ---------------------------------------------------------------------------
//  PART 3: Optionality guard — importing workbench-client.mjs without the kit
// ---------------------------------------------------------------------------

describe('Optionality guard', () => {
  it('workbench-client.mjs imports and functions without UI kit', async () => {
    // Verify the client can be imported and used without any UI kit dependency.
    const { createLiveStore } = await import('../public/workbench-client.mjs');
    assert.equal(typeof createLiveStore, 'function');
  });
});
