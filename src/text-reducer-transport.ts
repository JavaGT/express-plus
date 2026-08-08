import { textCheckpoint, createTextState } from './annotated-text.ts';

const TEXT_REDUCER = 'workbench.text';

interface FieldDescriptor {
  kind?: string;
  type?: string;
}

interface EntityRecord {
  name: string;
  fields?: Record<string, FieldDescriptor>;
}

interface StoredRow {
  id: string | number;
  [field: string]: unknown;
}

function textFields(entity: EntityRecord | null | undefined): [string, FieldDescriptor][] {
  if (!entity) return [];
  return Object.entries(entity.fields ?? {}).filter(([, descriptor]) =>
    descriptor.kind === 'crdt' && descriptor.type === 'text');
}

export interface TextReducerSeed {
  entity: string;
  id: string;
  field: string;
  reducer: string;
  version: number;
  checkpoint: unknown;
}

export function textReducerSeeds(entity: EntityRecord | null | undefined, id: unknown): TextReducerSeed[] {
  if (id === null || id === undefined) return [];
  return textFields(entity).map(([field]) => ({
    entity: entity!.name as string,
    id: String(id),
    field,
    reducer: TEXT_REDUCER,
    version: 1,
    checkpoint: textCheckpoint(createTextState()),
  }));
}

// SQLite retains the canonical checkpoint while hydrated rows deliberately
// expose only visible application values. Transport is the sole bridge.
export function textReducerCheckpoints(entity: EntityRecord | null | undefined, storedRow: StoredRow | null | undefined): TextReducerSeed[] {
  if (!storedRow) return [];
  return textFields(entity).map(([field]) => ({
    entity: entity!.name,
    id: String(storedRow.id),
    field,
    reducer: TEXT_REDUCER,
    version: 1,
    checkpoint: JSON.parse(storedRow[field] as string),
  }));
}

interface TransportEvent {
  handle?: { kind?: string };
  type?: string;
  data?: { id?: unknown };
}

export function createdTextReducerSeeds(entity: EntityRecord | null | undefined, event: TransportEvent | null | undefined): TextReducerSeed[] | undefined {
  if (event?.handle?.kind !== 'created' && !event?.type?.endsWith('.created')) return undefined;
  const reducers = textReducerSeeds(entity, event.data?.id);
  return reducers.length > 0 ? reducers : undefined;
}
