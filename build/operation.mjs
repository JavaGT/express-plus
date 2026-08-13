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

                                    
                             
 

function category(operation        )                    {
  return Object.freeze({ operation });
}

export const read                    = category('read');
export const subscribe                    = category('subscribe');
export const create                    = category('create');
export const update                    = category('update');
// `delete` is a reserved word; the category is named 'delete', the token is
// exported as `deleteOp`.
export const deleteOp                    = category('delete');
export const execute                    = category('execute');
export const search                    = category('search');
export const blobRead                    = category('blob-read');
export const administrative                    = category('administrative');

// The frozen closed set, in canonical order. Iterating the whole vocabulary
// (audit taxonomy, capability derivation) never has to spell the names by hand.
export const OPERATION_CATEGORIES                               = Object.freeze([
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
const VERB_CATEGORY                                              = Object.freeze({
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
});

// Normalize a verb (or category name) to its category token. Fail closed: an
// unknown name throws rather than silently returning a category that does not
// exist.
export function operationCategory(verb        )                    {
  const normalized = VERB_CATEGORY[verb];
  if (!normalized) {
    throw new Error(
      `unknown operation '${verb}'. The categories are ` +
        `${OPERATION_CATEGORIES.map((c) => c.operation).join('/')} (fail closed — likely a typo).`,
    );
  }
  return normalized;
}
