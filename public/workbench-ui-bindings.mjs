// workbench-ui-bindings.mjs — framework-agnostic binding helpers.
//
// Three bindings that project the live store into reactive handles:
//   bindAction — CRUD action dispatch with status lifecycle
//   bindField  — single field value sync
//   bindList   — LiveList sub-collection projection
//
// These are plain JS handles, NOT Svelte stores. Svelte components call
// .subscribe() and update their own $state() runes.

// ---------------------------------------------------------------------------
// bindAction(store, { id, action, payload, onStatusChange })
// ---------------------------------------------------------------------------
//
// Binds a CRUD action (create/update/remove) on a store entity row.
// Status lifecycle: idle → pending → confirmed | failed.
// `payload` is a factory function (() => payloadObj) called at dispatch time.
//
// Exposes:
//   status    — 'idle' | 'pending' | 'confirmed' | 'failed'
//   error     — error message when status === 'failed' (null otherwise)
//   row       — the current row from overlayFor(id) (optimistic or confirmed)
//   dispatch()— fires the action, returns the dispatch Result
//   subscribe(cb) — calls cb({ status, error, row }) on every change, returns unsub
//   destroy() — tears down subscriptions

export function bindAction(store, { id, action, payload, onStatusChange } = {}) {
  let _status = 'idle';
  let _error = null;
  let _storeUnsub = null;
  const _callbacks = new Set();

  function _deriveRow() {
    return store.overlayFor(id);
  }

  function _notify() {
    const state = { status: _status, error: _error, row: _deriveRow() };
    for (const cb of _callbacks) {
      try { cb(state); } catch { /* swallow */ }
    }
    if (onStatusChange) {
      try { onStatusChange(_status); } catch { /* swallow */ }
    }
  }

  const handle = {
    get status() { return _status; },
    get error() { return _error; },
    get row() { return _deriveRow(); },

    async dispatch() {
      _status = 'pending';
      _error = null;
      _notify();

      let result;
      try {
        result = await store.dispatch(action, typeof payload === 'function' ? payload() : payload);
      } catch (err) {
        // dispatch should never throw, but guard anyway
        result = { ok: false, status: 'failed-rolled-back', error: err.message ?? String(err) };
      }

      if (result.ok) {
        _status = 'confirmed';
      } else {
        _status = 'failed';
        _error = result.error ?? 'dispatch failed';
      }
      _notify();
      return result;
    },

    subscribe(callback) {
      _callbacks.add(callback);
      if (!_storeUnsub) {
        _storeUnsub = store.onRender(() => _notify());
      }
      // Call immediately with current state so the subscriber sees the
      // latest value without waiting for the next render.
      callback({ status: _status, error: _error, row: _deriveRow() });
      return () => {
        _callbacks.delete(callback);
        if (_callbacks.size === 0 && _storeUnsub) {
          _storeUnsub();
          _storeUnsub = null;
        }
      };
    },

    destroy() {
      if (_storeUnsub) {
        _storeUnsub();
        _storeUnsub = null;
      }
      _callbacks.clear();
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// bindField(store, { id, field, onValueChange })
// ---------------------------------------------------------------------------
//
// Binds a text/value field on an entity row. Dispatches update actions on
// value change.
//
// Exposes:
//   value     — current field value from overlayFor(id)[field] or live state
//   status    — 'idle' | 'pending' | 'confirmed' | 'failed'
//   error     — error message when failed (null otherwise)
//   update(newValue) — dispatches store.update(id, { [field]: newValue })
//   subscribe(cb)    — calls cb({ value, status, error }) on every change, returns unsub
//   destroy() — tears down subscriptions

export function bindField(store, { id, field, onValueChange } = {}) {
  let _status = 'idle';
  let _error = null;
  let _storeUnsub = null;
  const _callbacks = new Set();

  function _deriveValue() {
    const row = store.overlayFor(id);
    if (row && typeof row === 'object' && field in row) {
      return row[field];
    }
    return undefined;
  }

  function _notify() {
    const value = _deriveValue();
    const state = { value, status: _status, error: _error };
    for (const cb of _callbacks) {
      try { cb(state); } catch { /* swallow */ }
    }
    if (onValueChange) {
      try { onValueChange(value); } catch { /* swallow */ }
    }
  }

  const handle = {
    get value() { return _deriveValue(); },
    get status() { return _status; },
    get error() { return _error; },

    async update(newValue) {
      _status = 'pending';
      _error = null;
      _notify();

      let result;
      try {
        result = await store.update(id, { [field]: newValue });
      } catch (err) {
        result = { ok: false, status: 'failed-rolled-back', error: err.message ?? String(err) };
      }

      if (result.ok) {
        _status = 'confirmed';
      } else {
        _status = 'failed';
        _error = result.error ?? 'update failed';
      }
      _notify();
      return result;
    },

    subscribe(callback) {
      _callbacks.add(callback);
      if (!_storeUnsub) {
        _storeUnsub = store.onRender(() => _notify());
      }
      callback({ value: _deriveValue(), status: _status, error: _error });
      return () => {
        _callbacks.delete(callback);
        if (_callbacks.size === 0 && _storeUnsub) {
          _storeUnsub();
          _storeUnsub = null;
        }
      };
    },

    destroy() {
      if (_storeUnsub) {
        _storeUnsub();
        _storeUnsub = null;
      }
      _callbacks.clear();
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// bindList(store, { id, field, onItemsChange })
// ---------------------------------------------------------------------------
//
// Binds to a LiveList sub-collection field (ordered list). Subscribes to
// the list and combines committed items from list.state[field] with pending
// create overlays from store.pendingCreates().
//
// Exposes:
//   items     — array of { key, row, status } (status: 'committed' | 'pending')
//   ready     — promise that resolves when the LiveList bootstrap completes
//   subscribe(cb) — calls cb(items[]) on every change, returns unsub
//   destroy() — tears down subscriptions + LiveList

export function bindList(store, { id, field, onItemsChange } = {}) {
  const list = store.subscribe(id, { fields: { [field]: true } });
  let _listUnsub = null;
  let _storeUnsub = null;
  const _callbacks = new Set();

  function _getItems() {
    const stateItems = (list.state && list.state[field] && Array.isArray(list.state[field]))
      ? list.state[field]
      : [];

    const items = stateItems.map((row, index) => ({
      key: (row && typeof row === 'object' && 'id' in row)
        ? String(row.id)
        : `item_${index}`,
      row,
      status: 'committed',
    }));

    // Append pending creates. The store's pendingCreates() returns overlay
    // entries with `kind === 'create'` and `status === 'pending'`.
    // We project them as overlay entries; they are NOT inserted into list.state.
    const pending = store.pendingCreates();
    for (const p of pending) {
      if (p.optimistic) {
        items.push({
          key: p.opId,
          row: p.optimistic,
          status: 'pending',
        });
      }
    }

    return items;
  }

  function _notify() {
    const items = _getItems();
    for (const cb of _callbacks) {
      try { cb(items); } catch { /* swallow */ }
    }
    if (onItemsChange) {
      try { onItemsChange(items); } catch { /* swallow */ }
    }
  }

  const handle = {
    get items() { return _getItems(); },
    get ready() { return list.ready; },

    subscribe(callback) {
      _callbacks.add(callback);
      if (!_listUnsub) {
        _listUnsub = list.onRender(() => _notify());
      }
      if (!_storeUnsub) {
        // Also subscribe to store-level renders to catch overlay changes
        // (pendingCreates appear/disappear via dispatch → _storeRender).
        _storeUnsub = store.onRender(() => _notify());
      }
      callback(_getItems());
      return () => {
        _callbacks.delete(callback);
        if (_callbacks.size === 0) {
          if (_listUnsub) { _listUnsub(); _listUnsub = null; }
          if (_storeUnsub) { _storeUnsub(); _storeUnsub = null; }
        }
      };
    },

    destroy() {
      if (_listUnsub) { _listUnsub(); _listUnsub = null; }
      if (_storeUnsub) { _storeUnsub(); _storeUnsub = null; }
      _callbacks.clear();
    },
  };

  return handle;
}
