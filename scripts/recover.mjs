#!/usr/bin/env node
// S1/A4 recovery CLI entry (spec 3): drive the library recover() API from the
// command line without interactive prompting (the Operator — Scope, S8 — owns
// interactive prompting).
//
//   node scripts/recover.mjs --dir <owned-directory>            probe + plain state
//   node scripts/recover.mjs --dir <owned-directory> --list-backups
//   node scripts/recover.mjs --dir <owned-directory> --recover <backupId>
//
// Exit codes: 0 ok / restored, 1 recovery required or restore failed,
// 2 usage error.
import { runRecoveryCli } from '../build/recovery.mjs';

process.exit(await runRecoveryCli(process.argv.slice(2)));
