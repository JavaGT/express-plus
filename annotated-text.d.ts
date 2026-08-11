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
  annotationEntityAction,
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
  annotatedTextAction,
  annotatedTextAnnotationAction,
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
  AnnotatedTextAnnotationEntityActionDescriptor,
  AnnotatedTextAnnotationEntityActionHandle,
  AnnotatedTextCompiledActionHandle,
  AnnotatedTextActionHandles,
  AnnotatedTextAnnotationActionValues,
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
  AnnotatedTextCreateSourceMeasurement,
  AnnotatedTextCanonicalBlock,
  AnnotatedTextGroupMembership,
  AnnotatedTextRecipientBlock,
  AnnotatedTextRecipientBlockGroup,
} from './index.js';

/** Validate + canonicalize a source document's event-only word-evidence envelope. */
export declare function assertWordEvidencePayload(
  value: unknown,
  context: {
    readonly families?: readonly AnnotatedTextWordEvidenceFamily<string, unknown>[];
    /** Historical name retained; whole-document text (issue #33). */
    readonly blockText: string;
  },
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
