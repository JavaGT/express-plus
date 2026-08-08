// @ts-nocheck
import { txn } from './driver.ts';
import { isPrincipalSnapshotDeclaration } from './principal-snapshot-declaration.ts';

export function createPrincipalSnapshotTransaction(app) {
  const registeredDeclarations = new Map();
  let wakeHook = null;

  function registerDeclaration(declaration) {
    if (!isPrincipalSnapshotDeclaration(declaration)) {
      throw new Error('Only principal snapshot declarations can be registered');
    }
    if (registeredDeclarations.has(declaration.name)) {
      throw new Error(`Principal snapshot declaration '${declaration.name}' is already registered`);
    }
    registeredDeclarations.set(declaration.name, declaration);
  }

  function setWakeHook(hook) {
    wakeHook = hook;
  }

  function transaction(callback) {
    if (typeof callback !== 'function') {
      return Promise.reject(new TypeError('principalSnapshots.transaction requires a synchronous callback function'));
    }
    if (!app.db) {
      return Promise.reject(new Error('principalSnapshots.transaction requires a database (app.db)'));
    }
    if (app._principalSnapshotTxActive) {
      return Promise.reject(new Error('nested principalSnapshots.transaction is not allowed'));
    }

    return app.writeQueue.run(async () => {
      app._principalSnapshotTxActive = true;
      let committed = false;
      let result;
      let invalidations;
      try {
        result = await txn(app.db, async () => {
          invalidations = new Map();
          const { tx, expire } = createTxObject(app.db, invalidations, registeredDeclarations);

          let cbResult;
          try {
            cbResult = callback(tx);
          } finally {
            expire();
          }

          if (cbResult !== null && cbResult !== undefined && (typeof cbResult === 'object' || typeof cbResult === 'function') && typeof cbResult.then === 'function') {
            throw new TypeError('principalSnapshots.transaction callback must not return a Promise; synchronous only');
          }

          for (const [, inv] of invalidations) {
            const { declaration, recipientType, recipientId } = inv;
            app.db.prepare(
              `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
               ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`
            ).run(declaration.name, recipientType, recipientId);
          }

          committed = true;
          return cbResult;
        });
      } finally {
        app._principalSnapshotTxActive = false;
      }

      if (committed && wakeHook && invalidations) {
        try {
          for (const [, inv] of invalidations) {
            wakeHook(inv.declaration, { type: inv.recipientType, id: inv.recipientId });
          }
        } catch {
          // wake failure must not change committed transaction result
        }
      }

      return result;
    });
  }

  return {
    transaction,
    _registerDeclaration: registerDeclaration,
    _setWakeHook: setWakeHook,
    _registeredDeclarations: registeredDeclarations,
  };
}

function createTxObject(db, invalidations, registeredDeclarations) {
  const state = { expired: false };
  const tx = {
    db,
    invalidate(declaration, recipient) {
      if (state.expired) {
        throw new Error('cannot invalidate after transaction callback returns');
      }
      if (!isPrincipalSnapshotDeclaration(declaration)) {
        throw new Error('invalid declaration: not a valid principal snapshot declaration');
      }
      const registered = registeredDeclarations.get(declaration.name);
      if (!registered) {
        throw new Error(`declaration '${declaration.name}' is not registered with this application`);
      }
      if (registered !== declaration) {
        throw new Error(`declaration '${declaration.name}' from another source is not registered with this application`);
      }
      if (declaration.principalType !== recipient.type) {
        throw new Error(`recipient type '${recipient.type}' does not match declaration principal type '${declaration.principalType}'`);
      }
      if (typeof recipient.id !== 'string' || recipient.id.length === 0) {
        throw new Error('recipient id must be a non-empty string');
      }
      const key = `${declaration.name}\0${recipient.type}\0${recipient.id}`;
      invalidations.set(key, { declaration, recipientType: recipient.type, recipientId: recipient.id });
    },
  };
  return {
    tx,
    expire() { state.expired = true; },
  };
}
