// The ambient active-database binding. An entity is declared independently of
// any app (doc.mjs is imported before the app exists), so it cannot receive a
// db handle at declaration time — yet the exemplar calls User.findOne(...) with
// NO db argument. The handle must therefore be ambient: expressPlus({ db })
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
      'no active database — construct the app with expressPlus({ db }) before running entity queries',
    );
  }
  return activeDb;
}
