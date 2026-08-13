// The ambient active-database binding. An entity is declared independently of
// any app (doc.mjs is imported before the app exists), so it cannot receive a
// db handle at declaration time — yet the exemplar calls User.findOne(...) with
// NO db argument. The handle must therefore be ambient: workbench({ db })
// binds it once at construction (setActiveDb), and an entity's query methods
// read it (getActiveDb). This is the SAME app.db handle made reachable to the
// query surface — one shared database, the singular-system rule — never a
// second persistence path.
//
// getActiveDb fails closed: running an entity query before an app is built (no
// db bound) throws rather than silently operating on nothing.

let activeDb         ;

// Rebinding the ambient db is a real hazard: a second workbench({db}) in the
// same process rebinds the active db for ALL entities, so the prior app's
// entity queries now silently hit the new db. Make it LOUD — emit a warning
// when the active db changes to a different handle. This does NOT throw: tests
// legitimately rebind (a fresh :memory: per test), and per-test teardown can
// pass `{ replace: true }` (or call resetActiveDb) to reset without the warning.
// The framework's own workbench({db}) call (src/app.mjs) deliberately stays
// bare so a genuinely conflicting second app warns — that is the case worth
// catching, not routine test reset.
//
// The warning fires ONCE per process. Sequential multi-app construction is a
// legitimate pattern (the framework's own suite builds hundreds of apps); the
// hazard being flagged is a process-level property — "this process rebound the
// ambient at least once, entity queries may not hit the db you think" — and one
// loud line carries that. Repeating it per construction is noise that trains
// readers to ignore it.
let warnedRebind = false;
export function setActiveDb(db         , { replace = false } = {}) {
  if (!replace && !warnedRebind && activeDb && activeDb !== db) {
    warnedRebind = true;
    process.emitWarning(
      'workbench ambient db rebound — a second workbench({db}) in the same ' +
        'process rebinds the active db for ALL entities; the prior app\'s entity ' +
        'queries now hit this db. Pass { replace: true } to silence (e.g. per-test reset).',
      { code: 'WB_AMBIENT_REBIND', type: 'WorkbenchWarning' },
    );
  }
  activeDb = db;
}

// Clear the ambient binding without warning — the test-cleanup escape hatch.
export function resetActiveDb() {
  activeDb = undefined;
}

export function getActiveDb() {
  if (!activeDb) {
    throw new Error(
      'no active database — construct the app with workbench({ db }) before running entity queries',
    );
  }
  return activeDb;
}

// The ambient entity registry — the same ambient pattern as the db. A `map`
// field's `of: ref('User')` names its member entity by STRING; to populate
// members on read (toArray) the handle must resolve that name to the compiled
// entity record (so it can hydrate the member row — keeping a hash password,
// for instance, from leaking as a raw digest). An entity is declared
// independently of any app, so it cannot be passed in; it registers ITSELF by
// name at construction. One name → one entity (module-cached), the singular
// source for FK population.
const activeEntities = new Map                 ();

export function setActiveEntity(name        , entityRecord         ) {
  activeEntities.set(name, entityRecord);
}

export function getActiveEntity(name        )          {
  return activeEntities.get(name);
}
