const STORE_NAME = 'entries';
const DB_VERSION = 2;

// Outbox rows (#183) live in this SAME entries store — no second IndexedDB
// store. They carry `log: OUTBOX_LOG`, no `seq` (they are not committed
// events, so the byScope event index excludes them), and are ordered by the
// auto-increment primary key: insertion order is the durable queue order.
export const OUTBOX_LOG = 'outbox';

function _openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`workbench:local:${name}`, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? event.target.transaction.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      if (!store.indexNames.contains('byScope')) {
        store.createIndex('byScope', ['scope', 'seq']);
      }
      if (!store.indexNames.contains('byTimestamp')) {
        store.createIndex('byTimestamp', 'timestamp');
      }
      if (!store.indexNames.contains('byOutboxId')) {
        store.createIndex('byOutboxId', ['log', 'id']);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openLocalLog(name) {
  const db = await _openDb(name);

  async function append(entry) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readwrite');
      const store = txn.objectStore(STORE_NAME);
      const req = store.add(entry);
      req.onsuccess = () => {
        resolve({ id: req.result, ...entry });
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function entriesSince(scope, cursor) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readonly');
      const store = txn.objectStore(STORE_NAME);
      const index = store.index('byScope');
      const range = IDBKeyRange.lowerBound([scope, cursor + 1]);
      const entries = [];

      index.openCursor(range).onsuccess = (event) => {
        const c = event.target.result;
        if (!c) { resolve(entries); return; }
        if (c.value.scope !== scope) { resolve(entries); return; }
        entries.push(c.value);
        c.continue();
      };
      index.openCursor(range).onerror = () => reject(index.openCursor(range).error);
    });
  }

  async function head(scope) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readonly');
      const store = txn.objectStore(STORE_NAME);
      const index = store.index('byScope');
      const range = IDBKeyRange.bound([scope, 0], [scope, Number.MAX_SAFE_INTEGER]);
      const req = index.openCursor(range, 'prev');
      req.onsuccess = (event) => {
        const c = event.target.result;
        resolve(c ? c.value.seq : 0);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function prune(beforeTimestamp) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readwrite');
      const store = txn.objectStore(STORE_NAME);
      const index = store.index('byTimestamp');
      const range = IDBKeyRange.upperBound(beforeTimestamp - 1, true);
      let count = 0;
      index.openCursor(range).onsuccess = (event) => {
        const c = event.target.result;
        if (!c) { resolve(count); return; }
        // Pending outbox rows are live client mutations, not history — a
        // timestamp prune must never drop a mutation that has not committed.
        if (c.value.log === OUTBOX_LOG) { c.continue(); return; }
        store.delete(c.primaryKey);
        count++;
        c.continue();
      };
      index.openCursor(range).onerror = () => reject(index.openCursor(range).error);
    });
  }

  // --- Outbox rows (durable client-mutation queue; same entries store) ---

  async function outboxAppend(entry) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readwrite');
      const store = txn.objectStore(STORE_NAME);
      const req = store.add({ ...entry, log: OUTBOX_LOG });
      req.onsuccess = () => {
        resolve({ id: req.result, ...entry, log: OUTBOX_LOG });
      };
      req.onerror = () => reject(req.error);
    });
  }

  // All outbox rows in enqueue order (primary key), optionally after a row id.
  async function outboxEntries(afterId = 0) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readonly');
      const store = txn.objectStore(STORE_NAME);
      const index = store.index('byOutboxId');
      const range = afterId > 0
        ? IDBKeyRange.lowerBound([OUTBOX_LOG, afterId], true)
        : IDBKeyRange.lowerBound([OUTBOX_LOG, 0]);
      const rows = [];
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = (event) => {
        const c = event.target.result;
        if (!c) { resolve(rows); return; }
        rows.push(c.value);
        c.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async function outboxGet(id) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readonly');
      const req = txn.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function outboxPut(row) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readwrite');
      const req = txn.objectStore(STORE_NAME).put({ ...row, log: OUTBOX_LOG });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function outboxDelete(id) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([STORE_NAME], 'readwrite');
      const req = txn.objectStore(STORE_NAME).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  function close() {
    db.close();
  }

  return { append, entriesSince, head, prune, outboxAppend, outboxEntries, outboxGet, outboxPut, outboxDelete, close };
}
