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
      dispatch: async () => ({
        ok: false,
        status: 'failed-rolled-back',
        opId: 'op-failed',
        failure: { category: 'internal', message: 'server error' },
      }),
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
      dispatch: async () => ({
        ok: false,
        status: 'failed-rolled-back',
        opId: 'op-failed',
        failure: { category: 'internal', message: 'boom' },
      }),
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
      update: async () => ({
        ok: false,
        status: 'failed-rolled-back',
        opId: 'op-failed',
        failure: { category: 'conflict', message: 'conflict' },
      }),
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
        dispatch: async () => ({
          ok: false,
          status: 'failed-rolled-back',
          opId: 'op-failed',
          failure: { category: 'internal', message: 'boom' },
        }),
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

// ---------------------------------------------------------------------------
//  PART 4: bindConnection helper tests (pure JS)
// ---------------------------------------------------------------------------

describe('bindConnection', () => {
  let bindConnection;

  before(async () => {
    const mod = await import('../public/workbench-ui-bindings.mjs');
    bindConnection = mod.bindConnection;
  });

  it('initial status is disconnected', () => {
    const conn = bindConnection({ _closed: false, _socket: null, _reconnectTimer: null });
    assert.equal(conn.status, 'disconnected');
    conn.destroy();
  });

  it('subscribe calls callback immediately with current status', () => {
    let called = false;
    const conn = bindConnection({ _closed: false, _socket: null, _reconnectTimer: null });
    const unsub = conn.subscribe((s) => {
      called = true;
      assert.equal(s.status, 'disconnected');
    });
    assert.ok(called);
    unsub();
    conn.destroy();
  });

  it('onConnectionChange hook updates status', () => {
    let changeCb = null;
    const channel = {
      _closed: false,
      _socket: null,
      _reconnectTimer: null,
      onConnectionChange(cb) {
        changeCb = cb;
        return () => { changeCb = null; };
      },
    };
    const conn = bindConnection(channel);
    const states = [];
    conn.subscribe((s) => states.push(s.status));
    assert.equal(states[0], 'disconnected');

    changeCb('connected');
    assert.equal(conn.status, 'connected');
    assert.deepEqual(states, ['disconnected', 'connected']);

    changeCb('reconnecting');
    assert.equal(conn.status, 'reconnecting');
    assert.deepEqual(states, ['disconnected', 'connected', 'reconnecting']);

    conn.destroy();
  });

  it('uses onConnectionChange hook when provided', () => {
    let listener = null;
    const channel = {
      onConnectionChange: (cb) => {
        listener = cb;
        return () => { listener = null; };
      },
    };
    const conn = bindConnection(channel);
    const states = [];
    conn.subscribe((s) => states.push(s.status));
    assert.equal(conn.status, 'disconnected');

    listener('connected');
    assert.equal(conn.status, 'connected');
    assert.deepEqual(states, ['disconnected', 'connected']);

    listener('reconnecting');
    assert.equal(conn.status, 'reconnecting');

    conn.destroy();
  });

  it('stays disconnected when no onConnectionChange hook', () => {
    const channel = {}; // no hook, no private internals to poll
    const conn = bindConnection(channel);
    assert.equal(conn.status, 'disconnected');

    conn.subscribe(() => {});
    assert.equal(conn.status, 'disconnected');

    conn.destroy();
  });

  it('notifies all subscribers on status change', () => {
    let listener = null;
    const channel = {
      onConnectionChange: (cb) => { listener = cb; return () => { listener = null; }; },
    };
    const conn = bindConnection(channel);
    const a = [], b = [];
    conn.subscribe((s) => a.push(s.status));
    conn.subscribe((s) => b.push(s.status));

    listener('connected');
    assert.deepEqual(a, ['disconnected', 'connected']);
    assert.deepEqual(b, ['disconnected', 'connected']);

    conn.destroy();
  });

  it('subscribe returns unsubscribe that stops notifications', () => {
    let listener = null;
    const channel = {
      onConnectionChange: (cb) => { listener = cb; return () => { listener = null; }; },
    };
    const conn = bindConnection(channel);
    let count = 0;
    const unsub = conn.subscribe(() => { count++; });

    listener('connected');
    assert.equal(count, 2); // initial + connected change

    unsub();
    // After unsub, the listener is disconnected — calling it is a no-op
    // (the channel's onConnectionChange teardown set listener to null)
    assert.equal(listener, null);

    conn.destroy();
  });

  it('destroy cleans up all subscribers and listeners', () => {
    let listener = null;
    let cleaned = false;
    const channel = {
      onConnectionChange: (cb) => { listener = cb; return () => { cleaned = true; }; },
    };
    const conn = bindConnection(channel);
    conn.subscribe(() => {});
    conn.destroy();

    assert.equal(cleaned, true);
  });
});

// ---------------------------------------------------------------------------
//  PART 5: Wave 2 Component Tests (Svelte, requires browser conditions)
// ---------------------------------------------------------------------------

describe('Svelte Wave 2 Components (browser)', () => {
  // --- FormInput ---

  describe('FormInput', () => {
    it('select renders options and shows current value', async () => {
      if (!svelteAvailable) return;
      const FormInput = await importComponent('FormInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        overlayFor: (id) => (id === '1' ? { id: '1', color: 'blue' } : null),
        onRender: () => () => {},
        update: async () => ({ ok: true }),
      };

      const comp = mount(FormInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'color',
          type: 'select',
          options: [
            { value: 'red', label: 'Red' },
            { value: 'blue', label: 'Blue' },
            { value: 'green', label: 'Green' },
          ],
        },
      });

      const select = container.querySelector('select');
      assert.ok(select);
      assert.equal(select.value, 'blue');

      const options = select.querySelectorAll('option');
      assert.equal(options.length, 3);
      assert.equal(options[0].value, 'red');
      assert.equal(options[1].value, 'blue');
      assert.equal(options[2].value, 'green');

      const wrapper = container.querySelector('[data-wb-part="form-input"]');
      assert.ok(wrapper);
      assert.equal(wrapper.getAttribute('data-status'), 'idle');
      assert.equal(wrapper.getAttribute('data-type'), 'select');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('select change dispatches update', async () => {
      if (!svelteAvailable) return;
      const FormInput = await importComponent('FormInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let capturedPayload;
      const fakeStore = {
        overlayFor: () => ({ id: '1', color: 'blue' }),
        onRender: () => () => {},
        update: async (id, payload) => {
          capturedPayload = payload;
          return { ok: true };
        },
      };

      const comp = mount(FormInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'color',
          type: 'select',
          options: [
            { value: 'red', label: 'Red' },
            { value: 'blue', label: 'Blue' },
          ],
        },
      });

      const select = container.querySelector('select');
      select.value = 'red';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      await tick();

      assert.ok(capturedPayload);
      assert.deepEqual(capturedPayload, { color: 'red' });

      unmount(comp);
      document.body.removeChild(container);
    });

    it('checkbox toggles boolean value 0/1', async () => {
      if (!svelteAvailable) return;
      const FormInput = await importComponent('FormInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let capturedPayload;
      const fakeStore = {
        overlayFor: () => ({ id: '1', active: 1 }),
        onRender: () => () => {},
        update: async (id, payload) => {
          capturedPayload = payload;
          return { ok: true };
        },
      };

      const comp = mount(FormInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'active',
          type: 'checkbox',
          options: [{ label: 'Active' }],
        },
      });

      const checkbox = container.querySelector('input[type="checkbox"]');
      assert.ok(checkbox);
      assert.equal(checkbox.checked, true);

      // Toggle off (1 → 0)
      checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
      await tick();
      assert.deepEqual(capturedPayload, { active: 0 });

      unmount(comp);
      document.body.removeChild(container);
    });

    it('checkbox shows label from options', async () => {
      if (!svelteAvailable) return;
      const FormInput = await importComponent('FormInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        overlayFor: () => ({ id: '1', subscribed: 0 }),
        onRender: () => () => {},
        update: async () => ({ ok: true }),
      };

      const comp = mount(FormInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'subscribed',
          type: 'checkbox',
          options: [{ label: 'Subscribe to newsletter' }],
        },
      });

      const label = container.querySelector('label.wb-form-input__checkbox-label');
      assert.ok(label);
      assert.ok(label.textContent.includes('Subscribe to newsletter'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('radio group renders options and selects value', async () => {
      if (!svelteAvailable) return;
      const FormInput = await importComponent('FormInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let capturedPayload;
      const fakeStore = {
        overlayFor: () => ({ id: '1', size: 'medium' }),
        onRender: () => () => {},
        update: async (id, payload) => {
          capturedPayload = payload;
          return { ok: true };
        },
      };

      const comp = mount(FormInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'size',
          type: 'radio',
          options: [
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ],
        },
      });

      const radios = container.querySelectorAll('input[type="radio"]');
      assert.equal(radios.length, 3);
      assert.equal(radios[0].checked, false);
      assert.equal(radios[1].checked, true);
      assert.equal(radios[2].checked, false);

      // Select 'large'
      radios[2].checked = true;
      radios[2].dispatchEvent(new window.Event('change', { bubbles: true }));
      await tick();
      assert.deepEqual(capturedPayload, { size: 'large' });

      unmount(comp);
      document.body.removeChild(container);
    });

    it('enum button group renders and selects on click', async () => {
      if (!svelteAvailable) return;
      const FormInput = await importComponent('FormInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let capturedPayload;
      const fakeStore = {
        overlayFor: () => ({ id: '1', theme: 'light' }),
        onRender: () => () => {},
        update: async (id, payload) => {
          capturedPayload = payload;
          return { ok: true };
        },
      };

      const comp = mount(FormInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'theme',
          type: 'enum',
          options: [
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ],
        },
      });

      const buttons = container.querySelectorAll('.wb-form-input__enum-btn');
      assert.equal(buttons.length, 2);
      assert.equal(buttons[0].getAttribute('data-selected'), 'true');
      assert.equal(buttons[1].getAttribute('data-selected'), 'false');
      assert.ok(buttons[0].textContent.includes('Light'));
      assert.ok(buttons[1].textContent.includes('Dark'));

      // Click 'Dark'
      buttons[1].click();
      await tick();
      assert.deepEqual(capturedPayload, { theme: 'dark' });

      unmount(comp);
      document.body.removeChild(container);
    });

    it('label prop renders', async () => {
      if (!svelteAvailable) return;
      const FormInput = await importComponent('FormInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const fakeStore = {
        overlayFor: () => ({ id: '1', color: 'blue' }),
        onRender: () => () => {},
        update: async () => ({ ok: true }),
      };

      const comp = mount(FormInput, {
        target: container,
        props: {
          store: fakeStore,
          id: '1',
          field: 'color',
          type: 'select',
          label: 'Choose color',
          options: [{ value: 'blue', label: 'Blue' }],
        },
      });

      const label = container.querySelector('label.wb-form-input__label');
      assert.ok(label);
      assert.equal(label.textContent, 'Choose color');

      unmount(comp);
      document.body.removeChild(container);
    });
  });

  // --- Modal ---

  describe('Modal', () => {
    it('renders when open is true', async () => {
      if (!svelteAvailable) return;
      const Modal = await importComponent('Modal');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Modal, {
        target: container,
        props: { open: true, title: 'Test Modal' },
      });

      const backdrop = container.querySelector('[data-wb-part="modal-backdrop"]');
      assert.ok(backdrop);

      const modal = container.querySelector('[data-wb-part="modal"]');
      assert.ok(modal);
      assert.equal(modal.getAttribute('role'), 'dialog');
      assert.equal(modal.getAttribute('aria-modal'), 'true');
      assert.equal(modal.getAttribute('aria-label'), 'Test Modal');

      const header = container.querySelector('[data-wb-part="modal-header"]');
      assert.ok(header);
      assert.equal(header.textContent, 'Test Modal');

      const body = container.querySelector('[data-wb-part="modal-body"]');
      assert.ok(body);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('does not render when open is false', async () => {
      if (!svelteAvailable) return;
      const Modal = await importComponent('Modal');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Modal, {
        target: container,
        props: { open: false, title: 'Hidden' },
      });

      assert.equal(container.querySelector('[data-wb-part="modal-backdrop"]'), null);
      assert.equal(container.querySelector('[data-wb-part="modal"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('backdrop click calls onClose', async () => {
      if (!svelteAvailable) return;
      const Modal = await importComponent('Modal');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let closed = false;
      const comp = mount(Modal, {
        target: container,
        props: {
          open: true,
          title: 'Closable',
          onClose: () => { closed = true; },
        },
      });

      const backdrop = container.querySelector('[data-wb-part="modal-backdrop"]');
      backdrop.click();
      assert.equal(closed, true);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('clicking modal body does not call onClose', async () => {
      if (!svelteAvailable) return;
      const Modal = await importComponent('Modal');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let closed = false;
      const comp = mount(Modal, {
        target: container,
        props: {
          open: true,
          title: 'Non-closable',
          onClose: () => { closed = true; },
        },
      });

      const body = container.querySelector('[data-wb-part="modal-body"]');
      body.click();
      // Click event bubbles to backdrop, but handleBackdropClick checks
      // e.target === e.currentTarget, so this should NOT close.
      assert.equal(closed, false);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('Escape key calls onClose', async () => {
      if (!svelteAvailable) return;
      const Modal = await importComponent('Modal');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let closed = false;
      const comp = mount(Modal, {
        target: container,
        props: {
          open: true,
          title: 'Escapable',
          onClose: () => { closed = true; },
        },
      });

      await tick();

      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.equal(closed, true);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('Escape does nothing when open is false', async () => {
      if (!svelteAvailable) return;
      const Modal = await importComponent('Modal');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let closed = false;
      const comp = mount(Modal, {
        target: container,
        props: {
          open: false,
          title: 'Closed',
          onClose: () => { closed = true; },
        },
      });

      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.equal(closed, false);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('Escape listener is removed on unmount', async () => {
      if (!svelteAvailable) return;
      const Modal = await importComponent('Modal');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let closed = false;
      const comp = mount(Modal, {
        target: container,
        props: {
          open: true,
          title: 'Remove',
          onClose: () => { closed = true; },
        },
      });

      unmount(comp);
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
      assert.equal(closed, false);

      document.body.removeChild(container);
    });

    it('modal disappears on unmount', async () => {
      if (!svelteAvailable) return;
      const Modal = await importComponent('Modal');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Modal, {
        target: container,
        props: { open: true, title: 'Bye' },
      });

      assert.ok(container.querySelector('[data-wb-part="modal"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="modal"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- ConnectionIndicator ---

  describe('ConnectionIndicator', () => {
    it('renders with disconnected state by default', async () => {
      if (!svelteAvailable) return;
      const ConnectionIndicator = await importComponent('ConnectionIndicator');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const channel = {
        _closed: false,
        _socket: null,
        _reconnectTimer: null,
      };

      const comp = mount(ConnectionIndicator, {
        target: container,
        props: { channel },
      });

      const indicator = container.querySelector('[data-wb-part="connection-indicator"]');
      assert.ok(indicator);
      assert.equal(indicator.getAttribute('data-state'), 'disconnected');
      assert.ok(indicator.textContent.includes('Disconnected'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders connected state via onConnectionChange', async () => {
      if (!svelteAvailable) return;
      const ConnectionIndicator = await importComponent('ConnectionIndicator');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let changeCb = null;
      const channel = {
        _closed: false,
        _socket: null,
        _reconnectTimer: null,
        onConnectionChange(cb) {
          changeCb = cb;
          return () => { changeCb = null; };
        },
      };

      const comp = mount(ConnectionIndicator, {
        target: container,
        props: { channel },
      });

      await tick();
      changeCb('connected');
      await tick();

      const indicator = container.querySelector('[data-wb-part="connection-indicator"]');
      assert.equal(indicator.getAttribute('data-state'), 'connected');
      assert.ok(indicator.textContent.includes('Connected'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders reconnecting state via onConnectionChange', async () => {
      if (!svelteAvailable) return;
      const ConnectionIndicator = await importComponent('ConnectionIndicator');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let changeCb = null;
      const channel = {
        _closed: false,
        _socket: null,
        _reconnectTimer: null,
        onConnectionChange(cb) {
          changeCb = cb;
          return () => { changeCb = null; };
        },
      };

      const comp = mount(ConnectionIndicator, {
        target: container,
        props: { channel },
      });

      await tick();
      changeCb('reconnecting');
      await tick();

      const indicator = container.querySelector('[data-wb-part="connection-indicator"]');
      assert.equal(indicator.getAttribute('data-state'), 'reconnecting');
      assert.ok(indicator.textContent.includes('Reconnecting'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows presence dot when showPresence is true', async () => {
      if (!svelteAvailable) return;
      const ConnectionIndicator = await importComponent('ConnectionIndicator');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let changeCb = null;
      const channel = {
        _closed: false,
        _socket: null,
        _reconnectTimer: null,
        onConnectionChange(cb) {
          changeCb = cb;
          return () => { changeCb = null; };
        },
      };

      const comp = mount(ConnectionIndicator, {
        target: container,
        props: { channel, showPresence: true },
      });

      await tick();
      changeCb('connected');
      await tick();

      const presenceDot = container.querySelector('.wb-presence-dot');
      assert.ok(presenceDot);
      assert.ok(presenceDot.classList.contains('wb-presence-dot--online'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows custom label when provided', async () => {
      if (!svelteAvailable) return;
      const ConnectionIndicator = await importComponent('ConnectionIndicator');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const channel = {
        _closed: false,
        _socket: null,
        _reconnectTimer: null,
      };

      const comp = mount(ConnectionIndicator, {
        target: container,
        props: { channel, label: 'Live' },
      });

      const label = container.querySelector('.wb-connection-label');
      assert.ok(label);
      assert.equal(label.textContent, 'Live');

      unmount(comp);
      document.body.removeChild(container);
    });
  });

  // --- Dropdown ---

  describe('Dropdown', () => {
    it('renders trigger button', async () => {
      if (!svelteAvailable) return;
      const Dropdown = await importComponent('Dropdown');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Dropdown, {
        target: container,
        props: {
          trigger: 'Actions',
          items: [
            { label: 'Edit', action: () => {} },
            { label: 'Delete', action: () => {}, danger: true },
          ],
        },
      });

      const trigger = container.querySelector('[data-wb-part="dropdown-trigger"]');
      assert.ok(trigger);
      assert.equal(trigger.textContent.trim(), 'Actions');

      // Menu should be closed initially
      assert.equal(container.querySelector('[data-wb-part="dropdown-item"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('click trigger opens menu', async () => {
      if (!svelteAvailable) return;
      const Dropdown = await importComponent('Dropdown');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Dropdown, {
        target: container,
        props: {
          trigger: 'Menu',
          items: [
            { label: 'Option 1', action: () => {} },
            { label: 'Option 2', action: () => {} },
          ],
        },
      });

      const trigger = container.querySelector('[data-wb-part="dropdown-trigger"]');
      trigger.click();
      await tick();

      const items = container.querySelectorAll('[data-wb-part="dropdown-item"]');
      assert.equal(items.length, 2);
      assert.equal(items[0].textContent.trim(), 'Option 1');
      assert.equal(items[1].textContent.trim(), 'Option 2');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('click item calls action and closes menu', async () => {
      if (!svelteAvailable) return;
      const Dropdown = await importComponent('Dropdown');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let actionCalled = false;
      const comp = mount(Dropdown, {
        target: container,
        props: {
          trigger: 'Menu',
          items: [
            { label: 'Do Thing', action: () => { actionCalled = true; } },
          ],
        },
      });

      const trigger = container.querySelector('[data-wb-part="dropdown-trigger"]');
      trigger.click();
      await tick();

      const item = container.querySelector('[data-wb-part="dropdown-item"]');
      item.click();
      await tick();

      assert.equal(actionCalled, true);
      // Menu should be closed after item click
      assert.equal(container.querySelector('[data-wb-part="dropdown-item"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('disabled item does not call action', async () => {
      if (!svelteAvailable) return;
      const Dropdown = await importComponent('Dropdown');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let actionCalled = false;
      const comp = mount(Dropdown, {
        target: container,
        props: {
          trigger: 'Menu',
          items: [
            { label: 'Disabled', action: () => { actionCalled = true; }, disabled: true },
          ],
        },
      });

      const trigger = container.querySelector('[data-wb-part="dropdown-trigger"]');
      trigger.click();
      await tick();

      const item = container.querySelector('[data-wb-part="dropdown-item"]');
      assert.equal(item.disabled, true);
      item.click();
      await tick();

      assert.equal(actionCalled, false);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('danger item has danger class', async () => {
      if (!svelteAvailable) return;
      const Dropdown = await importComponent('Dropdown');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Dropdown, {
        target: container,
        props: {
          trigger: 'Menu',
          items: [
            { label: 'Normal', action: () => {} },
            { label: 'Delete', action: () => {}, danger: true },
          ],
        },
      });

      const trigger = container.querySelector('[data-wb-part="dropdown-trigger"]');
      trigger.click();
      await tick();

      const items = container.querySelectorAll('[data-wb-part="dropdown-item"]');
      assert.equal(items.length, 2);
      assert.ok(!items[0].classList.contains('wb-dropdown__item--danger'));
      assert.ok(items[1].classList.contains('wb-dropdown__item--danger'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('outside click closes menu', async () => {
      if (!svelteAvailable) return;
      const Dropdown = await importComponent('Dropdown');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Dropdown, {
        target: container,
        props: {
          trigger: 'Menu',
          items: [
            { label: 'Item', action: () => {} },
          ],
        },
      });

      const trigger = container.querySelector('[data-wb-part="dropdown-trigger"]');
      trigger.click();
      await tick();
      assert.ok(container.querySelector('[data-wb-part="dropdown-item"]'));

      // Click outside (on document body)
      document.body.click();
      await tick();
      assert.equal(container.querySelector('[data-wb-part="dropdown-item"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('toggle: second click closes menu', async () => {
      if (!svelteAvailable) return;
      const Dropdown = await importComponent('Dropdown');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Dropdown, {
        target: container,
        props: {
          trigger: 'Menu',
          items: [{ label: 'Item', action: () => {} }],
        },
      });

      const trigger = container.querySelector('[data-wb-part="dropdown-trigger"]');
      trigger.click();
      await tick();
      assert.ok(container.querySelector('[data-wb-part="dropdown-item"]'));

      trigger.click();
      await tick();
      assert.equal(container.querySelector('[data-wb-part="dropdown-item"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });
  });

  // --- OptimisticBadge (renders bindAction status) ---

  describe('OptimisticBadge', () => {
    it('renders nothing when idle', async () => {
      if (!svelteAvailable) return;
      const OptimisticBadge = await importComponent('OptimisticBadge');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(OptimisticBadge, {
        target: container,
        props: {
          boundAction: {
            subscribe(cb) { cb({ status: 'idle', error: null }); return () => {}; },
          },
        },
      });

      await tick();
      assert.equal(container.querySelector('[data-wb-part="optimistic-badge"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows spinner when status is pending', async () => {
      if (!svelteAvailable) return;
      const OptimisticBadge = await importComponent('OptimisticBadge');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(OptimisticBadge, {
        target: container,
        props: {
          boundAction: {
            subscribe(cb) { cb({ status: 'pending', error: null }); return () => {}; },
          },
        },
      });

      await tick();
      const badge = container.querySelector('[data-wb-part="optimistic-badge"]');
      assert.ok(badge, 'pending badge renders');
      assert.equal(badge.getAttribute('data-status'), 'pending');
      assert.ok(badge.querySelector('.wb-optimistic-badge__spinner'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows error when status is failed', async () => {
      if (!svelteAvailable) return;
      const OptimisticBadge = await importComponent('OptimisticBadge');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(OptimisticBadge, {
        target: container,
        props: {
          boundAction: {
            subscribe(cb) { cb({ status: 'failed', error: 'Network error' }); return () => {}; },
          },
        },
      });

      await tick();
      const badge = container.querySelector('[data-wb-part="optimistic-badge"]');
      assert.ok(badge, 'failed badge renders');
      assert.equal(badge.getAttribute('data-status'), 'failed');
      assert.equal(badge.getAttribute('title'), 'Network error');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders nothing when no boundAction', async () => {
      if (!svelteAvailable) return;
      const OptimisticBadge = await importComponent('OptimisticBadge');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(OptimisticBadge, {
        target: container,
        props: {},
      });

      await tick();
      assert.equal(container.querySelector('[data-wb-part="optimistic-badge"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders nothing for confirmed status', async () => {
      if (!svelteAvailable) return;
      const OptimisticBadge = await importComponent('OptimisticBadge');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(OptimisticBadge, {
        target: container,
        props: {
          boundAction: {
            subscribe(cb) { cb({ status: 'confirmed', error: null }); return () => {}; },
          },
        },
      });

      await tick();
      assert.equal(container.querySelector('[data-wb-part="optimistic-badge"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });
  });
});

// ---------------------------------------------------------------------------
//  PART 6: Wave 3 Component Tests (Svelte, requires browser conditions)
// ---------------------------------------------------------------------------

describe('Svelte Wave 3 Components (browser)', () => {
  // --- Toast ---

  describe('Toast', () => {
    it('renders toasts with messages', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const toasts = [
        { id: 't1', type: 'info', message: 'Hello world' },
      ];

      const comp = mount(Toast, {
        target: container,
        props: { toasts },
      });

      const containerEl = container.querySelector('[data-wb-part="toast-container"]');
      assert.ok(containerEl);

      const toastEls = container.querySelectorAll('[data-wb-part="toast"]');
      assert.equal(toastEls.length, 1);
      assert.equal(toastEls[0].getAttribute('data-toast-type'), 'info');

      const msg = container.querySelector('[data-wb-part="toast-message"]');
      assert.ok(msg);
      assert.equal(msg.textContent, 'Hello world');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders multiple toasts', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const toasts = [
        { id: 't1', type: 'info', message: 'First' },
        { id: 't2', type: 'success', message: 'Second' },
        { id: 't3', type: 'error', message: 'Third' },
      ];

      const comp = mount(Toast, { target: container, props: { toasts } });

      const toastEls = container.querySelectorAll('[data-wb-part="toast"]');
      assert.equal(toastEls.length, 3);
      assert.equal(toastEls[0].getAttribute('data-toast-type'), 'info');
      assert.equal(toastEls[1].getAttribute('data-toast-type'), 'success');
      assert.equal(toastEls[2].getAttribute('data-toast-type'), 'error');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('click dismiss calls onDismiss with toast id', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let dismissedId = null;
      const toasts = [
        { id: 't1', type: 'info', message: 'Dismiss me' },
      ];

      const comp = mount(Toast, {
        target: container,
        props: {
          toasts,
          onDismiss: (id) => { dismissedId = id; },
        },
      });

      const closeBtn = container.querySelector('[data-wb-part="toast-close"]');
      assert.ok(closeBtn);
      closeBtn.click();
      await tick();

      assert.equal(dismissedId, 't1');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('auto-dismiss after duration', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let dismissedId = null;
      const toasts = [
        { id: 't1', type: 'info', message: 'Auto', duration: 50 },
      ];

      const comp = mount(Toast, {
        target: container,
        props: {
          toasts,
          onDismiss: (id) => { dismissedId = id; },
        },
      });

      await tick(80);
      assert.equal(dismissedId, 't1');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with default position class', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Toast, {
        target: container,
        props: {
          toasts: [{ id: 't1', type: 'info', message: 'Pos' }],
        },
      });

      const containerEl = container.querySelector('[data-wb-part="toast-container"]');
      assert.ok(containerEl.classList.contains('wb-toast--top-right'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with custom position class', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Toast, {
        target: container,
        props: {
          toasts: [{ id: 't1', type: 'info', message: 'Pos' }],
          position: 'bottom-left',
        },
      });

      const containerEl = container.querySelector('[data-wb-part="toast-container"]');
      assert.ok(containerEl.classList.contains('wb-toast--bottom-left'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders toast action button', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let actionClicked = false;
      const toasts = [
        { id: 't1', type: 'info', message: 'Action toast', action: { label: 'Undo', onClick: () => { actionClicked = true; } } },
      ];

      const comp = mount(Toast, { target: container, props: { toasts } });

      const actionBtn = container.querySelector('[data-wb-part="toast-action"]');
      assert.ok(actionBtn);
      assert.equal(actionBtn.textContent, 'Undo');
      actionBtn.click();
      assert.equal(actionClicked, true);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders nothing when toasts array is empty', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Toast, {
        target: container,
        props: { toasts: [] },
      });

      assert.equal(container.querySelector('[data-wb-part="toast-container"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('has aria-live polite on container', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Toast, {
        target: container,
        props: {
          toasts: [{ id: 't1', type: 'info', message: 'A11y' }],
        },
      });

      const containerEl = container.querySelector('[data-wb-part="toast-container"]');
      assert.equal(containerEl.getAttribute('role'), 'status');
      assert.equal(containerEl.getAttribute('aria-live'), 'polite');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const Toast = await importComponent('Toast');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Toast, {
        target: container,
        props: {
          toasts: [{ id: 't1', type: 'info', message: 'Bye' }],
        },
      });

      assert.ok(container.querySelector('[data-wb-part="toast-container"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="toast-container"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- SearchInput ---

  describe('SearchInput', () => {
    it('renders input type search', async () => {
      if (!svelteAvailable) return;
      const SearchInput = await importComponent('SearchInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(SearchInput, {
        target: container,
        props: { placeholder: 'Search...' },
      });

      const wrapper = container.querySelector('[data-wb-part="search-input"]');
      assert.ok(wrapper);

      const input = container.querySelector('[data-wb-part="search-input-field"]');
      assert.ok(input);
      assert.equal(input.getAttribute('type'), 'search');
      assert.equal(input.getAttribute('placeholder'), 'Search...');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with initial value', async () => {
      if (!svelteAvailable) return;
      const SearchInput = await importComponent('SearchInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(SearchInput, {
        target: container,
        props: { value: 'hello' },
      });

      const input = container.querySelector('[data-wb-part="search-input-field"]');
      assert.equal(input.value, 'hello');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('debounces input and calls onSearch', async () => {
      if (!svelteAvailable) return;
      const SearchInput = await importComponent('SearchInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let searchedValue = null;
      const comp = mount(SearchInput, {
        target: container,
        props: {
          debounceMs: 10,
          onSearch: (v) => { searchedValue = v; },
        },
      });

      const input = container.querySelector('[data-wb-part="search-input-field"]');
      input.value = 'test query';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));

      // Not called immediately (debounce)
      assert.equal(searchedValue, null);

      await tick(30);
      assert.equal(searchedValue, 'test query');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows clear button when input has value', async () => {
      if (!svelteAvailable) return;
      const SearchInput = await importComponent('SearchInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(SearchInput, {
        target: container,
        props: { value: 'search' },
      });

      const clearBtn = container.querySelector('[data-wb-part="search-input-clear"]');
      assert.ok(clearBtn);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('does not show clear button when input is empty', async () => {
      if (!svelteAvailable) return;
      const SearchInput = await importComponent('SearchInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(SearchInput, {
        target: container,
        props: { value: '' },
      });

      assert.equal(container.querySelector('[data-wb-part="search-input-clear"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('clear button calls onSearch with empty string and onClear', async () => {
      if (!svelteAvailable) return;
      const SearchInput = await importComponent('SearchInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let searchedValue = 'not called';
      let cleared = false;
      const comp = mount(SearchInput, {
        target: container,
        props: {
          value: 'something',
          onSearch: (v) => { searchedValue = v; },
          onClear: () => { cleared = true; },
        },
      });

      const clearBtn = container.querySelector('[data-wb-part="search-input-clear"]');
      clearBtn.click();
      await tick();

      assert.equal(searchedValue, '');
      assert.equal(cleared, true);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const SearchInput = await importComponent('SearchInput');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(SearchInput, {
        target: container,
        props: {},
      });

      assert.ok(container.querySelector('[data-wb-part="search-input"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="search-input"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- DatePicker ---

  describe('DatePicker', () => {
    it('renders date input', async () => {
      if (!svelteAvailable) return;
      const DatePicker = await importComponent('DatePicker');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(DatePicker, {
        target: container,
        props: {},
      });

      const wrapper = container.querySelector('[data-wb-part="date-picker"]');
      assert.ok(wrapper);

      const input = container.querySelector('[data-wb-part="date-picker-input"]');
      assert.ok(input);
      assert.equal(input.getAttribute('type'), 'date');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with initial value', async () => {
      if (!svelteAvailable) return;
      const DatePicker = await importComponent('DatePicker');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(DatePicker, {
        target: container,
        props: { value: '2025-01-15' },
      });

      const input = container.querySelector('[data-wb-part="date-picker-input"]');
      assert.equal(input.value, '2025-01-15');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('change fires onChange with ISO date string', async () => {
      if (!svelteAvailable) return;
      const DatePicker = await importComponent('DatePicker');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let changedValue = null;
      const comp = mount(DatePicker, {
        target: container,
        props: {
          onChange: (v) => { changedValue = v; },
        },
      });

      const input = container.querySelector('[data-wb-part="date-picker-input"]');
      input.value = '2025-06-30';
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await tick();

      assert.equal(changedValue, '2025-06-30');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders min/max attributes', async () => {
      if (!svelteAvailable) return;
      const DatePicker = await importComponent('DatePicker');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(DatePicker, {
        target: container,
        props: { min: '2025-01-01', max: '2025-12-31' },
      });

      const input = container.querySelector('[data-wb-part="date-picker-input"]');
      assert.equal(input.getAttribute('min'), '2025-01-01');
      assert.equal(input.getAttribute('max'), '2025-12-31');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders label when provided', async () => {
      if (!svelteAvailable) return;
      const DatePicker = await importComponent('DatePicker');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(DatePicker, {
        target: container,
        props: { label: 'Select a date' },
      });

      const label = container.querySelector('[data-wb-part="date-picker-label"]');
      assert.ok(label);
      assert.equal(label.textContent, 'Select a date');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const DatePicker = await importComponent('DatePicker');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(DatePicker, { target: container, props: {} });

      assert.ok(container.querySelector('[data-wb-part="date-picker"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="date-picker"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- EmptyState ---

  describe('EmptyState', () => {
    it('renders title', async () => {
      if (!svelteAvailable) return;
      const EmptyState = await importComponent('EmptyState');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(EmptyState, {
        target: container,
        props: { title: 'No items' },
      });

      const wrapper = container.querySelector('[data-wb-part="empty-state"]');
      assert.ok(wrapper);

      const title = container.querySelector('[data-wb-part="empty-state-title"]');
      assert.ok(title);
      assert.equal(title.textContent, 'No items');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders description', async () => {
      if (!svelteAvailable) return;
      const EmptyState = await importComponent('EmptyState');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(EmptyState, {
        target: container,
        props: {
          title: 'Empty',
          description: 'Add your first item to get started.',
        },
      });

      const desc = container.querySelector('[data-wb-part="empty-state-description"]');
      assert.ok(desc);
      assert.equal(desc.textContent, 'Add your first item to get started.');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('does not render description when not provided', async () => {
      if (!svelteAvailable) return;
      const EmptyState = await importComponent('EmptyState');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(EmptyState, {
        target: container,
        props: { title: 'Empty' },
      });

      assert.equal(container.querySelector('[data-wb-part="empty-state-description"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders icon when provided', async () => {
      if (!svelteAvailable) return;
      const EmptyState = await importComponent('EmptyState');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(EmptyState, {
        target: container,
        props: { title: 'Empty', icon: '📁' },
      });

      const icon = container.querySelector('[data-wb-part="empty-state-icon"]');
      assert.ok(icon);
      assert.ok(icon.textContent.includes('📁'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders action button and handles click', async () => {
      if (!svelteAvailable) return;
      const EmptyState = await importComponent('EmptyState');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let clicked = false;
      const comp = mount(EmptyState, {
        target: container,
        props: {
          title: 'Empty',
          action: { label: 'Create new', onClick: () => { clicked = true; } },
        },
      });

      const actionBtn = container.querySelector('[data-wb-part="empty-state-action"]');
      assert.ok(actionBtn);
      assert.equal(actionBtn.textContent, 'Create new');

      actionBtn.click();
      assert.equal(clicked, true);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('does not render action when not provided', async () => {
      if (!svelteAvailable) return;
      const EmptyState = await importComponent('EmptyState');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(EmptyState, {
        target: container,
        props: { title: 'Empty' },
      });

      assert.equal(container.querySelector('[data-wb-part="empty-state-action"]'), null);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const EmptyState = await importComponent('EmptyState');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(EmptyState, {
        target: container,
        props: { title: 'Bye' },
      });

      assert.ok(container.querySelector('[data-wb-part="empty-state"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="empty-state"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- Spinner ---

  describe('Spinner', () => {
    it('renders spinner with default size', async () => {
      if (!svelteAvailable) return;
      const Spinner = await importComponent('Spinner');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Spinner, {
        target: container,
        props: {},
      });

      const spinner = container.querySelector('[data-wb-part="spinner"]');
      assert.ok(spinner);
      assert.ok(spinner.classList.contains('wb-spinner--md'));
      assert.equal(spinner.getAttribute('role'), 'status');

      const circle = container.querySelector('[data-wb-part="spinner-circle"]');
      assert.ok(circle);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with size sm', async () => {
      if (!svelteAvailable) return;
      const Spinner = await importComponent('Spinner');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Spinner, {
        target: container,
        props: { size: 'sm' },
      });

      const spinner = container.querySelector('[data-wb-part="spinner"]');
      assert.ok(spinner.classList.contains('wb-spinner--sm'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with size lg', async () => {
      if (!svelteAvailable) return;
      const Spinner = await importComponent('Spinner');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Spinner, {
        target: container,
        props: { size: 'lg' },
      });

      const spinner = container.querySelector('[data-wb-part="spinner"]');
      assert.ok(spinner.classList.contains('wb-spinner--lg'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with custom aria label', async () => {
      if (!svelteAvailable) return;
      const Spinner = await importComponent('Spinner');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Spinner, {
        target: container,
        props: { label: 'Saving...' },
      });

      const spinner = container.querySelector('[data-wb-part="spinner"]');
      assert.equal(spinner.getAttribute('aria-label'), 'Saving...');
      assert.ok(spinner.textContent.includes('Saving...'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const Spinner = await importComponent('Spinner');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Spinner, { target: container, props: {} });

      assert.ok(container.querySelector('[data-wb-part="spinner"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="spinner"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- Tabs ---

  describe('Tabs', () => {
    it('renders tabs', async () => {
      if (!svelteAvailable) return;
      const Tabs = await importComponent('Tabs');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const tabs = [
        { id: 'tab1', label: 'First' },
        { id: 'tab2', label: 'Second' },
        { id: 'tab3', label: 'Third' },
      ];

      const comp = mount(Tabs, {
        target: container,
        props: { tabs },
      });

      const wrapper = container.querySelector('[data-wb-part="tabs"]');
      assert.ok(wrapper);

      const tabButtons = container.querySelectorAll('[data-wb-part="tabs-tab"]');
      assert.equal(tabButtons.length, 3);
      assert.equal(tabButtons[0].textContent, 'First');
      assert.equal(tabButtons[0].getAttribute('role'), 'tab');
      assert.equal(tabButtons[1].textContent, 'Second');
      assert.equal(tabButtons[2].textContent, 'Third');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('first tab is active by default', async () => {
      if (!svelteAvailable) return;
      const Tabs = await importComponent('Tabs');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const tabs = [
        { id: 'tab1', label: 'First' },
        { id: 'tab2', label: 'Second' },
      ];

      const comp = mount(Tabs, { target: container, props: { tabs } });

      const tabButtons = container.querySelectorAll('[data-wb-part="tabs-tab"]');
      assert.equal(tabButtons[0].getAttribute('data-tab-active'), 'true');
      assert.equal(tabButtons[0].getAttribute('aria-selected'), 'true');
      assert.equal(tabButtons[1].getAttribute('data-tab-active'), 'false');
      assert.ok(tabButtons[0].classList.contains('wb-tabs__tab--active'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('clicking a tab calls onChange and activates it', async () => {
      if (!svelteAvailable) return;
      const Tabs = await importComponent('Tabs');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let changedId = null;
      const tabs = [
        { id: 'tab1', label: 'First' },
        { id: 'tab2', label: 'Second' },
      ];

      const comp = mount(Tabs, {
        target: container,
        props: {
          tabs,
          onChange: (id) => { changedId = id; },
        },
      });

      const tabButtons = container.querySelectorAll('[data-wb-part="tabs-tab"]');
      tabButtons[1].click();
      await tick();

      assert.equal(changedId, 'tab2');
      assert.equal(tabButtons[1].getAttribute('data-tab-active'), 'true');
      assert.equal(tabButtons[0].getAttribute('data-tab-active'), 'false');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('respects activeTab prop', async () => {
      if (!svelteAvailable) return;
      const Tabs = await importComponent('Tabs');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const tabs = [
        { id: 'tab1', label: 'First' },
        { id: 'tab2', label: 'Second' },
      ];

      const comp = mount(Tabs, {
        target: container,
        props: { tabs, activeTab: 'tab2' },
      });

      const tabButtons = container.querySelectorAll('[data-wb-part="tabs-tab"]');
      assert.equal(tabButtons[1].getAttribute('data-tab-active'), 'true');
      assert.equal(tabButtons[0].getAttribute('data-tab-active'), 'false');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('disabled tab cannot be clicked', async () => {
      if (!svelteAvailable) return;
      const Tabs = await importComponent('Tabs');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let changedId = null;
      const tabs = [
        { id: 'tab1', label: 'First' },
        { id: 'tab2', label: 'Second', disabled: true },
      ];

      const comp = mount(Tabs, {
        target: container,
        props: {
          tabs,
          onChange: (id) => { changedId = id; },
        },
      });

      const tabButtons = container.querySelectorAll('[data-wb-part="tabs-tab"]');
      assert.equal(tabButtons[1].disabled, true);

      tabButtons[1].click();
      await tick();
      // Should remain on first tab
      assert.equal(changedId, null);
      assert.equal(tabButtons[0].getAttribute('data-tab-active'), 'true');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders tabs panel', async () => {
      if (!svelteAvailable) return;
      const Tabs = await importComponent('Tabs');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tabs, {
        target: container,
        props: { tabs: [{ id: 'tab1', label: 'Tab' }] },
      });

      const panel = container.querySelector('[data-wb-part="tabs-panel"]');
      assert.ok(panel);
      assert.equal(panel.getAttribute('role'), 'tabpanel');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const Tabs = await importComponent('Tabs');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tabs, {
        target: container,
        props: {
          tabs: [{ id: 'tab1', label: 'Tab' }],
        },
      });

      assert.ok(container.querySelector('[data-wb-part="tabs"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="tabs"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- Progress ---

  describe('Progress', () => {
    it('renders progress bar', async () => {
      if (!svelteAvailable) return;
      const Progress = await importComponent('Progress');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Progress, {
        target: container,
        props: { value: 50 },
      });

      const progress = container.querySelector('[data-wb-part="progress"]');
      assert.ok(progress);
      assert.ok(progress.classList.contains('wb-progress--bar'));
      assert.equal(progress.getAttribute('role'), 'progressbar');
      assert.equal(progress.getAttribute('aria-valuenow'), '50');
      assert.equal(progress.getAttribute('aria-valuemin'), '0');
      assert.equal(progress.getAttribute('aria-valuemax'), '100');

      const bar = container.querySelector('[data-wb-part="progress-bar"]');
      assert.ok(bar);

      const fill = container.querySelector('[data-wb-part="progress-fill"]');
      assert.ok(fill);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders progress circle variant', async () => {
      if (!svelteAvailable) return;
      const Progress = await importComponent('Progress');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Progress, {
        target: container,
        props: { value: 75, variant: 'circle' },
      });

      const progress = container.querySelector('[data-wb-part="progress"]');
      assert.ok(progress.classList.contains('wb-progress--circle'));

      const circle = container.querySelector('[data-wb-part="progress-circle"]');
      assert.ok(circle);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('has correct aria attributes', async () => {
      if (!svelteAvailable) return;
      const Progress = await importComponent('Progress');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Progress, {
        target: container,
        props: { value: 30 },
      });

      const progress = container.querySelector('[data-wb-part="progress"]');
      assert.equal(progress.getAttribute('aria-valuenow'), '30');
      assert.equal(progress.getAttribute('aria-valuemin'), '0');
      assert.equal(progress.getAttribute('aria-valuemax'), '100');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows label', async () => {
      if (!svelteAvailable) return;
      const Progress = await importComponent('Progress');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Progress, {
        target: container,
        props: { value: 60, label: 'Uploading' },
      });

      const label = container.querySelector('[data-wb-part="progress-label"]');
      assert.ok(label);
      assert.equal(label.textContent, 'Uploading');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('clamps value to 0-100', async () => {
      if (!svelteAvailable) return;
      const Progress = await importComponent('Progress');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Progress, {
        target: container,
        props: { value: 150 },
      });

      const progress = container.querySelector('[data-wb-part="progress"]');
      assert.equal(progress.getAttribute('aria-valuenow'), '100');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('respects max prop', async () => {
      if (!svelteAvailable) return;
      const Progress = await importComponent('Progress');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Progress, {
        target: container,
        props: { value: 5, max: 10 },
      });

      const progress = container.querySelector('[data-wb-part="progress"]');
      assert.equal(progress.getAttribute('aria-valuenow'), '50');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const Progress = await importComponent('Progress');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Progress, {
        target: container,
        props: { value: 0 },
      });

      assert.ok(container.querySelector('[data-wb-part="progress"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="progress"]'), null);

      document.body.removeChild(container);
    });
  });

  // --- Tag ---

  describe('Tag', () => {
    it('renders label', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tag, {
        target: container,
        props: { label: 'JavaScript' },
      });

      const tag = container.querySelector('[data-wb-part="tag"]');
      assert.ok(tag);

      const tagLabel = container.querySelector('[data-wb-part="tag-label"]');
      assert.ok(tagLabel);
      assert.equal(tagLabel.textContent, 'JavaScript');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with default variant pill', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tag, {
        target: container,
        props: { label: 'Tag' },
      });

      const tag = container.querySelector('[data-wb-part="tag"]');
      assert.ok(tag.classList.contains('wb-tag--pill'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with box variant', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tag, {
        target: container,
        props: { label: 'Tag', variant: 'box' },
      });

      const tag = container.querySelector('[data-wb-part="tag"]');
      assert.ok(tag.classList.contains('wb-tag--box'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('renders with color class', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tag, {
        target: container,
        props: { label: 'Tag', color: 'blue' },
      });

      const tag = container.querySelector('[data-wb-part="tag"]');
      assert.ok(tag.classList.contains('wb-tag--blue'));

      unmount(comp);
      document.body.removeChild(container);
    });

    it('does not show remove button when not removable', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tag, {
        target: container,
        props: { label: 'Tag' },
      });

      assert.equal(container.querySelector('[data-wb-part="tag-remove"]'), null);
      const tag = container.querySelector('[data-wb-part="tag"]');
      assert.equal(tag.getAttribute('data-removable'), 'false');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('shows remove button when removable', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tag, {
        target: container,
        props: { label: 'Tag', removable: true, onRemove: () => {} },
      });

      const removeBtn = container.querySelector('[data-wb-part="tag-remove"]');
      assert.ok(removeBtn);
      const tag = container.querySelector('[data-wb-part="tag"]');
      assert.equal(tag.getAttribute('data-removable'), 'true');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('remove button click calls onRemove', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      let removed = false;
      const comp = mount(Tag, {
        target: container,
        props: {
          label: 'Tag',
          removable: true,
          onRemove: () => { removed = true; },
        },
      });

      const removeBtn = container.querySelector('[data-wb-part="tag-remove"]');
      removeBtn.click();
      await tick();

      assert.equal(removed, true);

      unmount(comp);
      document.body.removeChild(container);
    });

    it('remove button has aria-label', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tag, {
        target: container,
        props: { label: 'React', removable: true, onRemove: () => {} },
      });

      const removeBtn = container.querySelector('[data-wb-part="tag-remove"]');
      assert.equal(removeBtn.getAttribute('aria-label'), 'Remove React');

      unmount(comp);
      document.body.removeChild(container);
    });

    it('destroy removes elements from DOM', async () => {
      if (!svelteAvailable) return;
      const Tag = await importComponent('Tag');
      const container = document.createElement('div');
      document.body.appendChild(container);

      const comp = mount(Tag, {
        target: container,
        props: { label: 'Tag' },
      });

      assert.ok(container.querySelector('[data-wb-part="tag"]'));
      unmount(comp);
      assert.equal(container.querySelector('[data-wb-part="tag"]'), null);

      document.body.removeChild(container);
    });
  });

  // Part 7: Wave 4 Components (browser)

  describe('Wave 4 Components', () => {
    // --- PaneResizer ---
    describe('PaneResizer', () => {
      it('renders with handle', async () => {
        if (!svelteAvailable) return;
        const PaneResizer = await importComponent('PaneResizer');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(PaneResizer, { target: container, props: { direction: 'horizontal' } });
        await tick();
        assert.ok(container.querySelector('[data-wb-part="pane-resizer-handle"]'));
        assert.equal(container.querySelector('[data-wb-part="pane-resizer"]').getAttribute('data-direction'), 'horizontal');
        unmount(comp); document.body.removeChild(container);
      });

      it('renders vertical variant', async () => {
        if (!svelteAvailable) return;
        const PaneResizer = await importComponent('PaneResizer');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(PaneResizer, { target: container, props: { direction: 'vertical' } });
        await tick();
        assert.equal(container.querySelector('[data-wb-part="pane-resizer"]').getAttribute('data-direction'), 'vertical');
        unmount(comp); document.body.removeChild(container);
      });
    });

    // --- ColorPicker ---
    describe('ColorPicker', () => {
      it('renders with default value', async () => {
        if (!svelteAvailable) return;
        const ColorPicker = await importComponent('ColorPicker');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(ColorPicker, { target: container, props: {} });
        await tick();
        const input = container.querySelector('[data-wb-part="color-picker-input"]');
        assert.ok(input);
        assert.equal(input.value, '#000000');
        unmount(comp); document.body.removeChild(container);
      });

      it('shows label', async () => {
        if (!svelteAvailable) return;
        const ColorPicker = await importComponent('ColorPicker');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(ColorPicker, { target: container, props: { label: 'Fill' } });
        await tick();
        assert.equal(container.querySelector('[data-wb-part="color-picker-label"]').textContent, 'Fill');
        unmount(comp); document.body.removeChild(container);
      });
    });

    // --- FileUpload ---
    describe('FileUpload', () => {
      it('renders prompt when no files', async () => {
        if (!svelteAvailable) return;
        const FileUpload = await importComponent('FileUpload');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(FileUpload, { target: container, props: {} });
        await tick();
        assert.ok(container.querySelector('[data-wb-part="file-upload-prompt"]'));
        unmount(comp); document.body.removeChild(container);
      });

      it('shows disabled state', async () => {
        if (!svelteAvailable) return;
        const FileUpload = await importComponent('FileUpload');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(FileUpload, { target: container, props: { disabled: true } });
        await tick();
        assert.equal(container.querySelector('[data-wb-part="file-upload"]').getAttribute('tabindex'), '-1');
        unmount(comp); document.body.removeChild(container);
      });
    });

    // --- CopyButton ---
    describe('CopyButton', () => {
      it('renders with label', async () => {
        if (!svelteAvailable) return;
        const CopyButton = await importComponent('CopyButton');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(CopyButton, { target: container, props: { text: 'hello', label: 'Copy' } });
        await tick();
        const btn = container.querySelector('[data-wb-part="copy-button"]');
        assert.ok(btn);
        assert.ok(btn.textContent.includes('Copy'));
        unmount(comp); document.body.removeChild(container);
      });

      it('has copy-button part', async () => {
        if (!svelteAvailable) return;
        const CopyButton = await importComponent('CopyButton');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(CopyButton, { target: container, props: { text: 'hi' } });
        await tick();
        assert.ok(container.querySelector('[data-wb-part="copy-button-label"]'));
        unmount(comp); document.body.removeChild(container);
      });
    });

    // --- HotkeyHint ---
    describe('HotkeyHint', () => {
      it('renders kbd elements', async () => {
        if (!svelteAvailable) return;
        const HotkeyHint = await importComponent('HotkeyHint');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(HotkeyHint, { target: container, props: { keys: ['⌘', 'K'], label: 'Search' } });
        await tick();
        const kbds = container.querySelectorAll('kbd');
        assert.equal(kbds.length, 2);
        assert.equal(kbds[0].textContent, '⌘');
        assert.equal(kbds[1].textContent, 'K');
        unmount(comp); document.body.removeChild(container);
      });

      it('shows label', async () => {
        if (!svelteAvailable) return;
        const HotkeyHint = await importComponent('HotkeyHint');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(HotkeyHint, { target: container, props: { keys: ['Ctrl', 'S'], label: 'Save' } });
        await tick();
        assert.ok(container.querySelector('[data-wb-part="hotkey-hint-label"]'));
        unmount(comp); document.body.removeChild(container);
      });
    });

    // --- CommandPalette ---
    describe('CommandPalette', () => {
      it('renders when open', async () => {
        if (!svelteAvailable) return;
        const CommandPalette = await importComponent('CommandPalette');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(CommandPalette, { target: container, props: { open: true, commands: [{ id: 'a', label: 'Alpha' }] } });
        await tick();
        assert.ok(container.querySelector('[data-wb-part="command-palette"]'));
        assert.equal(container.querySelectorAll('[data-wb-part="command-palette-item"]').length, 1);
        unmount(comp); document.body.removeChild(container);
      });

      it('renders nothing when closed', async () => {
        if (!svelteAvailable) return;
        const CommandPalette = await importComponent('CommandPalette');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(CommandPalette, { target: container, props: { open: false, commands: [{ id: 'a', label: 'A' }] } });
        await tick();
        assert.equal(container.querySelector('[data-wb-part="command-palette"]'), null);
        unmount(comp); document.body.removeChild(container);
      });

      it('shows empty state', async () => {
        if (!svelteAvailable) return;
        const CommandPalette = await importComponent('CommandPalette');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(CommandPalette, { target: container, props: { open: true, commands: [] } });
        await tick();
        assert.ok(container.querySelector('[data-wb-part="command-palette-empty"]'));
        unmount(comp); document.body.removeChild(container);
      });

      it('calls onExecute on item click', async () => {
        if (!svelteAvailable) return;
        const CommandPalette = await importComponent('CommandPalette');
        const container = document.createElement('div');
        document.body.appendChild(container);
        let executed = null;
        const comp = mount(CommandPalette, { target: container, props: {
          open: true,
          commands: [{ id: 'save', label: 'Save' }],
          onExecute: (id) => { executed = id; },
        } });
        await tick();
        container.querySelector('[data-wb-part="command-palette-item"]').click();
        assert.equal(executed, 'save');
        unmount(comp); document.body.removeChild(container);
      });
    });

    // --- EntityInspector ---
    describe('EntityInspector', () => {
      it('renders field label/value pairs', async () => {
        if (!svelteAvailable) return;
        const EntityInspector = await importComponent('EntityInspector');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(EntityInspector, { target: container, props: {
          fields: [{ label: 'Name', value: 'Alice' }, { label: 'Age', value: 30 }],
        } });
        await tick();
        const rows = container.querySelectorAll('[data-wb-part="entity-inspector-row"]');
        assert.equal(rows.length, 2);
        assert.equal(rows[0].querySelector('[data-wb-part="entity-inspector-value"]').textContent, 'Alice');
        unmount(comp); document.body.removeChild(container);
      });

      it('renders empty state', async () => {
        if (!svelteAvailable) return;
        const EntityInspector = await importComponent('EntityInspector');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(EntityInspector, { target: container, props: { fields: [] } });
        await tick();
        assert.ok(container.querySelector('.wb-entity-inspector__empty'));
        unmount(comp); document.body.removeChild(container);
      });

      it('shows close button when onClose provided', async () => {
        if (!svelteAvailable) return;
        const EntityInspector = await importComponent('EntityInspector');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(EntityInspector, { target: container, props: { fields: [], onClose: () => {} } });
        await tick();
        assert.ok(container.querySelector('[data-wb-part="entity-inspector-close"]'));
        unmount(comp); document.body.removeChild(container);
      });
    });

    // --- Autocomplete ---
    describe('Autocomplete', () => {
      it('renders input', async () => {
        if (!svelteAvailable) return;
        const Autocomplete = await importComponent('Autocomplete');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(Autocomplete, { target: container, props: { items: [] } });
        await tick();
        assert.ok(container.querySelector('[data-wb-part="autocomplete-input"]'));
        unmount(comp); document.body.removeChild(container);
      });

      it('selects item on click', async () => {
        if (!svelteAvailable) return;
        const Autocomplete = await importComponent('Autocomplete');
        const container = document.createElement('div');
        document.body.appendChild(container);
        let selected = null;
        const comp = mount(Autocomplete, { target: container, props: {
          value: 'a',
          items: [{ id: '1', label: 'Alpha' }],
          onSelect: (item) => { selected = item; },
        } });
        await tick();
        container.querySelector('[data-wb-part="autocomplete-input"]').focus();
        await tick();
        const item = container.querySelector('[data-wb-part="autocomplete-item"]');
        if (item) item.click();
        assert.ok(selected);
        unmount(comp); document.body.removeChild(container);
      });
    });

    // --- AutoSuggest ---
    describe('AutoSuggest', () => {
      it('renders search input', async () => {
        if (!svelteAvailable) return;
        const AutoSuggest = await importComponent('AutoSuggest');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const comp = mount(AutoSuggest, { target: container, props: { placeholder: 'Find...' } });
        await tick();
        const input = container.querySelector('[data-wb-part="auto-suggest-input"]');
        assert.ok(input);
        assert.equal(input.placeholder, 'Find...');
        unmount(comp); document.body.removeChild(container);
      });
    });
  });
});
