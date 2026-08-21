// Declared relational recipient snapshots. The grammar carries entities and
// field handles, so callers cannot smuggle SQL, tables, or callbacks into live
// delivery.
//
// The declaration TYPES carry their field names and nested shapes: a compiled
// declaration's TypeScript type describes exactly what the runtime projects,
// and `SnapshotValue<D>` computes that projected data shape from a declaration
// type. The projected-shape knowledge lives ONLY on the type layer (phantom
// `__shape`/`__child` properties, mirroring FieldDescriptor's `__value`);
// runtime nodes stay the plain frozen records delivery has always consumed.

// Module-private provenance for closed declaration grammar handles. Owned HERE
// (not scope-sql) so this module stays dependency-free: the grammar is safe to
// evaluate in any environment (host, browser bundle, test double), which is
// what lets a host derive client-side validators from one declaration.
const SNAPSHOT_FIELD_HANDLES = new WeakSet        ();
export const isSnapshotFieldHandle = (handle         )          => SNAPSHOT_FIELD_HANDLES.has(handle          );

/** Register a runtime field handle as a closed grammar handle (scope-sql calls this for every real handle). */
export const registerSnapshotFieldHandle = (handle        )       => {
	SNAPSHOT_FIELD_HANDLES.add(handle);
};

/**
 * A structure-only field handle for environments that evaluate a declaration
 * without the entity compiler (browser validator derivation, test doubles).
 * Carries the field name and passes every grammar brand check, so the SAME
 * declaration builder runs over real handles (server) and tokens (client).
 */
export function snapshotFieldHandle                    (fieldName     )                                  {
	const handle = { fieldName };
	SNAPSHOT_FIELD_HANDLES.add(handle);
	return handle;
}

// ---- carried declaration types ----

/** How a declared field treats absence: required columns always project; optional ones may be missing/null. */


/**
 * A field handle as the snapshot grammar reads it. `Key` carries the field
 * NAME as a literal type (real entity handles satisfy this structurally via
 * their own `fieldName`), and the phantoms carry the value/mode knowledge the
 * projection utilities read. Never constructed directly — use entity handles
 * or `snapshotFieldHandle`.
 */







/** Scalar selection: projects each named field flat onto the enclosing row. The phantom carries the selected shape. */






/** An output object: the keyed branches of a snapshot projection. */





/** A relation branch: one/many/keyed/count. The phantom carries the child projection node. */













/** A recipient User branch: projects the fixed recipient identity shape. */








/** A complete snapshot declaration over an anchor entity. */







/** Any declaration grammar node. */


// ---- projection type utilities ----



/**
 * The row shape a select contributes: one entry per selected field name, with
 * the handle's value type. Handles without a literal name contribute nothing,
 * so loose/test handles degrade gracefully instead of poisoning the shape.
 */










/** The child projection a relation carries: its include object, else its select, else nothing (count). */





/** The projected value of one relation entry, by kind. */








/** A relation child row: nested include objects recurse; selects flatten onto the id. */






/** The recipient User projection shape (see projectSnapshot's user branch). */






/** One output branch value: relations by kind, users as the fixed identity shape. Selects flatten (never a key). */






/**
 * The projected row for an output shape: `id`, every select flattened flat
 * onto the row (the entry KEY of a select is ignored by the projector), plus
 * one property per relation/user branch.
 */






/**
 * The data shape a snapshot declaration projects. Accepts a full declaration
 * or a bare output object; unknown/loose declarations degrade to `unknown`.
 * This is THE type utility hosts derive their snapshot types from — the
 * declaration is written once and every projected shape flows from it.
 */






// ---- runtime grammar ----
























function node(kind        , value                          = {})              {
	return Object.freeze({ kind, ...value });
}

function entityOf(value         )                 {
	if (!value || typeof value !== 'object' || typeof (value                  ).name !== 'string' || !(value                  ).fields) {
		throw new TypeError('snapshot relation requires a declared entity');
	}
	return value                  ;
}

function fieldsOf(handles                                )                    {
	if (!Array.isArray(handles) || handles.length === 0) throw new TypeError('select requires one or more field handles');
	const fields = handles.map((handle) => handle?.fieldName);
	if (fields.some((field) => typeof field !== 'string')) throw new TypeError('select accepts only field handles');
	return Object.freeze(fields);
}

function refOf(handle         , label = 'via')         {
	if (!handle || typeof (handle                       ).fieldName !== 'string') throw new TypeError(`${label} requires a ref field handle`);
	return (handle                       ).fieldName;
}

function declareSnapshot(anchor         , options                                                     = {})              {
	return node('snapshot', { anchor: entityOf(anchor), output: options.output, tombstones: options.tombstones });
}

export function object                                                            (shape       )                        {
	if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new TypeError('object requires an output object');
	return node('object', { shape: Object.freeze({ ...shape }) })                                    ;
}











export function one                                       (entity         , options          )                                                    {
	return node('one', { ...options, entity: entityOf(entity), via: refOf(options?.via) })                                                                ;
}

export function many                                       (entity         , options          )                                                     {
	return node('many', { ...options, entity: entityOf(entity), via: refOf(options?.via) })                                                                 ;
}

export function keyed                                       (entity         , options          )                                                      {
	return node('keyed', { ...options, entity: entityOf(entity), via: refOf(options?.via) })                                                                  ;
}

export function count                                       (entity         , options          )                                                      {
	return node('count', { ...options, entity: entityOf(entity), via: refOf(options?.via) })                                                                  ;
}

export function select                                                      (...handles         )                                         {
	return node('select', { fields: fieldsOf(handles) })                                                     ;
}

export function include                                                            (shape       )                        {
	return object(shape);
}

export function orderBy(handle                     , direction                 = 'asc')                {
	if (!handle || typeof handle.fieldName !== 'string') throw new TypeError('orderBy accepts a field handle');
	if (direction !== 'asc' && direction !== 'desc') throw new TypeError("orderBy direction must be 'asc' or 'desc'");
	return node('orderBy', { field: handle.fieldName, direction })                            ;
}

// A required related row is a closed candidate filter, never a projected join.
export function related(childRef                     , { via }                                = {})                  {
	if (!isSnapshotFieldHandle(childRef) || !isSnapshotFieldHandle(via)) {
		throw new TypeError('related requires declared field handles');
	}
	return node('related', {
		childRef: refOf(childRef, 'related childRef'), via: refOf(via, 'related via'),
		childEntity: (childRef                           ).entityName, parentEntity: (via                           ).entityName,
	})                              ;
}

export function user({ via }                                = {})               {
	return node('user', { via: refOf(via) })                           ;
}

// This is intentionally a closed visibility declaration: no callbacks, SQL, or
// arbitrary checks can influence which recipient rows are hidden.
export function tombstones(
	target         ,
	{ entity, entityId, scopeId, targetScopeId, targetScope, terminalScope, kind, state, kindValue, hidden }                    = {},
)                     {
	if (typeof kindValue !== 'string' || kindValue.length === 0) throw new TypeError('tombstones requires a literal kindValue');
	if (!Array.isArray(hidden) || hidden.length === 0 || hidden.some((value) => typeof value !== 'string' || value.length === 0)) {
		throw new TypeError('tombstones requires one or more literal hidden states');
	}
	return node('tombstones', {
		target: entityOf(target), entity: entityOf(entity), entityId: refOf(entityId, 'tombstones entityId'),
		scopeId: scopeId === undefined ? undefined : refOf(scopeId, 'tombstones scopeId'),
		targetScopeId: targetScopeId === undefined ? undefined : refOf(targetScopeId, 'tombstones targetScopeId'),
		targetScopeEntity: targetScopeId?.entityName,
		targetScope: targetScope === undefined ? undefined : entityOf(targetScope),
		terminalScope: terminalScope === undefined ? undefined : entityOf(terminalScope),
		kindField: refOf(kind, 'tombstones kind'), state: refOf(state, 'tombstones state'), kindValue,
		hidden: Object.freeze([...hidden]),
	})                                 ;
}

const snapshotGrammar = Object.assign(declareSnapshot, {
	object, one, keyed, many, select, include, orderBy, count, related, user, tombstones,
});

/**
 * The snapshot declaration grammar: callable as `snapshot(anchor, { output })`
 * with every builder attached. The generic signature lives on the exported
 * `snapshot` type so declarations carry their shapes.
 */


















export const snapshot                  = Object.freeze(snapshotGrammar)                              ;
