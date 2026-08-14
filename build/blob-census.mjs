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






















/** Action-level blob-field declaration. owningResource + erasureCategory are required (S6 #4). */















                                     















const refKey = (table        , column        )         => `${table}\u0000${column}`;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isErasureCategory = (value         )                               =>
  value === 'deletable' || value === 'retained' || value === 'derived';
const isOwnership = (value         )                         =>
  value === 'exclusive' || value === 'shared';
const isLifecycleKind = (value         )                             =>
  value === 'pending' || value === 'adopt' || value === 'finalize';

/** Deterministic, DB-free census compilation from declarations (S6/A3). */
export function compileBlobCensus({ entities, declaredBlobFields = [] }                 )             {
  const byKey = new Map                       ();
  const entityKeys = new Set        ();

  // Entity `blob: true` fields are implicitly entity-owned, deletable,
  // exclusive references flowing through the full pending→adopt→finalize chain.
  for (const [name, ent] of entities) {
    for (const [fieldName, descriptor] of Object.entries(ent?.fields ?? {})) {
      if (!descriptor || (descriptor                      ).blob !== true) continue;
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
    const ref                = {
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
  const byResource = new Map                                  ();
  const byTableColumn = new Map                                  ();
  for (const ref of references) {
    if (!byResource.has(ref.owningResource)) byResource.set(ref.owningResource, []);
    if (!byTableColumn.has(refKey(ref.table, ref.column))) byTableColumn.set(refKey(ref.table, ref.column), []);
    (byResource.get(ref.owningResource)                   ).push(ref);
    (byTableColumn.get(refKey(ref.table, ref.column))                   ).push(ref);
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
export const EMPTY_BLOB_CENSUS             = compileBlobCensus({ entities: new Map() });
