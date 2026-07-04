const STORE_NAME = 'entries';

function _openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`workbench:local:${name}`, 1);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byScope', ['scope', 'seq']);
        store.createIndex('byTimestamp', 'timestamp');
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
        store.delete(c.primaryKey);
        count++;
        c.continue();
      };
      index.openCursor(range).onerror = () => reject(index.openCursor(range).error);
    });
  }

  function close() {
    db.close();
  }

  return { append, entriesSince, head, prune, close };
}
