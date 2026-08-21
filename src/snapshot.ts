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
const SNAPSHOT_FIELD_HANDLES = new WeakSet<object>();
export const isSnapshotFieldHandle = (handle: unknown): boolean => SNAPSHOT_FIELD_HANDLES.has(handle as object);

/** Register a runtime field handle as a closed grammar handle (scope-sql calls this for every real handle). */
export const registerSnapshotFieldHandle = (handle: object): void => {
	SNAPSHOT_FIELD_HANDLES.add(handle);
};

/**
 * A structure-only field handle for environments that evaluate a declaration
 * without the entity compiler (browser validator derivation, test doubles).
 * Carries the field name and passes every grammar brand check, so the SAME
 * declaration builder runs over real handles (server) and tokens (client).
 */
export function snapshotFieldHandle<Key extends string>(fieldName: Key): SnapshotFieldHandle<never, Key> {
	const handle = { fieldName };
	SNAPSHOT_FIELD_HANDLES.add(handle);
	return handle;
}

// ---- carried declaration types ----

/** How a declared field treats absence: required columns always project; optional ones may be missing/null. */
export type FieldMode = 'required' | 'optional';

/**
 * A field handle as the snapshot grammar reads it. `Key` carries the field
 * NAME as a literal type (real entity handles satisfy this structurally via
 * their own `fieldName`), and the phantoms carry the value/mode knowledge the
 * projection utilities read. Never constructed directly — use entity handles
 * or `snapshotFieldHandle`.
 */
export interface SnapshotFieldHandle<Value = unknown, Key extends string = string, Mode extends FieldMode = 'required'> {
	readonly fieldName: Key;
	readonly entityName?: string;
	readonly __value?: Value;
	readonly __mode?: Mode;
}

/** Scalar selection: projects each named field flat onto the enclosing row. The phantom carries the selected shape. */
export interface SnapshotSelect<Shape = unknown> {
	readonly kind: 'select';
	readonly fields: readonly string[];
	readonly __shape?: Shape;
}

/** An output object: the keyed branches of a snapshot projection. */
export interface SnapshotOutput<Shape extends Record<string, unknown> = Record<string, unknown>> {
	readonly kind: 'object';
	readonly shape: Shape;
}

/** A relation branch: one/many/keyed/count. The phantom carries the child projection node. */
export interface SnapshotRelation<Kind extends 'one' | 'many' | 'keyed' | 'count' = 'one' | 'many' | 'keyed' | 'count', Child = unknown> {
	readonly kind: Kind;
	readonly __child?: Child;
}

export interface SnapshotRelated {
	readonly kind: 'related';
}

export interface SnapshotOrder {
	readonly kind: 'orderBy';
}

/** A recipient User branch: projects the fixed recipient identity shape. */
export interface SnapshotUser {
	readonly kind: 'user';
}

export interface SnapshotTombstones {
	readonly kind: 'tombstones';
}

/** A complete snapshot declaration over an anchor entity. */
export interface SnapshotDeclaration<Output extends SnapshotOutput = SnapshotOutput> {
	readonly kind: 'snapshot';
	readonly anchor: unknown;
	readonly output: Output;
	readonly tombstones?: SnapshotTombstones;
}

/** Any declaration grammar node. */
export type SnapshotNode = SnapshotSelect | SnapshotOutput | SnapshotRelation | SnapshotUser;

// ---- projection type utilities ----

type UnionToIntersection<U> = (U extends unknown ? (intersection: U) => void : never) extends (intersection: infer I) => void ? I : never;

/**
 * The row shape a select contributes: one entry per selected field name, with
 * the handle's value type. Handles without a literal name contribute nothing,
 * so loose/test handles degrade gracefully instead of poisoning the shape.
 */
type SelectedShape<Handles extends readonly unknown[]> = UnionToIntersection<
	{ [Index in keyof Handles]: Handles[Index] extends SnapshotFieldHandle<infer Value, infer Key, infer Mode>
		? string extends Key
			? {}
			: Mode extends 'optional'
				? { [Field in Key & string]?: Value }
				: { [Field in Key & string]: Value }
		: unknown }[number]
>;

/** The child projection a relation carries: its include object, else its select, else nothing (count). */
type ChildProjection<Options> = Options extends { include: infer Included } ? Included
	: Options extends { select: infer Selected } ? Selected
	: Options extends { output: infer Output } ? Output
	: undefined;

/** The projected value of one relation entry, by kind. */
type RelationValue<Kind extends 'one' | 'many' | 'keyed' | 'count', Child> = Kind extends 'count'
	? number
	: Kind extends 'one'
		? SnapshotChildValue<Child> | null
		: Kind extends 'keyed'
			? { readonly [id: string]: SnapshotChildValue<Child> }
			: readonly SnapshotChildValue<Child>[];

/** A relation child row: nested include objects recurse; selects flatten onto the id. */
type SnapshotChildValue<Child> = Child extends SnapshotOutput<infer Shape>
	? SnapshotRowOf<Shape>
	: Child extends SnapshotSelect<infer Shape>
		? { readonly id: string } & Shape
		: { readonly id: string };

/** The recipient User projection shape (see projectSnapshot's user branch). */
export interface SnapshotUserValue {
	readonly id: string;
	readonly name: string | null;
	readonly image: string | null;
}

/** One output branch value: relations by kind, users as the fixed identity shape. Selects flatten (never a key). */
type EntryValue<Entry> = Entry extends SnapshotRelation<infer Kind, infer Child>
	? RelationValue<Kind, Child>
	: Entry extends SnapshotUser
		? SnapshotUserValue | null
		: unknown;

/**
 * The projected row for an output shape: `id`, every select flattened flat
 * onto the row (the entry KEY of a select is ignored by the projector), plus
 * one property per relation/user branch.
 */
type SnapshotRowOf<Shape extends Record<string, unknown>> = { readonly id: string }
	// Non-select branches contribute {} (never `unknown`: one unknown arm would
	// collapse the whole union and erase every flattened field).
	& UnionToIntersection<{ [Key in keyof Shape]: Shape[Key] extends SnapshotSelect<infer Flattened> ? Flattened : {} }[keyof Shape]>
	& { [Key in keyof Shape as Shape[Key] extends SnapshotSelect ? never : Key & string]: EntryValue<Shape[Key]> };

/**
 * The data shape a snapshot declaration projects. Accepts a full declaration
 * or a bare output object; unknown/loose declarations degrade to `unknown`.
 * This is THE type utility hosts derive their snapshot types from — the
 * declaration is written once and every projected shape flows from it.
 */
export type SnapshotValue<Declaration> = Declaration extends SnapshotDeclaration<infer Output>
	? SnapshotRowOf<Output['shape']>
	: Declaration extends SnapshotOutput<infer Shape>
		? SnapshotRowOf<Shape>
		: unknown;

// ---- runtime grammar ----

interface RuntimeNode {
	kind: string;
	[key: string]: unknown;
}

interface SnapshotEntity {
	readonly name: string;
	readonly fields: Readonly<Record<string, unknown>>;
}

interface TombstonesOptions {
	entity?: SnapshotEntity;
	entityId?: SnapshotFieldHandle;
	scopeId?: SnapshotFieldHandle;
	targetScopeId?: SnapshotFieldHandle;
	targetScope?: SnapshotEntity;
	terminalScope?: SnapshotEntity;
	kind?: SnapshotFieldHandle;
	state?: SnapshotFieldHandle;
	kindValue?: string;
	hidden?: readonly string[];
}

function node(kind: string, value: Record<string, unknown> = {}): RuntimeNode {
	return Object.freeze({ kind, ...value });
}

function entityOf(value: unknown): SnapshotEntity {
	if (!value || typeof value !== 'object' || typeof (value as SnapshotEntity).name !== 'string' || !(value as SnapshotEntity).fields) {
		throw new TypeError('snapshot relation requires a declared entity');
	}
	return value as SnapshotEntity;
}

function fieldsOf(handles: readonly SnapshotFieldHandle[]): readonly string[] {
	if (!Array.isArray(handles) || handles.length === 0) throw new TypeError('select requires one or more field handles');
	const fields = handles.map((handle) => handle?.fieldName);
	if (fields.some((field) => typeof field !== 'string')) throw new TypeError('select accepts only field handles');
	return Object.freeze(fields);
}

function refOf(handle: unknown, label = 'via'): string {
	if (!handle || typeof (handle as SnapshotFieldHandle).fieldName !== 'string') throw new TypeError(`${label} requires a ref field handle`);
	return (handle as SnapshotFieldHandle).fieldName;
}

function declareSnapshot(anchor: unknown, options: { output?: RuntimeNode; tombstones?: RuntimeNode } = {}): RuntimeNode {
	return node('snapshot', { anchor: entityOf(anchor), output: options.output, tombstones: options.tombstones });
}

export function object<const Shape extends Readonly<Record<string, SnapshotNode>>>(shape: Shape): SnapshotOutput<Shape> {
	if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new TypeError('object requires an output object');
	return node('object', { shape: Object.freeze({ ...shape }) }) as unknown as SnapshotOutput<Shape>;
}

interface RelationOptions {
	via?: SnapshotFieldHandle;
	require?: SnapshotRelated;
	select?: SnapshotNode;
	include?: SnapshotNode;
	output?: SnapshotNode;
	orderBy?: SnapshotOrder;
	[key: string]: unknown;
}

export function one<const Options extends RelationOptions>(entity: unknown, options?: Options): SnapshotRelation<'one', ChildProjection<Options>> {
	return node('one', { ...options, entity: entityOf(entity), via: refOf(options?.via) }) as unknown as SnapshotRelation<'one', ChildProjection<Options>>;
}

export function many<const Options extends RelationOptions>(entity: unknown, options?: Options): SnapshotRelation<'many', ChildProjection<Options>> {
	return node('many', { ...options, entity: entityOf(entity), via: refOf(options?.via) }) as unknown as SnapshotRelation<'many', ChildProjection<Options>>;
}

export function keyed<const Options extends RelationOptions>(entity: unknown, options?: Options): SnapshotRelation<'keyed', ChildProjection<Options>> {
	return node('keyed', { ...options, entity: entityOf(entity), via: refOf(options?.via) }) as unknown as SnapshotRelation<'keyed', ChildProjection<Options>>;
}

export function count<const Options extends RelationOptions>(entity: unknown, options?: Options): SnapshotRelation<'count', ChildProjection<Options>> {
	return node('count', { ...options, entity: entityOf(entity), via: refOf(options?.via) }) as unknown as SnapshotRelation<'count', ChildProjection<Options>>;
}

export function select<const Handles extends readonly SnapshotFieldHandle[]>(...handles: Handles): SnapshotSelect<SelectedShape<Handles>> {
	return node('select', { fields: fieldsOf(handles) }) as unknown as SnapshotSelect<SelectedShape<Handles>>;
}

export function include<const Shape extends Readonly<Record<string, SnapshotNode>>>(shape: Shape): SnapshotOutput<Shape> {
	return object(shape);
}

export function orderBy(handle: SnapshotFieldHandle, direction: 'asc' | 'desc' = 'asc'): SnapshotOrder {
	if (!handle || typeof handle.fieldName !== 'string') throw new TypeError('orderBy accepts a field handle');
	if (direction !== 'asc' && direction !== 'desc') throw new TypeError("orderBy direction must be 'asc' or 'desc'");
	return node('orderBy', { field: handle.fieldName, direction }) as unknown as SnapshotOrder;
}

// A required related row is a closed candidate filter, never a projected join.
export function related(childRef: SnapshotFieldHandle, { via }: { via?: SnapshotFieldHandle } = {}): SnapshotRelated {
	if (!isSnapshotFieldHandle(childRef) || !isSnapshotFieldHandle(via)) {
		throw new TypeError('related requires declared field handles');
	}
	return node('related', {
		childRef: refOf(childRef, 'related childRef'), via: refOf(via, 'related via'),
		childEntity: (childRef as { entityName?: string }).entityName, parentEntity: (via as { entityName?: string }).entityName,
	}) as unknown as SnapshotRelated;
}

export function user({ via }: { via?: SnapshotFieldHandle } = {}): SnapshotUser {
	return node('user', { via: refOf(via) }) as unknown as SnapshotUser;
}

// This is intentionally a closed visibility declaration: no callbacks, SQL, or
// arbitrary checks can influence which recipient rows are hidden.
export function tombstones(
	target: unknown,
	{ entity, entityId, scopeId, targetScopeId, targetScope, terminalScope, kind, state, kindValue, hidden }: TombstonesOptions = {},
): SnapshotTombstones {
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
	}) as unknown as SnapshotTombstones;
}

const snapshotGrammar = Object.assign(declareSnapshot, {
	object, one, keyed, many, select, include, orderBy, count, related, user, tombstones,
});

/**
 * The snapshot declaration grammar: callable as `snapshot(anchor, { output })`
 * with every builder attached. The generic signature lives on the exported
 * `snapshot` type so declarations carry their shapes.
 */
export interface SnapshotGrammar {
	<const Options extends { output: SnapshotOutput; tombstones?: SnapshotTombstones }>(
		anchor: unknown,
		options?: Options,
	): SnapshotDeclaration<Options['output']>;
	object: typeof object;
	one: typeof one;
	keyed: typeof keyed;
	many: typeof many;
	select: typeof select;
	include: typeof include;
	orderBy: typeof orderBy;
	count: typeof count;
	related: typeof related;
	user: typeof user;
	tombstones: typeof tombstones;
}

export const snapshot: SnapshotGrammar = Object.freeze(snapshotGrammar) as unknown as SnapshotGrammar;
