// Type definitions for workbench/annotated-text-coords — the annotated-text
// coordinate grammar for recipient documents: wire↔display redaction mapping
// and scalar-bounded edit intervals.
//
// Source of truth: public/workbench-annotated-text-coords.mjs (a re-export
// aggregator over the redaction-coords, editor, and snapshot modules).
// Projection for TypeScript app authors. JS users see no change.

export type AnnotatedTextAffinity = 'left' | 'right';

/** A position in a coordinate space: a text offset plus the affinity that
 * disambiguates a placeholder edge. `affinity` is optional on input and a
 * plain (non-edge) result passes the caller's affinity through. */
export interface AnnotatedTextCoordinatedPosition {
  readonly offset: number;
  readonly affinity?: AnnotatedTextAffinity;
}

/** A recipient redaction marker: zero-width in wire space at `start`, with a
 * placeholder occupying `placeholder.length` display columns. */
export interface AnnotatedTextRedactionMarker {
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}

/** A stored structural endpoint: RGA point plus the historical basis frontier. */
export interface AnnotatedTextStructuralEndpoint {
  readonly point: readonly ['point', readonly ['root'] | readonly ['element', readonly [readonly [string, number], number]], 'left' | 'right'];
  readonly basisFrontier: readonly (readonly [string, number])[];
}

/** An annotation range: anchored endpoints (fully-visible) or UTF-16 offsets (redacted). */
export type AnnotatedTextRange =
  | { readonly annotationId: string; readonly start: number; readonly end: number }
  | { readonly annotationId: string; readonly start: AnnotatedTextStructuralEndpoint; readonly end: AnnotatedTextStructuralEndpoint };

/** The scalar-bounded edit interval from one text to the next. */
export interface AnnotatedTextChangedRange {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** A display offset classified against the redaction placeholders. */
export type AnnotatedTextDisplayOffsetClassification =
  | { readonly kind: 'left'; readonly offset: number; readonly affinity: AnnotatedTextAffinity }
  | { readonly kind: 'interior'; readonly offset: number }
  | { readonly kind: 'right'; readonly offset: number; readonly affinity: AnnotatedTextAffinity }
  | { readonly kind: 'plain'; readonly offset: number };

/** Wire → display. A wire offset on a placeholder start maps to its left edge
 * ('left' affinity) or right edge ('right' affinity); a missing affinity
 * chooses the left edge. */
export declare function wireToDisplayPosition(
  value: AnnotatedTextCoordinatedPosition,
  redactions?: readonly AnnotatedTextRedactionMarker[],
): AnnotatedTextCoordinatedPosition;

/** Display → wire. Throws TypeError (code 'position-redacted') when the offset
 * is inside a placeholder (an interior is not a legal caret). */
export declare function displayToWirePosition(
  value: AnnotatedTextCoordinatedPosition,
  redactions?: readonly AnnotatedTextRedactionMarker[],
): AnnotatedTextCoordinatedPosition;

/** Classify a display offset against placeholders. Interior is not a legal
 * caret; callers return null for it. */
export declare function classifyDisplayOffset(
  offset: number,
  redactions?: readonly AnnotatedTextRedactionMarker[],
): AnnotatedTextDisplayOffsetClassification;

/** True when [fromOffset, toOffset] (display) overlaps any placeholder
 * interior/edge span. */
export declare function selectionCrossesDisplayRedaction(
  fromOffset: number,
  toOffset: number,
  redactions?: readonly AnnotatedTextRedactionMarker[],
): boolean;

/** Total display width contributed by the placeholders, used to back the
 * display length of a rendered wire text out to its wire length. */
export declare function placeholderDisplayWidth(
  redactions?: readonly AnnotatedTextRedactionMarker[],
): number;

/** Back `offset` off a trailing low surrogate onto the scalar boundary. */
export declare function scalarStart(text: string, offset: number): number;

/** Advance `offset` off a leading high surrogate onto the scalar boundary. */
export declare function scalarEnd(text: string, offset: number): number;

/** The minimal scalar-bounded edit interval from `before` to `after`. */
export declare function changedRange(before: string, after: string): AnnotatedTextChangedRange;
