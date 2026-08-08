// @ts-nocheck
// The optional package entry is an alias over the existing declaration authority.
// It deliberately owns no registry or initialization state.
export {
  annotatedText,
  annotation,
  protectingAnnotation,
  measurement,
  wordEvidenceFamily,
  annotationAction,
} from './field.ts';
export {
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
} from './annotated-text-field.ts';
export {
  annotatedTextAction,
  annotatedTextCreateAction,
  annotatedTextRetireAction,
} from './annotated-text-action.ts';
export { exportAnnotatedText, readAnnotatedTextForRecipient } from './annotated-text-snapshot.ts';
export { importTextFamilyFromBlocks, resolvePositionToEndpoint, projectEndpointToBlockOffset, materializeBlock, textFamilyCheckpoint, restoreTextFamilyCheckpoint } from './annotated-text-family.ts';
export {
  assertWordEvidencePayload,
  readWordEvidence,
  wordEvidenceFieldHandle,
  wordEvidenceTableName,
} from './word-evidence.ts';
