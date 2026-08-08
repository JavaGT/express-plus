import { txn } from './driver.ts';
import type { DbHandle } from './driver.ts';
import { isPrincipalSnapshotDeclaration, type PrincipalSnapshotDeclaration } from './principal-snapshot-declaration.ts';

export interface PrincipalSnapshotRecipient {
  type: string;
  id: string;
}

export interface PrincipalSnapshotTx {
  db: DbHandle;
  invalidate(declaration: PrincipalSnapshotDeclaration, recipient: PrincipalSnapshotRecipient): void;
}

export type PrincipalSnapshotWakeHook = (
  declaration: PrincipalSnapshotDeclaration,
  principal: PrincipalSnapshotRecipient,
) => void;

export interface PrincipalSnapshotTransaction {
  transaction(callback: (tx: PrincipalSnapshotTx) => unknown): Promise<unknown>;
  _registerDeclaration(declaration: PrincipalSnapshotDeclaration): void;
  _setWakeHook(hook: PrincipalSnapshotWakeHook | null): void;
  _registeredDeclarations: Map<string, PrincipalSnapshotDeclaration>;
}

interface PrincipalSnapshotInvalidation {
  declaration: PrincipalSnapshotDeclaration;
  recipientType: string;
  recipientId: string;
}

interface PrincipalSnapshotApp {
  db: DbHandle | null | undefined;
  _principalSnapshotTxActive?: boolean | undefined;
  writeQueue: { run<T>(fn: () => Promise<T> | T): Promise<T> };
}

export function createPrincipalSnapshotTransaction(app: PrincipalSnapshotApp): PrincipalSnapshotTransaction {
  const registeredDeclarations = new Map<string, PrincipalSnapshotDeclaration>();
  let wakeHook: PrincipalSnapshotWakeHook | null = null;

  function registerDeclaration(declaration: PrincipalSnapshotDeclaration) {
    if (!isPrincipalSnapshotDeclaration(declaration)) {
      throw new Error('Only principal snapshot declarations can be registered');
    }
    if (registeredDeclarations.has(declaration.name)) {
      throw new Error(`Principal snapshot declaration '${declaration.name}' is already registered`);
    }
    registeredDeclarations.set(declaration.name, declaration);
  }

  function setWakeHook(hook: PrincipalSnapshotWakeHook | null) {
    wakeHook = hook;
  }

  function transaction(callback: (tx: PrincipalSnapshotTx) => unknown): Promise<unknown> {
    if (typeof callback !== 'function') {
      return Promise.reject(new TypeError('principalSnapshots.transaction requires a synchronous callback function'));
    }
    const db = app.db;
    if (!db) {
      return Promise.reject(new Error('principalSnapshots.transaction requires a database (app.db)'));
    }
    if (app._principalSnapshotTxActive) {
      return Promise.reject(new Error('nested principalSnapshots.transaction is not allowed'));
    }

    return app.writeQueue.run(async () => {
      app._principalSnapshotTxActive = true;
      let committed = false;
      let result: unknown;
      let invalidations: Map<string, PrincipalSnapshotInvalidation> | undefined;
      try {
        result = await txn(db, async () => {
          invalidations = new Map();
          const { tx, expire } = createTxObject(db, invalidations, registeredDeclarations);

          let cbResult: unknown;
          try {
            cbResult = callback(tx);
          } finally {
            expire();
          }

          const checked = cbResult as { then?: unknown } | null | undefined;
          if (checked !== null && checked !== undefined && (typeof checked === 'object' || typeof checked === 'function') && typeof checked.then === 'function') {
            throw new TypeError('principalSnapshots.transaction callback must not return a Promise; synchronous only');
          }

          for (const [, inv] of invalidations) {
            const { declaration, recipientType, recipientId } = inv;
            db.prepare(
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

function createTxObject(
  db: DbHandle,
  invalidations: Map<string, PrincipalSnapshotInvalidation>,
  registeredDeclarations: Map<string, PrincipalSnapshotDeclaration>,
): { tx: PrincipalSnapshotTx; expire(): void } {
  const state = { expired: false };
  const tx: PrincipalSnapshotTx = {
    db,
    invalidate(declaration: PrincipalSnapshotDeclaration, recipient: PrincipalSnapshotRecipient) {
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
