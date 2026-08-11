// Optional annotated-text subpath entry.
//
// TYPE AUTHORITY: the blockless continuous annotated-text model. See
//   src/annotated-text-continuous.ts           one RGA text stream per document,
//                                              absolute UTF-16 offsets, annotations
//                                              as character ranges resolved to
//                                              structural endpoints (issue #33)
//   src/annotated-text-recipient-projection.ts canonical -> recipient projection
// The canonical document is {kind:'workbench.annotatedText.canonical', version:1,
// text, annotations, ranges, measurements, capabilityHints, orphans?}; the
// recipient projection is {kind:'workbench.annotatedText.recipient', version:1,
// text, ranges, annotations, measurements, capabilityHints}. The block-era
// shapes and family shims below are marked `@deprecated`.

export {
  annotatedText,
  annotation,
  protectingAnnotation,
  measurement,
  wordEvidenceFamily,
  annotationAction,
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
  annotatedTextAction,
  annotatedTextCreateAction,
  annotatedTextRetireAction,
  exportAnnotatedText,
  readAnnotatedTextForRecipient,
} from './index.js';

import type {
  AnnotatedTextWordEvidenceFamily,
  AnnotatedTextWordEvidenceFamilyHandle,
  AnnotatedTextWordEvidenceReadResult,
} from './index.js';

export type {
  AnnotatedTextOptions,
  AnnotatedTextAnnotationDescriptor,
  AnnotatedTextProtectingAnnotationDescriptor,
  AnnotatedTextMeasurementDescriptor,
  AnnotatedTextWordEvidenceFamily,
  AnnotatedTextWordEvidenceFamilyHandle,
  AnnotatedTextWordEvidenceInput,
  AnnotatedTextWordEvidenceReadResult,
  AnnotatedTextActionDescriptor,
  AnnotatedTextAnnotationHandle,
  AnnotatedTextMeasurementHandle,
  AnnotatedTextCapabilityHandle,
  AnnotatedTextFieldHandle,
  AnnotatedTextMeasurementValidationInput,
  AnnotatedTextMeasurementEditInput,
  AnnotatedTextMeasurementEditResult,
  AnnotatedTextMeasurementPartitionInput,
  AnnotatedTextMeasurementPartitionResult,
  AnnotatedTextMeasurementCombineSide,
  AnnotatedTextMeasurementCombineInput,
  AnnotatedTextMeasurementCombineResult,
  AnnotatedTextStructuralExtensionSpec,
  AnnotatedTextAuthoringBinding,
  AnnotatedTextAuthoringPosition,
  AnnotatedTextOperationCommand,
  AnnotatedTextOperationEdit,
  AnnotatedTextOperationPayload,
  AnnotatedTextActionAnnotation,
  AnnotatedTextSelection,
  AnnotatedTextOneSelection,
  AnnotatedTextGroupSelection,
  AnnotatedTextInsertCommand,
  AnnotatedTextDeleteCommand,
  AnnotatedTextReplaceCommand,
  AnnotatedTextSplitCommand,
  AnnotatedTextMergeCommand,
  AnnotatedTextApplyAnnotationCommand,
  AnnotatedTextDetachAnnotationCommand,
  AnnotatedTextRemoveAnnotationCommand,
  AnnotatedTextContinueBlockCommand,
  AnnotatedTextSetGroupAssignmentCommand,
  AnnotatedTextClearGroupAssignmentCommand,
  AnnotatedTextSplitAndAssignCommand,
  AnnotatedTextActionRequest,
  AnnotatedTextCanonicalDocument,
  AnnotatedTextDocumentRange,
  AnnotatedTextOrphan,
  AnnotatedTextMeasurement,
  AnnotatedTextRecipientRedaction,
  AnnotatedTextRecipientDocument,
  AnnotatedTextExpectedOwningScope,
  AnnotatedTextRecipientReadResult,
  AnnotatedTextCreateInput,
  AnnotatedTextCreateSourceBlock,
  AnnotatedTextCreateSourceMeasurement,
  AnnotatedTextCanonicalBlock,
  AnnotatedTextGroupMembership,
  AnnotatedTextRecipientBlock,
  AnnotatedTextRecipientBlockGroup,
} from './index.js';

/** Validate + canonicalize a source block's event-only word-evidence envelope. */
export declare function assertWordEvidencePayload(
  value: unknown,
  context: { readonly families?: readonly AnnotatedTextWordEvidenceFamily<string, unknown>[]; readonly blockText: string },
): Readonly<Record<string, unknown>>;

/** Read a field's word evidence resolved against current text. */
export declare function readWordEvidence(input: {
  readonly database: unknown;
  readonly entityName: string;
  readonly fieldName: string;
  readonly tableName?: string;
  readonly scope: string;
  readonly documentId: string;
  readonly families?: readonly string[];
}): AnnotatedTextWordEvidenceReadResult | null;

/** A frozen handle to a field's declared word-evidence families. */
export declare function wordEvidenceFieldHandle(
  entityName: string,
  fieldName: string,
  descriptor: { readonly wordEvidence?: readonly AnnotatedTextWordEvidenceFamily<string, unknown>[] },
): {
  readonly entityName: string;
  readonly fieldName: string;
  readonly tableName: string;
  readonly families: readonly AnnotatedTextWordEvidenceFamilyHandle[];
};

export declare function wordEvidenceTableName(entityName: string, fieldName: string): string;

// ── Block-era text family shims (superseded, still shipped) ────────────────
// These exports remain for legacy callers but describe the removed block model.
// The blockless continuous model (issue #33) is implemented in
// src/annotated-text-continuous.ts: one RGA text stream per document, no
// blocks. Prefer that module's shapes (`ContinuousTextFamily` = { id,
// checkpoint }, `materializeText`, `resolveOffsetToEndpoint`, ...).

/** @deprecated Block-era text family. The continuous model has no `blocks`. */
export interface AnnotatedTextFamily {
  readonly id: string;
  readonly checkpoint: {
    readonly elements: Readonly<Record<string, unknown>>;
    readonly frontier: readonly unknown[];
  };
  readonly blocks: readonly {
    readonly id: string;
    readonly elementKeys: readonly string[];
  }[];
}

/** @deprecated Block-era. The blockless import path is a single continuous text stream. */
export declare function importTextFamilyFromBlocks(
  documentId: string,
  actor: string,
  blocks: ReadonlyArray<{ readonly id: string; readonly text: string }>
): AnnotatedTextFamily;

/** @deprecated Block-era. Superseded by projectEndpointToOffset (document-scoped). */
export declare function projectEndpointToBlockOffset(family: AnnotatedTextFamily, blockId: string, endpoint: unknown): number;

/** @deprecated Block-era. Superseded by materializeText (whole-document). */
export declare function materializeBlock(family: AnnotatedTextFamily, blockId: string): string;

/** @deprecated Block-era family checkpoint. The continuous model uses `textFamilyCheckpoint` in src/annotated-text-continuous.ts. */
export declare function textFamilyCheckpoint(family: AnnotatedTextFamily): unknown;

/** @deprecated Block-era family restore. The continuous model uses `restoreTextFamily` / `restoreTextFamilySerialized`. */
export declare function restoreTextFamilyCheckpoint(checkpoint: unknown): AnnotatedTextFamily;

/** @deprecated Block-era. Superseded by resolveOffsetToEndpoint (document-scoped, no blockId). */
export declare function resolvePositionToEndpoint(family: AnnotatedTextFamily, blockId: string, utf16Offset: number, basisFrontier: unknown, affinity?: 'left' | 'right'): unknown;

