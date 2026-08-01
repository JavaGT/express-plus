const bindings = new WeakSet();

export function createAnnotatedTextSnapshotSessionBinding(onBlockGroup = null) {
  const binding = { generation: 0, document: null, onBlockGroup };
  bindings.add(binding);
  return binding;
}

export function getAnnotatedTextSnapshotSessionBinding(value) {
  return bindings.has(value) ? value : null;
}

export function revokeAnnotatedTextSnapshotSessionBinding(binding) {
  if (bindings.has(binding)) {
    binding.generation += 1;
    binding.document = null;
  }
}
