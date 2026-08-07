// Recipient-safe annotated-text fold envelopes for live delivery.
// Emits only contiguous text.apply / text.replace ops when the recipient's
// view of every affected block is fully visible and unredacted. All other
// operated shapes stay on the opaque snapshot/resync path.

import { parseEventType, EventKind } from './event-handle.mjs';
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.mjs';
import { textFamilyCheckpoint, restoreTextFamilyCheckpoint, materializeBlock } from './annotated-text-family.mjs';
import {
  ensureStream,
  ensureLease,
  hashClientNonce,
  issueAuthoringSnapshot,
  buildAuthoringEnvelope,
} from './annotated-text-authoring-stream.mjs';
import { authoringRedactionsForRecipient } from './annotated-text-recipient-projection.mjs';

function recovery(ctx, entity, id, reason) {
  return [{ type: 'resync', entity, id, seq: ctx.event.seq, reason }];
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function foldableOperation(operation) {
  if (!operation || typeof operation !== 'object') return null;
  if (operation.kind === 'text.apply'
    && typeof operation.blockId === 'string'
    && operation.blockId
    && Array.isArray(operation.operation)) {
    return { kind: 'text.apply', blockId: operation.blockId, operations: [operation.operation] };
  }
  if (operation.kind === 'text.replace'
    && typeof operation.blockId === 'string'
    && operation.blockId
    && Array.isArray(operation.operations)
    && operation.operations.length === 2) {
    return { kind: 'text.replace', blockId: operation.blockId, operations: operation.operations };
  }
  return null;
}

function scopeParts(scope) {
  if (typeof scope !== 'string') return { entity: null, id: null };
  const idx = scope.indexOf(':');
  if (idx <= 0) return { entity: null, id: null };
  return { entity: scope.slice(0, idx), id: scope.slice(idx + 1) };
}

/**
 * Build a single recipient-authorized annotated-text fold envelope, or null when
 * this projector should fall through to the ordinary envelope grammar.
 *
 * @returns {Promise<object[]|null>}
 */
export async function tryBuildAnnotatedTextFoldEnvelopes(ctx, { db, document }) {
  if (!document || document.descriptor?.kind !== 'annotatedText') return null;
  const event = ctx.event;
  const data = event?.data;
  if (!data || data.version !== 13 || data.id !== document.documentId) return null;

  let evHandle;
  try {
    evHandle = parseEventType(event.eventType ?? event.type);
  } catch {
    return null;
  }
  if (evHandle.kind !== EventKind.native
    || evHandle.nativeName !== 'operated'
    || evHandle.entity !== document.entity.name
    || evHandle.field !== document.fieldName) {
    return null;
  }

  const facts = data.facts;
  if (!facts || !exactKeys(facts, [
    'family', 'block', 'blocks', 'annotation', 'memberships', 'measurements',
    'lifecycle', 'result', 'prunedBlockIds', 'emptiedAnnotations', 'actorId',
    'selectedBlockId', 'selectedBlockIds', 'splitBlockIds', 'splitOps',
    'groupMembership', 'preimage', 'postimage', 'removedAnnotationIds',
  ])) {
    return null;
  }
  // First slice: contiguous text only. Structural consequences force snapshot.
  if (facts.prunedBlockIds.length
    || facts.emptiedAnnotations.length
    || facts.block
    || facts.blocks.length
    || facts.annotation
    || facts.memberships.length
    || facts.measurements.length
    || facts.splitBlockIds.length
    || facts.splitOps.length
    || facts.groupMembership
    || facts.preimage.length
    || facts.postimage.length
    || facts.removedAnnotationIds.length) {
    return null;
  }

  const foldable = foldableOperation(data.operation);
  if (!foldable || !facts.family || typeof facts.family !== 'object') return null;

  const { entity: scopeEntity, id: scopeId } = scopeParts(ctx.scope);
  const entityName = scopeEntity ?? document.entity.name;
  const id = scopeId ?? document.documentId;

  const row = db.prepare(`SELECT * FROM ${document.entity.name} WHERE id = ?`).get(document.documentId);
  if (!row) return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');

  let recipient;
  try {
    recipient = await projectAnnotatedTextSnapshot({
      db,
      entity: document.entity,
      row,
      principal: ctx.principal,
      fieldName: document.fieldName,
      descriptor: document.descriptor,
      mintBasis: false,
    });
  } catch {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  const block = recipient.blocks.find((candidate) => candidate.id === foldable.blockId);
  if (!block || block.kind !== 'visible' || block.redactions?.length) {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }
  if ((authoringRedactionsForRecipient(recipient, foldable.blockId) ?? []).length) {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  const prefix = `${document.entity.name}_${document.fieldName}`;
  let family;
  try {
    const state = db.prepare(`SELECT family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(document.documentId);
    if (!state) return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
    family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
    if (JSON.stringify(textFamilyCheckpoint(family)) !== JSON.stringify(facts.family)) {
      return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
    }
    if (materializeBlock(family, foldable.blockId) !== block.text) {
      return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
    }
    for (const operation of foldable.operations) {
      if (!Array.isArray(operation) || operation[0] !== 'workbench.text' || operation[1] !== 1) {
        return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
      }
    }
  } catch {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  const fence = event.seq;
  const baseCursor = fence - 1;
  if (!Number.isSafeInteger(baseCursor) || baseCursor < 0) {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  const authoring = mintFoldAuthoring({
    db,
    document,
    principal: ctx.principal,
    fence,
    recipient,
    family,
    prefix,
  });

  const loggedEvent = {
    type: event.eventType ?? event.type,
    scope: event.scope,
    seq: event.seq,
    committedAt: event.committedAt,
  };
  if (event.actionId !== undefined && event.actionId !== null) loggedEvent.actionId = event.actionId;

  const fold = Object.freeze({
    kind: 'annotatedText',
    version: 1,
    field: document.fieldName,
    baseCursor,
    fence,
    text: Object.freeze({
      reducer: 'workbench.text',
      operations: Object.freeze(foldable.operations.map((operation) => Object.freeze(structuredClone(operation)))),
    }),
    projection: Object.freeze({
      changedBlocks: Object.freeze([Object.freeze({ id: foldable.blockId, text: block.text })]),
      removedBlockIds: Object.freeze([]),
    }),
    authoring: Object.freeze({
      acknowledgementFence: fence,
      positionBlocks: authoring?.positionBlocks ?? Object.freeze([]),
      ...(authoring?.envelope
        ? {
          stream: authoring.envelope.stream,
          lease: authoring.envelope.lease,
          snapshot: authoring.envelope.snapshot,
        }
        : {}),
    }),
    family: facts.family,
  });

  return [Object.freeze({
    type: 'event',
    entity: entityName,
    id,
    seq: event.seq,
    seqSpan: Object.freeze([event.seq, event.seq]),
    event: Object.freeze(loggedEvent),
    fold,
  })];
}

function mintFoldAuthoring({ db, document, principal, fence, recipient, family, prefix }) {
  if (typeof document.clientNonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(document.clientNonce)) {
    return null;
  }
  const stream = ensureStream({
    db,
    prefix,
    documentId: document.documentId,
    principalType: principal?.type ?? 'principal',
    principalId: principal?.id ?? '',
  });
  const lease = ensureLease({
    db,
    prefix,
    streamId: stream.id,
    clientNonceHash: hashClientNonce(document.clientNonce),
  });
  if (!lease) return null;

  const groupIdByBlock = new Map(
    db.prepare(`SELECT block_id, group_id FROM ${prefix}_block_group WHERE block_id IN (SELECT id FROM ${prefix}_block WHERE document_id = ?)`).all(document.documentId)
      .map((row) => [row.block_id, row.group_id]),
  );
  const visibleBlocks = recipient.blocks.filter((block) => block.kind === 'visible').map((block) => block.id);
  const issued = issueAuthoringSnapshot({
    db,
    prefix,
    leaseId: lease.id,
    fence,
    positions: visibleBlocks.map((blockId) => ({
      blockId,
      familyCheckpoint: textFamilyCheckpoint(family),
      visibleAtIssue: true,
      redactions: authoringRedactionsForRecipient(recipient, blockId),
    })),
    groups: recipient.blockGroups.map((group) => {
      const groupId = groupIdByBlock.get(group.blockIds[0]);
      return {
        groupId: groupId ?? group.blockIds[0],
        visibleBlocks: group.blockIds,
        assignable: group.blockIds.every((blockId) => visibleBlocks.includes(blockId)),
      };
    }),
  });
  if (!issued) return null;
  const envelope = buildAuthoringEnvelope({
    db,
    prefix,
    streamToken: stream.id,
    leaseToken: lease.id,
    leaseId: lease.id,
    snapshotToken: issued.snapshot.id,
    fence,
    positionFrames: issued.positionFrames,
    groupFrames: issued.groupFrames,
    splitResolutions: [],
  });
  return {
    envelope,
    positionBlocks: Object.freeze(issued.positionFrames.map((frame) => Object.freeze({
      blockId: frame.blockId,
      positionToken: frame.token,
    }))),
  };
}
