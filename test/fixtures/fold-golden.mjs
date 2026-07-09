// Golden fold fixtures — shared event sequences both createClient and LiveList
// must resolve to the same final state + cursor when inputs share semantics.
//
// Folds stay separate implementations (AGENTS / DECISIONLOG): createClient uses
// declared event.reduce; LiveList uses kind-aware _applyEvent. These fixtures
// lock the *contracts* that must not drift: lifecycle CRUD without deltas,
// value {set} via whole event.data (createClient) vs delta (LiveList), and
// Replay decision (dup/gap/next).

/** Lifecycle-only sequence: created → scalar updated → removed. No field deltas. */
export const LIFECYCLE = {
  scope: 'Note:n1',
  entity: 'Note',
  id: 'n1',
  bootstrap: { snapshot: null, seq: 0 },
  events: [
    {
      type: 'Note.created',
      scope: 'Note:n1',
      seq: 1,
      seqSpan: [1, 1],
      data: { id: 'n1', title: 'hello', done: false },
    },
    {
      type: 'Note.updated',
      scope: 'Note:n1',
      seq: 2,
      seqSpan: [2, 2],
      data: { id: 'n1', title: 'hello', done: true },
      // no delta — whole-value path for both folds
    },
    {
      type: 'Note.updated',
      scope: 'Note:n1',
      seq: 3,
      seqSpan: [3, 3],
      data: { id: 'n1', title: 'world', done: true },
    },
  ],
  /** Expected row after all events (before a remove case). */
  expectedState: { id: 'n1', title: 'world', done: true },
  expectedCursor: 3,
};

/** Same as LIFECYCLE plus a remove. LiveList sets state null; createClient reducer may mark removed. */
export const LIFECYCLE_THEN_REMOVE = {
  ...LIFECYCLE,
  events: [
    ...LIFECYCLE.events,
    {
      type: 'Note.removed',
      scope: 'Note:n1',
      seq: 4,
      seqSpan: [4, 4],
      data: { id: 'n1' },
    },
  ],
  expectedState: null,
  expectedCursor: 4,
  expectedRemoved: true,
};

/**
 * Value-field update where LiveList receives a delta {set} and createClient
 * receives whole event.data. Final title must match.
 */
export const VALUE_SET = {
  scope: 'Note:n1',
  entity: 'Note',
  id: 'n1',
  bootstrap: {
    snapshot: { id: 'n1', title: 'old', done: false },
    seq: 1,
  },
  events: [
    {
      type: 'Note.updated',
      scope: 'Note:n1',
      seq: 2,
      seqSpan: [2, 2],
      data: { id: 'n1', title: 'new', done: false },
      delta: { title: { set: 'new' } },
    },
  ],
  expectedState: { id: 'n1', title: 'new', done: false },
  expectedCursor: 2,
};

/**
 * CRDT insert delta: LiveList applies insert on body; createClient reducer
 * uses whole event.data.body (server always sends the full string too).
 */
export const CRDT_INSERT = {
  scope: 'Note:n1',
  entity: 'Note',
  id: 'n1',
  bootstrap: {
    snapshot: { id: 'n1', body: 'hello' },
    seq: 1,
  },
  events: [
    {
      type: 'Note.updated',
      scope: 'Note:n1',
      seq: 2,
      seqSpan: [2, 2],
      data: { id: 'n1', body: 'hello world' },
      delta: { body: { insert: { at: 5, text: ' world' } } },
    },
  ],
  expectedState: { id: 'n1', body: 'hello world' },
  expectedCursor: 2,
};

/** Replay: after cursor=2, redelivery of seq 2 is duplicate; seq 4 is gap. */
export const REPLAY_EDGES = {
  scope: 'Note:n1',
  entity: 'Note',
  id: 'n1',
  bootstrap: {
    snapshot: { id: 'n1', title: 'a' },
    seq: 2,
  },
  duplicate: {
    type: 'Note.updated',
    scope: 'Note:n1',
    seq: 2,
    seqSpan: [2, 2],
    data: { id: 'n1', title: 'dup' },
  },
  gap: {
    type: 'Note.updated',
    scope: 'Note:n1',
    seq: 4,
    seqSpan: [4, 4],
    data: { id: 'n1', title: 'gap' },
  },
  next: {
    type: 'Note.updated',
    scope: 'Note:n1',
    seq: 3,
    seqSpan: [3, 3],
    data: { id: 'n1', title: 'ok' },
  },
  expectedAfterNext: { id: 'n1', title: 'ok' },
  expectedCursorAfterNext: 3,
};

/** createClient reducers that match LiveList whole-value CRUD for Note.* */
export function noteLifecycleEvents() {
  return [
    {
      type: 'Note.created',
      brand: 'event',
      reduce: (_state, e) => ({ ...e.data }),
    },
    {
      type: 'Note.updated',
      brand: 'event',
      reduce: (state, e) => {
        const next = { ...(state ?? {}) };
        if (e.data) {
          for (const key of Object.keys(e.data)) {
            if (key === 'id') {
              next.id = e.data.id;
              continue;
            }
            // Value-XOR-delta parity with LiveList: skip fields the delta owns
            // when delta is present (fold whole value only for non-delta fields).
            if (e.delta && Object.prototype.hasOwnProperty.call(e.delta, key)) continue;
            next[key] = e.data[key];
          }
        }
        if (e.delta) {
          for (const [field, d] of Object.entries(e.delta)) {
            if (d == null) continue;
            if ('set' in d) next[field] = d.set;
            else if ('delete' in d || 'insert' in d) {
              let s = next[field] ?? '';
              if (d.delete) s = s.slice(0, d.delete.at) + s.slice(d.delete.at + d.delete.length);
              if (d.insert) s = s.slice(0, d.insert.at) + d.insert.text + s.slice(d.insert.at);
              next[field] = s;
            }
          }
        }
        return next;
      },
    },
    {
      type: 'Note.removed',
      brand: 'event',
      reduce: () => null,
    },
  ];
}
