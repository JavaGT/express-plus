import { lawsOf } from './field-strategy.mjs';

export function canUndoField(kind) {
  return lawsOf(kind).invertible;
}

export function undoableFieldKinds() {
  return ['value', 'crdt', 'store', 'ordered', 'struct', 'state'];
}
