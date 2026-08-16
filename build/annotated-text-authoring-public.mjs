// The optional annotated-text-authoring package entry re-exports the two
// internal server-authoring modules: stream/lease/position-frame minting and
// the blockless continuous-family primitives. It deliberately owns no registry
// or initialization state and changes no symbol names or semantics — the
// consuming app (Scope) migrates onto these imports verbatim.
export {
  ensureStream,
  ensureLease,
  issueAuthoringSnapshot,
  buildAuthoringEnvelope,
  hashClientNonce,
  acknowledgeAndPruneSnapshot,
} from './annotated-text-authoring-stream.mjs';
export {
  restoreTextFamilySerialized,
  textFamilyBasis,
  projectEndpointToOffset,
} from './annotated-text-continuous.mjs';
