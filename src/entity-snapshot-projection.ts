// Recipient snapshots replace annotated-text storage with the package-owned
// projection before a transport can serialize it. The row itself runs through
// the field-read admission projection (S5/A3) FIRST, so a principal receives
// exactly the readable field subset; annotated-text fields that survive field
// admission are then projected through the annotated-text recipient grammar.
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.ts';
import { projectRowForRecipient } from './entity/projection.ts';
import { readableFieldNames } from './field-admission.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';

export interface EntityFieldDescriptor {
  kind?: string;
  [key: string]: unknown;
}

export interface EntitySnapshotRecord {
  name?: string;
  fields: Record<string, EntityFieldDescriptor>;
  deserializeRow(row: Record<string, unknown>): Record<string, unknown>;
}

export function hasAnnotatedTextFields(entity: EntitySnapshotRecord): boolean {
  return Object.values(entity.fields).some((descriptor) => descriptor.kind === 'annotatedText');
}

export interface ProjectSnapshotOptions {
  db: unknown;
  entity: EntitySnapshotRecord;
  row: Record<string, unknown>;
  principal: unknown;
  authoring?: unknown;
  authorization?: AuthorizationAdapter | null;
}

export async function projectEntitySnapshot({ db, entity, row, principal, authoring = null, authorization = null }: ProjectSnapshotOptions): Promise<Record<string, unknown>> {
  const materialized = entity.deserializeRow({ ...row });
  const readable = await readableFieldNames(entity as never, materialized, principal, authorization);
  const snapshot = await projectRowForRecipient(entity as never, materialized, principal, { readable, authorization });
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    if (descriptor.kind === 'annotatedText' && readable.has(fieldName)) {
      snapshot[fieldName] = await projectAnnotatedTextSnapshot({ db, entity, row, principal, fieldName, descriptor, authoring });
    }
  }
  return snapshot;
}
