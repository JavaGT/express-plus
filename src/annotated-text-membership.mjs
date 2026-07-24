import {
  assertMembershipRange, assertStructuralEndpoint, compareStructuralEndpoints,
  materializeBlock, rgaTraversal, resolvePositionToEndpoint,
} from './annotated-text-family.mjs';

function fail(message) {
  throw new Error(`invalid annotated-text membership: ${message}`);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

function assertAnnotationId(value) {
  if (typeof value !== 'string' || value.length === 0) fail('annotation id must be a non-empty string');
  return value;
}

function assertBlockId(value) {
  if (typeof value !== 'string' || value.length === 0) fail('block id must be a non-empty string');
  return value;
}

function assertOrdinal(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ordinal must be a non-negative safe integer');
  return value;
}

// --- Public validation ---

export function assertAnnotation(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) fail('annotation must be a non-array object');
  const allowedKeys = ['id', 'family', 'empty', 'protectedTargetIds'];
  for (const key of Object.keys(annotation)) {
    if (!allowedKeys.includes(key)) fail(`unknown annotation key: ${key}`);
  }
  assertAnnotationId(annotation.id);
  if (typeof annotation.family !== 'string' || annotation.family.length === 0) fail('annotation family must be a non-empty string');
  if (annotation.empty !== 'delete' && annotation.empty !== 'orphan') fail('annotation empty must be delete or orphan');
  if (annotation.protectedTargetIds !== undefined) {
    if (!Array.isArray(annotation.protectedTargetIds)) fail('protectedTargetIds must be an array');
    for (const id of annotation.protectedTargetIds) {
      if (typeof id !== 'string' || id.length === 0) fail('protectedTargetIds must contain non-empty strings');
    }
    const sorted = [...annotation.protectedTargetIds].sort();
    const unique = sorted.filter((id, i) => i === 0 || id !== sorted[i - 1]);
    if (JSON.stringify(annotation.protectedTargetIds) !== JSON.stringify(unique)) fail('protectedTargetIds must be sorted and unique');
  }
  return deepFreeze({
    id: annotation.id,
    family: annotation.family,
    empty: annotation.empty,
    protectedTargetIds: annotation.protectedTargetIds !== undefined
      ? Object.freeze([...annotation.protectedTargetIds])
      : undefined,
  });
}

export function assertMembership(membership) {
  if (!membership || typeof membership !== 'object' || Array.isArray(membership)) fail('membership must be a non-array object');
  const allowedKeys = ['annotationId', 'blockId', 'ordinal', 'start', 'end'];
  for (const key of Object.keys(membership)) {
    if (!allowedKeys.includes(key)) fail(`unknown membership key: ${key}`);
  }
  assertAnnotationId(membership.annotationId);
  assertBlockId(membership.blockId);
  assertOrdinal(membership.ordinal);
  assertStructuralEndpoint(membership.start);
  assertStructuralEndpoint(membership.end);
  return deepFreeze({
    annotationId: membership.annotationId,
    blockId: membership.blockId,
    ordinal: membership.ordinal,
    start: membership.start,
    end: membership.end,
  });
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`);
  return value;
}

function assertEndpointTuple(value) {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'endpoint') {
    fail('orphan endpoint must be ["endpoint", frontier, point]');
  }
  return assertStructuralEndpoint({ basisFrontier: value[1], point: value[2] });
}

export function assertAnnotationLastMemberships(value) {
  if (!Array.isArray(value) || value.length !== 5 ||
      value[0] !== 'workbench.annotation-last-memberships' || value[1] !== 1) {
    fail('last memberships must be a workbench.annotation-last-memberships v1 tuple');
  }
  assertPositiveSafeInteger(value[2], 'structural revision');
  if (!Array.isArray(value[3])) fail('orphan protected target IDs must be an array');
  const targetIds = value[3];
  const sortedTargetIds = [...targetIds].sort();
  if (!targetIds.every((id) => typeof id === 'string' && id.length > 0) ||
      JSON.stringify(targetIds) !== JSON.stringify(sortedTargetIds) ||
      new Set(targetIds).size !== targetIds.length) {
    fail('orphan protected target IDs must be sorted unique non-empty strings');
  }
  if (!Array.isArray(value[4]) || value[4].length === 0) fail('orphan membership entries must be non-empty');
  const blockIds = new Set();
  const entries = value[4].map((entry, ordinal) => {
    if (!Array.isArray(entry) || entry.length !== 4 || entry[0] !== ordinal) {
      fail('orphan membership entries must have dense ordinals');
    }
    assertBlockId(entry[1]);
    if (blockIds.has(entry[1])) fail('orphan membership block IDs must be unique');
    blockIds.add(entry[1]);
    const start = assertEndpointTuple(entry[2]);
    const end = assertEndpointTuple(entry[3]);
    return Object.freeze([ordinal, entry[1], Object.freeze(['endpoint', start.basisFrontier, start.point]), Object.freeze(['endpoint', end.basisFrontier, end.point])]);
  });
  return deepFreeze(['workbench.annotation-last-memberships', 1, value[2], [...targetIds], entries]);
}

// --- Internal helpers ---

function findAnnotation(annotations, annotationId) {
  return annotations.find(a => a.id === annotationId);
}

function findMembership(memberships, annotationId, blockId) {
  return memberships.find(m => m.annotationId === annotationId && m.blockId === blockId);
}

function membershipsForAnnotation(memberships, annotationId) {
  return memberships.filter(m => m.annotationId === annotationId);
}

function blockMemberships(memberships, blockId) {
  return memberships.filter(m => m.blockId === blockId);
}

function blockIndex(family, blockId) {
  return family.blocks.findIndex(b => b.id === blockId);
}

function blockVisibleLength(family, blockId) {
  return materializeBlock(family, blockId).length;
}

function isBlockNonempty(family, blockId) {
  return blockVisibleLength(family, blockId) > 0;
}

function normalizeOrdinals(memberships, family) {
  const byAnnotation = new Map();
  for (const m of memberships) {
    const list = byAnnotation.get(m.annotationId) ?? [];
    list.push(m);
    byAnnotation.set(m.annotationId, list);
  }
  const result = [];
  for (const [, list] of byAnnotation) {
    const sorted = [...list].sort((a, b) => {
      const aIdx = blockIndex(family, a.blockId);
      const bIdx = blockIndex(family, b.blockId);
      return aIdx - bIdx;
    });
    for (let i = 0; i < sorted.length; i++) {
      result.push(deepFreeze({ ...sorted[i], ordinal: i }));
    }
  }
  return result;
}

function hasProtectorOverlap(family, annotations, memberships, annotationId, blockId) {
  for (const ann of annotations) {
    if (!ann.protectedTargetIds || ann.protectedTargetIds.length === 0) continue;
    if (!ann.protectedTargetIds.includes(annotationId)) continue;
    if (findMembership(memberships, ann.id, blockId)) return true;
  }
  return false;
}

function canonicalBlockEndpoints(family, blockId) {
  const frontier = family.checkpoint.frontier;
  const length = blockVisibleLength(family, blockId);
  if (length === 0) fail(`cannot compute canonical endpoints for fully tombstoned block: ${blockId}`);

  let start;
  const bIdx = blockIndex(family, blockId);
  if (bIdx === 0) {
    start = assertStructuralEndpoint({ point: ['point', ['root'], 'left'], basisFrontier: frontier });
  } else {
    start = resolvePositionToEndpoint(family, blockId, 0, frontier);
  }

  const end = resolvePositionToEndpoint(family, blockId, length, frontier);
  return { start, end };
}

// --- Public API ---

export function addMembership(family, annotations, memberships, annotationId, blockId, startEndpoint, endEndpoint) {
  const annotation = findAnnotation(annotations, annotationId);
  if (!annotation) fail(`annotation not found: ${annotationId}`);

  const bIdx = blockIndex(family, blockId);
  if (bIdx === -1) fail(`block not found: ${blockId}`);

  if (findMembership(memberships, annotationId, blockId)) {
    fail(`duplicate membership for annotation ${annotationId} on block ${blockId}`);
  }

  if (!isBlockNonempty(family, blockId)) {
    fail('cannot add membership to fully tombstoned block');
  }

  assertMembershipRange(family, blockId, startEndpoint, endEndpoint);
  const canonical = canonicalBlockEndpoints(family, blockId);
  if (compareStructuralEndpoints(family, startEndpoint, canonical.start) !== 0 ||
      compareStructuralEndpoints(family, endEndpoint, canonical.end) !== 0) {
    fail('active membership must cover the canonical whole block');
  }

  const existing = membershipsForAnnotation(memberships, annotationId);
  let ordinal = 0;
  for (const m of existing) {
    if (blockIndex(family, m.blockId) < bIdx) ordinal = m.ordinal + 1;
  }

  const newMembership = assertMembership({
    annotationId,
    blockId,
    ordinal,
    start: startEndpoint,
    end: endEndpoint,
  });

  const newMemberships = [...memberships, newMembership];
  const normalized = normalizeOrdinals(newMemberships, family);

  return deepFreeze({
    annotations,
    memberships: normalized,
    outcomes: [],
  });
}

export function removeMembership(family, annotations, memberships, annotationId, blockId, { structuralRevision } = {}) {
  const annotation = findAnnotation(annotations, annotationId);
  if (!annotation) fail(`annotation not found: ${annotationId}`);

  const membership = findMembership(memberships, annotationId, blockId);
  if (!membership) fail(`membership not found for annotation ${annotationId} on block ${blockId}`);

  const annMemberships = membershipsForAnnotation(memberships, annotationId);
  const remaining = annMemberships.filter(m => m.blockId !== blockId);

  if (remaining.length > 0) {
    const filtered = memberships.filter(m => !(m.annotationId === annotationId && m.blockId === blockId));
    return deepFreeze({
      annotations,
      memberships: normalizeOrdinals(filtered, family),
      outcomes: [],
    });
  }

  if (hasProtectorOverlap(family, annotations, memberships, annotationId, blockId)) {
    fail(`annotation ${annotationId} is protected from deletion`);
  }

  if (annotation.empty === 'delete') {
    return deepFreeze({
      annotations: annotations.filter(a => a.id !== annotationId),
      memberships: memberships.filter(m => m.annotationId !== annotationId),
      outcomes: [deepFreeze({ type: 'delete', annotationId })],
    });
  } else {
    assertPositiveSafeInteger(structuralRevision, 'structural revision');
    const ordered = [...annMemberships].sort((left, right) => blockIndex(family, left.blockId) - blockIndex(family, right.blockId));
    const lastMemberships = assertAnnotationLastMemberships([
      'workbench.annotation-last-memberships',
      1,
      structuralRevision,
      annotation.protectedTargetIds ?? [],
      ordered.map((item, ordinal) => [
        ordinal,
        item.blockId,
        ['endpoint', item.start.basisFrontier, item.start.point],
        ['endpoint', item.end.basisFrontier, item.end.point],
      ]),
    ]);
    return deepFreeze({
      annotations: annotations.filter(a => a.id !== annotationId),
      memberships: memberships.filter(m => m.annotationId !== annotationId),
      outcomes: [deepFreeze({
        type: 'orphan',
        annotationId,
        savedQuote: ordered.map((item) => materializeBlock(family, item.blockId)).join(''),
        lastMemberships,
      })],
    });
  }
}

export function splitBlockMemberships(family, annotations, memberships, blockId, newBlockId) {
  const bIdx = blockIndex(family, blockId);
  if (bIdx === -1) fail(`block not found: ${blockId}`);
  const nbIdx = blockIndex(family, newBlockId);
  if (nbIdx === -1) fail(`block not found: ${newBlockId}`);
  if (nbIdx !== bIdx + 1) fail('new block must be adjacent after source block');

  const sourceMemberships = blockMemberships(memberships, blockId);
  const filtered = memberships.filter(m => m.blockId !== blockId);
  const leftNonempty = isBlockNonempty(family, blockId);
  const rightNonempty = isBlockNonempty(family, newBlockId);

  for (const m of sourceMemberships) {
    if (leftNonempty) {
      const ep = canonicalBlockEndpoints(family, blockId);
      filtered.push(assertMembership({
        annotationId: m.annotationId,
        blockId,
        ordinal: 0,
        start: ep.start,
        end: ep.end,
      }));
    }
    if (rightNonempty) {
      const ep = canonicalBlockEndpoints(family, newBlockId);
      filtered.push(assertMembership({
        annotationId: m.annotationId,
        blockId: newBlockId,
        ordinal: 0,
        start: ep.start,
        end: ep.end,
      }));
    }
  }

  return deepFreeze({
    annotations,
    memberships: normalizeOrdinals(filtered, family),
    outcomes: [],
  });
}

export function mergeBlocksMemberships(family, annotations, memberships, leftBlockId, rightBlockId) {
  const leftIdx = blockIndex(family, leftBlockId);
  if (leftIdx === -1) fail(`block not found: ${leftBlockId}`);
  const rightIdx = blockIndex(family, rightBlockId);
  if (rightIdx === -1) fail(`block not found: ${rightBlockId}`);
  if (rightIdx !== leftIdx + 1) fail('blocks must be adjacent');

  const leftMemberships = blockMemberships(memberships, leftBlockId);
  const rightMemberships = blockMemberships(memberships, rightBlockId);

  const leftIds = new Set(leftMemberships.map(m => m.annotationId));
  const rightIds = new Set(rightMemberships.map(m => m.annotationId));

  if (leftIds.size !== rightIds.size) fail('annotation-ID membership sets must be exactly equal');
  for (const id of leftIds) {
    if (!rightIds.has(id)) fail('annotation-ID membership sets must be exactly equal');
  }

  const leftEp = canonicalBlockEndpoints(family, leftBlockId);
  const rightEp = canonicalBlockEndpoints(family, rightBlockId);

  for (const m of leftMemberships) {
    assertMembershipRange(family, leftBlockId, m.start, m.end);
    if (compareStructuralEndpoints(family, m.start, leftEp.start) !== 0 ||
        compareStructuralEndpoints(family, m.end, leftEp.end) !== 0) {
      fail('left membership must be canonical full coverage');
    }
  }
  for (const m of rightMemberships) {
    assertMembershipRange(family, rightBlockId, m.start, m.end);
    if (compareStructuralEndpoints(family, m.start, rightEp.start) !== 0 ||
        compareStructuralEndpoints(family, m.end, rightEp.end) !== 0) {
      fail('right membership must be canonical full coverage');
    }
  }

  const merged = [];

  for (const m of leftMemberships) {
    merged.push(assertMembership({
      annotationId: m.annotationId,
      blockId: leftBlockId,
      ordinal: 0,
      start: leftEp.start,
      end: rightEp.end,
    }));
  }

  const filtered = memberships.filter(m => m.blockId !== leftBlockId && m.blockId !== rightBlockId);
  filtered.push(...merged);

  return deepFreeze({
    annotations,
    memberships: normalizeOrdinals(filtered, family),
    outcomes: [],
  });
}
