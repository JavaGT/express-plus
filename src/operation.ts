// The stable operation-category module (S5/A1). A category is the KIND of
// operation a verb or action performs, in a vocabulary independent of any one
// transport's verb names and of any domain's nouns (no ProjectMember/Scope
// names). Downstream sections (S3 live tiers, S4 search, S6 blobs) key off ONE
// category set instead of each owning its own string vocabulary.
//
// Categories are frozen identity tokens, the same discipline as the grant
// capabilities (src/grant.ts): compare by identity, never by string. The
// verb→category mapping here is the single normalization source — the row grant
// routes its verb→capability table through operationCategory() below.
//
//   - read           list/read route verbs, search reads
//   - subscribe      live re-authorization
//   - create         create route verb
//   - update         update route verb
//   - delete         remove route verb
//   - execute        registered actions
//   - search         search-plugin reads
//   - blob-read      blob reads
//   - administrative admin route verb (management)
//
// Unknown verbs are a construction-time error — fail closed, the same
// discipline as an unknown principal type or an unknown route verb.

export interface OperationCategory {
  readonly operation: string;
}

function category(operation: string): OperationCategory {
  return Object.freeze({ operation });
}

export const read: OperationCategory = category('read');
export const subscribe: OperationCategory = category('subscribe');
export const create: OperationCategory = category('create');
export const update: OperationCategory = category('update');
// `delete` is a reserved word; the category is named 'delete', the token is
// exported as `deleteOp`.
export const deleteOp: OperationCategory = category('delete');
export const execute: OperationCategory = category('execute');
export const search: OperationCategory = category('search');
export const blobRead: OperationCategory = category('blob-read');
export const administrative: OperationCategory = category('administrative');

// The frozen closed set, in canonical order. Iterating the whole vocabulary
// (audit taxonomy, capability derivation) never has to spell the names by hand.
export const OPERATION_CATEGORIES: readonly OperationCategory[] = Object.freeze([
  read,
  subscribe,
  create,
  update,
  deleteOp,
  execute,
  search,
  blobRead,
  administrative,
]);

// The verb→category table. Route verbs (list/read/create/update/remove/
// subscribe/admin) map to their category; every category NAME maps to itself so
// operationCategory() round-trips the whole vocabulary. One mapping source: the
// row grant routes VERB_CAPABILITY through this and no other verb table exists.
//
// The table is a NULL-prototype object and every lookup is an own-property
// check, so a name inherited from Object.prototype (`constructor`,
// `__proto__`, `toString`, ...) can never masquerade as a category — fail
// closed.
const VERB_CATEGORY: Readonly<Record<string, OperationCategory>> = Object.freeze(
  Object.assign(Object.create(null), {
    list: read,
    read,
    create,
    update,
    remove: deleteOp,
    delete: deleteOp,
    subscribe,
    admin: administrative,
    administrative,
    execute,
    search,
    'blob-read': blobRead,
  }),
);

// Normalize a verb (or category name) to its category token. Fail closed: an
// unknown name throws rather than silently returning a category that does not
// exist — including a name inherited from Object.prototype (checked with an
// own-property test over a null-prototype table, so no prototype lookup can
// answer for a key the vocabulary never declared).
export function operationCategory(verb: string): OperationCategory {
  if (!Object.hasOwn(VERB_CATEGORY, verb)) {
    throw new Error(
      `unknown operation '${verb}'. The categories are ` +
        `${OPERATION_CATEGORIES.map((c) => c.operation).join('/')} (fail closed — likely a typo).`,
    );
  }
  return VERB_CATEGORY[verb];
}

// The stable-vocabulary ALIASES. `delete` is a reserved word in JS (so the
// category is exported as `deleteOp`), and `blob-read` uses the same
// hyphenated form as the row-grant capability. Both spellings export the SAME
// frozen token — `deleteOp` / `blobRead` are the canonical identifiers to use
// in code; `delete` / `blob-read` are the exact vocabulary spellings a
// category's `operation` string names. Import them as needed:
//
//   import { deleteOp as delete } from '...'   // or: import { deleteOp } ...
//   import { blobRead } from '...'             // the operation string is 'blob-read'
export { deleteOp as delete, blobRead as 'blob-read' };
