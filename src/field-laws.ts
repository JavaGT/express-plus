import { lawsOf } from './field-strategy.ts';

export function canUndoField(kind: string): boolean {
  const laws = lawsOf(kind) as { invertible?: boolean };
  return laws.invertible === true;
}

export function undoableFieldKinds(): string[] {
  return ['value', 'crdt', 'store', 'ordered', 'struct', 'state'];
}
