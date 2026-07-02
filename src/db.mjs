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

let activeDb;

export function setActiveDb(db) {
  activeDb = db;
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
const activeEntities = new Map();

export function setActiveEntity(name, entityRecord) {
  activeEntities.set(name, entityRecord);
}

export function getActiveEntity(name) {
  return activeEntities.get(name);
}
