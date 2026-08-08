// Recipient snapshots replace annotated-text storage with the package-owned
// projection before a transport can serialize it.
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.ts';

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
}

export async function projectEntitySnapshot({ db, entity, row, principal, authoring = null }: ProjectSnapshotOptions): Promise<Record<string, unknown>> {
  const snapshot = entity.deserializeRow({ ...row });
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    if (descriptor.kind === 'annotatedText') {
      snapshot[fieldName] = await projectAnnotatedTextSnapshot({ db, entity, row, principal, fieldName, descriptor, authoring });
    }
  }
  return snapshot;
}
