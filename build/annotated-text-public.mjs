// The optional package entry is an alias over the existing declaration authority.
// It deliberately owns no registry or initialization state.
export {
  annotatedText,
  annotation,
  protectingAnnotation,
  measurement,
  annotationAction,
  annotationEntityAction,
} from './field.mjs';
export {
  registerAnnotatedTextContract,
  registerAnnotatedTextStructuralExtension,
} from './annotated-text-field.mjs';
export {
  annotatedTextAction,
  annotatedTextCreateAction,
  annotatedTextRetireAction,
} from './annotated-text-action.mjs';
export { parseRegionEditDescriptor, isRegionEditDescriptor } from './annotated-text-region-descriptor.mjs';
export { exportAnnotatedText, readAnnotatedTextForRecipient } from './annotated-text-snapshot.mjs';
export { annotatedTextAnnotationAction } from './annotated-text-thread-action.mjs';
