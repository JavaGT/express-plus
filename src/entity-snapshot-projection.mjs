// Recipient snapshots replace annotated-text storage with the package-owned
// projection before a transport can serialize it.
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.mjs';

export function hasAnnotatedTextFields(entity) {
  return Object.values(entity.fields).some((descriptor) => descriptor.kind === 'annotatedText');
}

export async function projectEntitySnapshot({ db, entity, row, principal }) {
  const snapshot = entity.deserializeRow({ ...row });
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    if (descriptor.kind === 'annotatedText') {
      snapshot[fieldName] = await projectAnnotatedTextSnapshot({ db, entity, row, principal, fieldName, descriptor });
    }
  }
  return snapshot;
}
