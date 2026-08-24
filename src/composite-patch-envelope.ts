// Composite patch envelope grammar (#122 design §4).
//
// One authoritative envelope kind, `snapshot-patch`, carrying recipient-safe
// operations over the projected composite state. Operations name OUTPUT paths
// (declaration keys), never storage columns; values are always the
// recipient-projected shapes projectSnapshot produces. The grammar is small by
// design: replace-fields / put-keyed / remove-keyed / replace-many /
// replace-one / replace-value.

export type SnapshotPath = readonly string[];

export type CompositeCursorV1 = Readonly<{ anchor: number; composite: number }>;

export type SnapshotPatchOperationV1 =
  | { readonly op: 'replace-fields'; readonly path: SnapshotPath; readonly value: Readonly<Record<string, unknown>> }
  | { readonly op: 'put-keyed'; readonly path: SnapshotPath; readonly id: string; readonly value: Readonly<Record<string, unknown>> }
  | { readonly op: 'remove-keyed'; readonly path: SnapshotPath; readonly id: string }
  | { readonly op: 'replace-many'; readonly path: SnapshotPath; readonly value: readonly Readonly<Record<string, unknown>>[] }
  | { readonly op: 'replace-one'; readonly path: SnapshotPath; readonly value: Readonly<Record<string, unknown>> | null }
  | { readonly op: 'replace-value'; readonly path: SnapshotPath; readonly value: unknown };

export interface CompositePatchEnvelopeV1 {
  readonly type: 'snapshot-patch';
  readonly protocol: 'snapshot-patch/v1';
  readonly declaration: string;
  readonly from: CompositeCursorV1;
  readonly to: CompositeCursorV1;
  readonly seqSpan: readonly [CompositeCursorV1, CompositeCursorV1];
  readonly actionIds?: readonly string[];
  readonly operations: readonly SnapshotPatchOperationV1[];
  readonly projectionToken: string;
}

const OPERATIONS = new Set(['replace-fields', 'put-keyed', 'remove-keyed', 'replace-many', 'replace-one', 'replace-value']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidCursor(value: unknown): value is CompositeCursorV1 {
  return isPlainObject(value) && isFiniteInt(value.anchor) && isFiniteInt(value.composite);
}

function isValidPath(value: unknown): value is SnapshotPath {
  return Array.isArray(value) && (value.length === 0 || value.every((segment) => typeof segment === 'string' && segment.length > 0));
}

/**
 * Strict structural validation of one candidate envelope. Returns the typed
 * envelope or null — callers treat null as snapshot recovery, never as a
 * partial application (#122 design §9).
 */
export function validateCompositePatchEnvelope(candidate: unknown): CompositePatchEnvelopeV1 | null {
  if (!isPlainObject(candidate)) return null;
  if (candidate.type !== 'snapshot-patch' || candidate.protocol !== 'snapshot-patch/v1') return null;
  if (typeof candidate.declaration !== 'string' || candidate.declaration.length === 0) return null;
  if (!isValidCursor(candidate.from) || !isValidCursor(candidate.to)) return null;
  // Cursors advance monotonically per scope; equal from/to is legal only for
  // an empty patch.
  if (candidate.to.composite < candidate.from.composite) return null;
  if (!Array.isArray(candidate.seqSpan) || candidate.seqSpan.length !== 2 || !isValidCursor(candidate.seqSpan[0]) || !isValidCursor(candidate.seqSpan[1])) return null;
  if (candidate.actionIds !== undefined && (!Array.isArray(candidate.actionIds) || candidate.actionIds.some((id) => typeof id !== 'string' || id.length === 0))) return null;
  if (typeof candidate.projectionToken !== 'string' || candidate.projectionToken.length === 0) return null;
  if (!Array.isArray(candidate.operations)) return null;
  for (const operation of candidate.operations) {
    if (!isPlainObject(operation) || !OPERATIONS.has(operation.op as string)) return null;
    if (!isValidPath(operation.path)) return null;
    switch (operation.op) {
      case 'put-keyed':
        if (typeof operation.id !== 'string' || operation.id.length === 0) return null;
        if (!isPlainObject(operation.value)) return null;
        break;
      case 'remove-keyed':
        if (typeof operation.id !== 'string' || operation.id.length === 0) return null;
        if ('value' in operation) return null;
        break;
      case 'replace-many':
        if (!Array.isArray(operation.value) || !operation.value.every(isPlainObject)) return null;
        break;
      case 'replace-one':
        if (operation.value !== null && !isPlainObject(operation.value)) return null;
        break;
      case 'replace-fields':
      case 'replace-value':
        break;
    }
  }
  return candidate as unknown as CompositePatchEnvelopeV1;
}

/** Deep structural equality of two composite cursors. */
export function cursorEquals(left: CompositeCursorV1, right: CompositeCursorV1): boolean {
  return left.anchor === right.anchor && left.composite === right.composite;
}
