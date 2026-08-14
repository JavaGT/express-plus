// Durable events may contain framework-only projection metadata. Delivery keeps
// the committed event shape but never exposes the reserved envelope.

// S3/A7 client-ingest contract: only `event` (full-log) and `state` (live
// replacement) envelopes are authoritative domain mutations. Recovery controls
// (`resync`, `state-invalidate`) and derived/operational notifications are
// never authoritative; feature code must reject them as domain mutations
// (consideration #23).
export function isAuthoritativeEnvelope(envelope: unknown): envelope is { type: 'event' | 'state' } {
  return envelope != null && typeof envelope === 'object'
    && ((envelope as { type?: unknown }).type === 'event'
      || (envelope as { type?: unknown }).type === 'state');
}

// Diagnostics name the resource kind + revision only (consideration #26). The
// returned context contains nothing but identity/revision keys — never payload
// field values, snapshots, deltas, or row content. A structural assert can rely
// on this closed key set.
export function envelopeDiagnostics(envelope: unknown): Readonly<{ kind: string; entity?: string; id?: string; seq?: number; reason?: string }> {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { kind: 'unknown' };
  const record = envelope as Record<string, unknown>;
  const diagnostics: { kind: string; entity?: string; id?: string; seq?: number; reason?: string } = {
    kind: typeof record.type === 'string' ? record.type : 'unknown',
  };
  if (typeof record.entity === 'string') diagnostics.entity = record.entity;
  if (typeof record.id === 'string') diagnostics.id = record.id;
  if (Number.isSafeInteger(record.seq)) diagnostics.seq = record.seq as number;
  if (typeof record.reason === 'string') diagnostics.reason = record.reason;
  return diagnostics;
}

export function publicEvent<T extends { data?: Record<string, unknown> | null }>(event: T): T {
  if (!event?.data || !Object.hasOwn(event.data, '__workbench')) return event;
  const { __workbench: _metadata, ...data } = event.data;
  return { ...event, data } as T;
}
