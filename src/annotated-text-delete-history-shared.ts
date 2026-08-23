import { createHash } from 'node:crypto';

export function canonicalEndpointJSON(endpoint: unknown): string {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error('annotated-text endpoint must be a structural endpoint object');
  }
  const record = endpoint as { point?: unknown; basisFrontier?: unknown };
  return JSON.stringify({ point: record.point, basisFrontier: record.basisFrontier });
}

function membershipEntrySignature(entry: { ordinal: unknown; start: unknown; end: unknown }): string {
  return JSON.stringify([entry.ordinal, canonicalEndpointJSON(entry.start), canonicalEndpointJSON(entry.end)]);
}

export function membershipDigest(entries: ReadonlyArray<{ ordinal: unknown; start: unknown; end: unknown }>): string {
  const signatures = entries.map(membershipEntrySignature).sort();
  return createHash('sha256').update(JSON.stringify(signatures)).digest('hex');
}
