import { lawsOf } from './field-strategy.mjs';

export function canUndoField(kind        )          {
  const laws = lawsOf(kind)                            ;
  return laws.invertible === true;
}

export function undoableFieldKinds()           {
  return ['value', 'crdt', 'store', 'ordered', 'struct', 'state'];
}
