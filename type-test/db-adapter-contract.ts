// Type-level contract for the db adapter module (epic scope#23, S1/A1). The
// adapter types are internal-only (not on any public package export), so the
// assertions import the underlying `.ts` modules directly — mirroring
// grammar-internal.ts. `pnpm typecheck` compiles this file; the runtime
// normalizer behavior is pinned by test/db-adapter-contract.test.mjs.
//
// Positive cases assert the shapes; `@ts-expect-error` cases pin that the
// config never carries a physical filename and encryption is permanently off.

import { type DbHandle } from '../src/driver.ts';
import {
  capabilitiesOf,
  type DbAdapter,
  type DbAdapterConfig,
  type DbAdapterOptions,
  type DbCapabilities,
  type IntegrityReport,
  type OpenedDatabase,
  type ReadMirrorDescription,
} from '../src/db-adapter.ts';

// ── OpenedDatabase.handle is structurally the driver's DbHandle ─────────

declare const opened: OpenedDatabase;
// The adapter's handle field satisfies the sync single-writer DbHandle contract.
const handleFromAdapter: DbHandle = opened.handle;
// A driver DbHandle satisfies the adapter's handle field (structural both ways).
declare const driverHandle: DbHandle;
const openedFromDriver: OpenedDatabase = {
  handle: driverHandle,
  capabilities: capabilitiesOf({ transactionalDdl: true, integrityCheck: true }),
  close() {},
  checkpoint() {},
  integrityCheck() {
    const report: IntegrityReport = { ok: true, checkedAt: new Date().toISOString(), findings: [] };
    return report;
  },
};
void [handleFromAdapter, openedFromDriver];

// ── Config is logical: directory + name, never a physical filename ──────

const fileConfig: DbAdapterConfig = { directory: '/data', name: 'app', mode: 'file' };
const memoryConfig: DbAdapterConfig = { mode: 'memory' };
// Backend-specific options stay legal as long as they carry no path key.
const typedOptionsConfig: DbAdapterConfig<{ wal: boolean; journalMode?: 'wal' | 'delete' }> = {
  directory: '/data',
  name: 'app',
  options: { wal: true },
};
void [fileConfig, memoryConfig, typedOptionsConfig];
// @ts-expect-error a config never carries a physical database filename
const filenameConfig: DbAdapterConfig = { directory: '/data', name: 'app', filename: '/data/app.db' };
// @ts-expect-error a config never exposes a file path
const pathConfig: DbAdapterConfig = { directory: '/data', name: 'app', path: '/data/app.db' };
// @ts-expect-error the options type argument cannot smuggle a physical filename
const genericFilenameOptions: DbAdapterConfig<{ filename: string }> = { directory: '/data' };
// @ts-expect-error the options type argument cannot smuggle a file path
const genericPathOptions: DbAdapterConfig<{ path: string }> = { directory: '/data' };
// @ts-expect-error the options type argument cannot smuggle a file key
const genericFileOptions: DbAdapterConfig<{ file: string }> = { directory: '/data' };
// @ts-expect-error the options property itself refuses a physical path key
const inlineFilenameOptions: DbAdapterConfig = { directory: '/data', name: 'app', options: { filename: '/data/app.db' } };
void [filenameConfig, pathConfig, genericFilenameOptions, genericPathOptions, genericFileOptions, inlineFilenameOptions];

// ── Capabilities are closed; encryption is permanently false ────────────

const literalCaps: DbCapabilities = {
  transactionalDdl: true,
  onlineBackup: false,
  readOnlyConnections: true,
  integrityCheck: true,
  maintenance: false,
  encryption: false,
};
// @ts-expect-error the capability set is closed: no undeclared flags
const extraFlagCaps: DbCapabilities = { ...literalCaps, encryption: false, snapshotting: true };
// @ts-expect-error encryption is permanently false in this release
const enabledEncryption: DbCapabilities = { ...literalCaps, encryption: true };
// @ts-expect-error a plain boolean cannot widen the literal false
const widenedEncryption: DbCapabilities['encryption'] = true;
const caps: DbCapabilities = capabilitiesOf({ readOnlyConnections: true });
const encryptionIsFalse: false = caps.encryption;
// @ts-expect-error encryption is not a declarable capability flag
capabilitiesOf({ encryption: true });
void [extraFlagCaps, enabledEncryption, widenedEncryption, caps, encryptionIsFalse];

// ── The adapter surface ─────────────────────────────────────────────────

declare const adapter: DbAdapter;
const openedByAdapter: Promise<OpenedDatabase> = adapter.open({ directory: '/data', name: 'app' });
const readMirror: ReadMirrorDescription = adapter.readMirror();
const mirrorIsReadOnly: true = readMirror.readOnly;
const mirrorModeIsReadOnly: 'read-only' = readMirror.mode;
const mirrorOptions: DbAdapterOptions | undefined = readMirror.options;
// @ts-expect-error a read mirror carries no write authority
adapter.readMirror().write;
// @ts-expect-error a read mirror is always read-only: no writable mode literal
const writableMirrorMode: ReadMirrorDescription['mode'] = 'read-write';
const mirrorWithPathOption: ReadMirrorDescription = {
  kind: 'read-mirror',
  mode: 'read-only',
  readOnly: true,
  connectionString: 'file:/data/app.db?mode=ro',
  // @ts-expect-error mirror options cannot smuggle a physical path key either
  options: { path: '/data/app.db' },
};
void [openedByAdapter, mirrorIsReadOnly, mirrorModeIsReadOnly, mirrorOptions, writableMirrorMode, mirrorWithPathOption];
