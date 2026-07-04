import { parseEventType } from './event-handle.mjs';

export function createBlobLifecycle({ blobs, entities }) {
  if (!blobs) return { blobAdapter: undefined, blobFinalizeConsumer: null, blobColumns: [] };

  const blobFields = new Map();
  const blobColumns = [];
  for (const [name, ent] of entities) {
    const fields = [];
    for (const [fname, descriptor] of Object.entries(ent.fields ?? {})) {
      if (descriptor && descriptor.blob === true) fields.push(fname);
    }
    if (fields.length > 0) {
      blobFields.set(name, fields);
      for (const fieldName of fields) blobColumns.push({ table: name, column: fieldName });
    }
  }

  if (blobFields.size === 0) return { blobAdapter: undefined, blobFinalizeConsumer: null, blobColumns };

  const resolveBlobIds = (event) => {
    const entityName = event.handle?.brand === 'event-handle'
      ? event.handle.entity
      : (() => { try { return parseEventType(event.type).entity; } catch { return ''; } })();
    const fields = blobFields.get(entityName) ?? [];
    const ids = [];
    for (const fieldName of fields) {
      const value = event.data?.[fieldName];
      if (value) ids.push(value);
    }
    return ids;
  };

  const blobAdapter = {
    async adoptInTxn(txnDb, events) {
      const blobIds = new Set();
      for (const event of events) for (const id of resolveBlobIds(event)) blobIds.add(id);
      for (const id of blobIds) blobs.adopt(txnDb, id);
    },
  };

  const blobFinalizeConsumer = async (events) => {
    const ids = new Set();
    for (const event of events) for (const id of resolveBlobIds(event)) ids.add(id);
    for (const id of ids) {
      try { blobs.finalize(id); } catch {}
    }
  };

  return { blobAdapter, blobFinalizeConsumer, blobColumns };
}
