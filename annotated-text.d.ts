export {
  annotatedText,
  annotation,
  protectingAnnotation,
  measurement,
  annotationAction,
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
  annotatedTextAction,
  annotatedTextCreateAction,
  annotatedTextRetireAction,
  exportAnnotatedText,
  readAnnotatedTextForRecipient,
} from './index.js';

export type {
  AnnotatedTextOptions,
  AnnotatedTextAnnotationDescriptor,
  AnnotatedTextProtectingAnnotationDescriptor,
  AnnotatedTextMeasurementDescriptor,
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

/** Event-only word-timing evidence payload carried on create source blocks. */
export declare function assertWordTimingPayload(value: unknown): boolean;

/** Deterministically rebuild the post-create text family from source blocks. */
export declare function importTextFamilyFromBlocks(
  documentId: string,
  actor: string,
  blocks: ReadonlyArray<{ readonly id: string; readonly text: string }>
): unknown;

/** Resolve a canonical RGA endpoint to a UTF-16 offset within a block. */
export declare function projectEndpointToBlockOffset(family: unknown, blockId: string, endpoint: unknown): number;

/** Materialize a block's visible text from its family. */
export declare function materializeBlock(family: unknown, blockId: string): string;

/** Serialize a text family to its canonical checkpoint. */
export declare function textFamilyCheckpoint(family: unknown): unknown;

/** Restore a text family from a canonical checkpoint. */
export declare function restoreTextFamilyCheckpoint(checkpoint: unknown): unknown;

/** Resolve a UTF-16 offset to a canonical RGA endpoint with affinity. */
export declare function resolvePositionToEndpoint(family: unknown, blockId: string, utf16Offset: number, basisFrontier: unknown, affinity?: 'left' | 'right'): unknown;

