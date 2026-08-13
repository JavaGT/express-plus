// The annotated-text coordinate grammar for recipient documents: wire↔display
// redaction mapping and scalar-bounded edit intervals. Consumers (including
// the Scope transcript flow) import this one subpath instead of copying the
// predicates; it re-exports source modules only, never copies them.
export {
  wireToDisplayPosition,
  displayToWirePosition,
  classifyDisplayOffset,
  selectionCrossesDisplayRedaction,
  placeholderDisplayWidth,
} from './workbench-annotated-text-redaction-coords.mjs';
export {
  scalarStart,
  scalarEnd,
  changedRange,
} from './workbench-annotated-text-editor.mjs';
