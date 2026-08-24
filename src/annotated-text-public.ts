// The optional package entry is an alias over the existing declaration authority.
// It deliberately owns no registry or initialization state.
export {
  annotatedText,
  annotation,
  protectingAnnotation,
  measurement,
  annotationAction,
  annotationEntityAction,
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
export { parseRegionEditDescriptor, isRegionEditDescriptor } from './annotated-text-region-descriptor.ts';
export { exportAnnotatedText, readAnnotatedTextForRecipient } from './annotated-text-snapshot.ts';
export { annotatedTextAnnotationAction } from './annotated-text-thread-action.ts';
