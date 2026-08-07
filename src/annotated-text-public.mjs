// The optional package entry is an alias over the existing declaration authority.
// It deliberately owns no registry or initialization state.
export {
  annotatedText,
  annotation,
  protectingAnnotation,
  measurement,
  annotationAction,
} from './field.mjs';
export {
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
} from './annotated-text-field.mjs';
export {
  annotatedTextAction,
  annotatedTextCreateAction,
  annotatedTextRetireAction,
  assertWordTimingPayload,
} from './annotated-text-action.mjs';
export { exportAnnotatedText, readAnnotatedTextForRecipient } from './annotated-text-snapshot.mjs';
export { importTextFamilyFromBlocks, resolvePositionToEndpoint, materializeBlock, textFamilyCheckpoint, restoreTextFamilyCheckpoint } from './annotated-text-family.mjs';
