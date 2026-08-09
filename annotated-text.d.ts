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
  AnnotatedTextOperationCommand,
  AnnotatedTextActionAnnotation,
  AnnotatedTextActionRequest,
  AnnotatedTextCanonicalDocument,
  AnnotatedTextRecipientDocument,
  AnnotatedTextExpectedOwningScope,
  AnnotatedTextRecipientReadResult,
  AnnotatedTextCreateInput,
  AnnotatedTextCreateSourceMeasurement,
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
