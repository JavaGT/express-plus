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
  AnnotatedTextOperationCommand,
  AnnotatedTextActionAnnotation,
  AnnotatedTextSelection,
  AnnotatedTextOneSelection,
  AnnotatedTextGroupSelection,
  AnnotatedTextContinueBlockCommand,
  AnnotatedTextSetGroupAssignmentCommand,
  AnnotatedTextClearGroupAssignmentCommand,
  AnnotatedTextSplitAndAssignCommand,
  AnnotatedTextActionRequest,
  AnnotatedTextCanonicalDocument,
  AnnotatedTextCanonicalBlock,
  AnnotatedTextGroupMembership,
  AnnotatedTextRecipientDocument,
  AnnotatedTextRecipientBlock,
  AnnotatedTextRecipientBlockGroup,
  AnnotatedTextExpectedOwningScope,
  AnnotatedTextRecipientReadResult,
  AnnotatedTextCreateInput,
  AnnotatedTextCreateSourceBlock,
  AnnotatedTextCreateSourceMeasurement,
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

/** A text family: an RGA document with its checkpoint and ordered blocks. */
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

/** Deterministically rebuild the post-create text family from source blocks. */
export declare function importTextFamilyFromBlocks(
  documentId: string,
  actor: string,
  blocks: ReadonlyArray<{ readonly id: string; readonly text: string }>
): AnnotatedTextFamily;

/** Resolve a canonical RGA endpoint to a UTF-16 offset within a block. */
export declare function projectEndpointToBlockOffset(family: AnnotatedTextFamily, blockId: string, endpoint: unknown): number;

/** Materialize a block's visible text from its family. */
export declare function materializeBlock(family: AnnotatedTextFamily, blockId: string): string;

/** Serialize a text family to its canonical checkpoint. */
export declare function textFamilyCheckpoint(family: AnnotatedTextFamily): unknown;

/** Restore a text family from a canonical checkpoint. */
export declare function restoreTextFamilyCheckpoint(checkpoint: unknown): AnnotatedTextFamily;

/** Resolve a UTF-16 offset to a canonical RGA endpoint with affinity. */
export declare function resolvePositionToEndpoint(family: AnnotatedTextFamily, blockId: string, utf16Offset: number, basisFrontier: unknown, affinity?: 'left' | 'right'): unknown;

