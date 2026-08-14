// Compiled blob-reference census (S6/A3). Replaces the runtime `blobColumns`
// derivation with one deterministic registry compiled at prepare time from
// entity declarations (`blob: true` fields) and action-level blob-field
// declarations. The census is the single source for the reaper's refcount
// sweep, the blob-finalize consumer's id resolution, backup manifests (S6/A6),
// and S8's blob/MediaFile classification.
//
// Every reference is declared with its owning resource, field, lifecycle
// stage, erasure category, and ownership model (S6 consideration #4/#6).
// Ownership is explicit and per-reference: matching content hashes NEVER merge
// or imply sharing (S6 consideration #7) — the census knows nothing about
// hashes, and the reaper only ever reasons about blob ids.

export type BlobLifecycleKind = 'pending' | 'adopt' | 'finalize';
export type BlobErasureCategory = 'deletable' | 'retained' | 'derived';
export type BlobOwnership = 'exclusive' | 'shared';

export interface BlobReference {
  /** SQL table holding the blob id column. */
  table: string;
  /** SQL column holding the blob id. */
  column: string;
  /** The resource generation that owns these bytes. */
  owningResource: string;
  /** Field name on the owning resource. */
  field: string;
  /** Lifecycle stage a reference must reach before its bytes are reapable. */
  lifecycle: BlobLifecycleKind;
  /** What erasure does with the bytes when the owning generation is removed. */
  erasureCategory: BlobErasureCategory;
  /** Explicit ownership model; hash equality never implies shared ownership. */
  ownership: BlobOwnership;
}

/** Action-level blob-field declaration. owningResource + erasureCategory are required (S6 #4). */
export interface BlobFieldDeclaration {
  actionName: string;
  field: string;
  resourceField: string;
  purgeActionName?: string;
  owningResource: string;
  erasureCategory: BlobErasureCategory;
  ownership?: BlobOwnership;
  lifecycle?: BlobLifecycleKind;
}

export interface BlobCensus {
  /** Every declared blob reference, in deterministic (table, column) order. */
  readonly references: readonly BlobReference[];
  /**
   * Entity-derived references only — the subset the framework blob pipeline
   * (adopt-in-dispatch, the blob.finalize post-commit consumer, and its boot
   * reconcile sweep) resolves blob ids from. Action-level declarations whose
   * column is not an entity `blob: true` field are NOT here: those bytes are
   * owned by the pending-blob pipeline, which finalizes them itself.
   */
  readonly entityReferences: readonly BlobReference[];
  readonly byResource: ReadonlyMap<string, readonly BlobReference[]>;
  readonly byTableColumn: ReadonlyMap<string, readonly BlobReference[]>;
}

export interface BlobCensusInput {
  entities: ReadonlyMap<string, { name: string; fields?: Readonly<Record<string, unknown>> }>;
  declaredBlobFields?: readonly BlobFieldDeclaration[];
}

const refKey = (table: string, column: string): string => `${table}\u0000${column}`;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isErasureCategory = (value: unknown): value is BlobErasureCategory =>
  value === 'deletable' || value === 'retained' || value === 'derived';
const isOwnership = (value: unknown): value is BlobOwnership =>
  value === 'exclusive' || value === 'shared';
const isLifecycleKind = (value: unknown): value is BlobLifecycleKind =>
  value === 'pending' || value === 'adopt' || value === 'finalize';

/** Deterministic, DB-free census compilation from declarations (S6/A3). */
export function compileBlobCensus({ entities, declaredBlobFields = [] }: BlobCensusInput): BlobCensus {
  const byKey = new Map<string, BlobReference>();
  const entityKeys = new Set<string>();

  // Entity `blob: true` fields are implicitly entity-owned, deletable,
  // exclusive references flowing through the full pending→adopt→finalize chain.
  for (const [name, ent] of entities) {
    for (const [fieldName, descriptor] of Object.entries(ent?.fields ?? {})) {
      if (!descriptor || (descriptor as { blob?: unknown }).blob !== true) continue;
      byKey.set(refKey(name, fieldName), {
        table: name,
        column: fieldName,
        owningResource: name,
        field: fieldName,
        lifecycle: 'finalize',
        erasureCategory: 'deletable',
        ownership: 'exclusive',
      });
      entityKeys.add(refKey(name, fieldName));
    }
  }

  // Action-level declarations are the explicit statement of a reference's
  // lifecycle behavior. A field declared without an owning resource or an
  // erasure category fails declaration validation (S6 #4).
  for (const declaration of declaredBlobFields) {
    if (!declaration || typeof declaration.owningResource !== 'string' || !declaration.owningResource
      || !isErasureCategory(declaration.erasureCategory)) {
      throw new TypeError('blob census: every declared blob field requires owningResource and erasureCategory');
    }
    if (!SQL_IDENTIFIER.test(declaration.owningResource) || typeof declaration.field !== 'string' || !SQL_IDENTIFIER.test(declaration.field)) {
      throw new TypeError('blob census: declared blob field owningResource and field must be SQL identifiers');
    }
    if (declaration.ownership !== undefined && !isOwnership(declaration.ownership)) {
      throw new TypeError('blob census: declared blob field ownership must be exclusive or shared');
    }
    if (declaration.lifecycle !== undefined && !isLifecycleKind(declaration.lifecycle)) {
      throw new TypeError('blob census: declared blob field lifecycle must be pending, adopt, or finalize');
    }
    const ref: BlobReference = {
      table: declaration.owningResource,
      column: declaration.field,
      owningResource: declaration.owningResource,
      field: declaration.field,
      lifecycle: declaration.lifecycle ?? 'finalize',
      erasureCategory: declaration.erasureCategory,
      ownership: declaration.ownership ?? 'exclusive',
    };
    const key = refKey(ref.table, ref.column);
    const existing = byKey.get(key);
    if (existing) {
      // An entity blob field plus an action-level declaration for the same
      // column describe ONE reference; the explicit declaration's metadata
      // wins over the entity's implicit defaults.
      byKey.set(key, { ...existing, lifecycle: ref.lifecycle, erasureCategory: ref.erasureCategory, ownership: ref.ownership });
    } else {
      byKey.set(key, ref);
    }
  }

  const sorted = [...byKey.values()]
    .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column))
    .map((ref) => Object.freeze(ref));
  const references = Object.freeze(sorted);
  const entityReferences = Object.freeze(references.filter((ref) => entityKeys.has(refKey(ref.table, ref.column))));
  const byResource = new Map<string, readonly BlobReference[]>();
  const byTableColumn = new Map<string, readonly BlobReference[]>();
  for (const ref of references) {
    if (!byResource.has(ref.owningResource)) byResource.set(ref.owningResource, []);
    if (!byTableColumn.has(refKey(ref.table, ref.column))) byTableColumn.set(refKey(ref.table, ref.column), []);
    (byResource.get(ref.owningResource) as BlobReference[]).push(ref);
    (byTableColumn.get(refKey(ref.table, ref.column)) as BlobReference[]).push(ref);
  }
  for (const map of [byResource, byTableColumn]) {
    for (const [k, v] of map) map.set(k, Object.freeze(v));
    Object.freeze(map);
  }
  return Object.freeze({
    references,
    entityReferences,
    byResource,
    byTableColumn,
  });
}

/** The empty census — an unengaged blob seam with no declared references. */
export const EMPTY_BLOB_CENSUS: BlobCensus = compileBlobCensus({ entities: new Map() });
