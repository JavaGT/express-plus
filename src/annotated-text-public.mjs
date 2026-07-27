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
