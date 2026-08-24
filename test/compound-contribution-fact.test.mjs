// W2 origin envelope + application-transition validator (scope#992 rev 3/4).
// Unit tests for the compound-contribution-fact grammar: exact-key origin and
// compensation envelopes, the eight semantic transition rules, canonical JSON
// comparison, and the application view. Production-path tests live in
// compound-private-fact-commit.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COMPOUND_COMPENSATION_KIND,
  COMPOUND_ENVELOPE_VERSION,
  COMPOUND_ORIGIN_KIND,
  applicationPrivateFactView,
  constructCompoundCompensationEnvelope,
  constructCompoundOriginEnvelope,
  compoundKindOf,
  isCompoundContributionFact,
  parseCompoundApplicationTransitionInput,
  parseCompoundContributionFact,
  validateApplicationTransition,
} from '../build/compound-contribution-fact.mjs';
import { captureDeleteContribution } from '../build/annotated-text-delete-history.mjs';
import { importTextToFamily } from '../build/annotated-text-continuous.mjs';

function deleteContribution(documentId = 'doc-1', text = 'hello world') {
  const family = importTextToFamily(documentId, 'a'.repeat(32), text);
  return captureDeleteContribution({ documentId, family, fromUtf16: 0, toUtf16: 5 });
}

test('compound origin envelope constructs and parses canonically', () => {
  const contribution = deleteContribution();
  const envelope = constructCompoundOriginEnvelope({
    application: { before: null, after: { correctionId: 'c-1' } },
    contributions: [contribution],
  });
  assert.equal(envelope.version, COMPOUND_ENVELOPE_VERSION);
  assert.equal(envelope.kind, COMPOUND_ORIGIN_KIND);
  assert.equal(compoundKindOf(envelope), COMPOUND_ORIGIN_KIND);
  assert.equal(isCompoundContributionFact(envelope), true);
  const parsed = parseCompoundContributionFact(envelope);
  assert.deepEqual(parsed.application, { before: null, after: { correctionId: 'c-1' } });
  assert.equal(parsed.contributions.length, 1);
  assert.equal(parsed.contributions[0].documentId, 'doc-1');
});

test('compound origin rejects a non-canonical contribution', () => {
  assert.throws(
    () => constructCompoundOriginEnvelope({
      application: { before: null, after: { x: 1 } },
      contributions: [{ version: 2, kind: 'annotated-text.contribution', documentId: 'doc-1', contribution: {} }],
    }),
    (error) => /invalid compound envelope/.test(error.message),
  );
});

test('compound origin rejects unknown envelope keys on parse', () => {
  const contribution = deleteContribution();
  const envelope = constructCompoundOriginEnvelope({
    application: { before: null, after: { x: 1 } },
    contributions: [contribution],
  });
  const forged = { ...envelope, extra: true };
  assert.throws(
    () => parseCompoundContributionFact(forged),
    (error) => /invalid compound envelope/.test(error.message),
  );
});

test('compound compensation envelope carries closed linkage', () => {
  const contribution = deleteContribution();
  const envelope = constructCompoundCompensationEnvelope({
    application: { before: { correctionId: 'c-1' }, after: null },
    contributions: [contribution],
    linkage: { rootActionId: 'a1', targetActionId: 'a2', direction: 'undo', outcome: 'applied' },
  });
  assert.equal(envelope.kind, COMPOUND_COMPENSATION_KIND);
  assert.deepEqual(envelope.linkage, { rootActionId: 'a1', targetActionId: 'a2', direction: 'undo', outcome: 'applied' });
  const parsed = parseCompoundContributionFact(envelope);
  assert.deepEqual(parsed.linkage, envelope.linkage);
});

test('compound compensation rejects a malformed linkage', () => {
  assert.throws(
    () => constructCompoundCompensationEnvelope({
      application: { before: null, after: { x: 1 } },
      contributions: [],
      linkage: { rootActionId: '', targetActionId: 'a2', direction: 'undo', outcome: 'applied' },
    }),
    (error) => /invalid compound envelope/.test(error.message),
  );
});

test('parseCompoundApplicationTransitionInput enforces the exact grammar', () => {
  const input = parseCompoundApplicationTransitionInput({ version: 1, expected: null, replacement: { correctionId: 'c-1' } });
  assert.deepEqual(input, { version: 1, expected: null, replacement: { correctionId: 'c-1' } });
  assert.throws(() => parseCompoundApplicationTransitionInput({ version: 1, expected: null }), /must be/);
  assert.throws(() => parseCompoundApplicationTransitionInput({ version: 2, expected: null, replacement: null }), /version must be 1/);
  assert.throws(() => parseCompoundApplicationTransitionInput({ version: 1, before: null, after: null }), /must be/);
});

function transition() {
  const originApplication = { before: null, after: { correctionId: 'c-1' } };
  const targetApplication = originApplication; // head == origin
  const translatedInput = { version: 1, expected: { correctionId: 'c-1' }, replacement: null };
  const returnedApplication = { before: { correctionId: 'c-1' }, after: null };
  return validateApplicationTransition({ originApplication, targetApplication, translatedInput, returnedApplication });
}

test('validator accepts the exact inverse of the origin transition', () => {
  const canonical = transition();
  assert.deepEqual(canonical, { before: { correctionId: 'c-1' }, after: null });
});

test('validator rejects wrong expected (field: expected)', () => {
  assert.throws(
    () => validateApplicationTransition({
      originApplication: { before: null, after: { correctionId: 'c-1' } },
      targetApplication: { before: null, after: { correctionId: 'c-1' } },
      translatedInput: { version: 1, expected: { correctionId: 'WRO' }, replacement: null },
      returnedApplication: { before: { correctionId: 'WRO' }, after: null },
    }),
    (error) => error.message === 'compound application transition mismatch: expected',
  );
});

test('validator rejects wrong replacement (field: replacement)', () => {
  assert.throws(
    () => validateApplicationTransition({
      originApplication: { before: null, after: { correctionId: 'c-1' } },
      targetApplication: { before: null, after: { correctionId: 'c-1' } },
      translatedInput: { version: 1, expected: { correctionId: 'c-1' }, replacement: { correctionId: 'WRO' } },
      returnedApplication: { before: { correctionId: 'c-1' }, after: { correctionId: 'WRO' } },
    }),
    (error) => error.message === 'compound application transition mismatch: replacement',
  );
});

test('validator rejects returned.before drifting from expected', () => {
  assert.throws(
    () => validateApplicationTransition({
      originApplication: { before: null, after: { correctionId: 'c-1' } },
      targetApplication: { before: null, after: { correctionId: 'c-1' } },
      translatedInput: { version: 1, expected: { correctionId: 'c-1' }, replacement: null },
      returnedApplication: { before: { correctionId: 'other' }, after: null },
    }),
    (error) => error.message === 'compound application transition mismatch: returned.before',
  );
});

test('validator rejects returned.after drifting from replacement', () => {
  assert.throws(
    () => validateApplicationTransition({
      originApplication: { before: null, after: { correctionId: 'c-1' } },
      targetApplication: { before: null, after: { correctionId: 'c-1' } },
      translatedInput: { version: 1, expected: { correctionId: 'c-1' }, replacement: null },
      returnedApplication: { before: { correctionId: 'c-1' }, after: { correctionId: 'other' } },
    }),
    (error) => error.message === 'compound application transition mismatch: returned.after',
  );
});

test('validator rejects an applied transition whose before == after', () => {
  // Rule 8 is a semantic backstop: a stored head can never have before == after
  // for an applied transition, so a handler that smuggles an application no-op
  // must fail even when its returned transition agrees with the degenerate
  // (malformed) head's expected/replacement.
  assert.throws(
    () => validateApplicationTransition({
      originApplication: { before: null, after: { correctionId: 'c-1' } },
      targetApplication: { before: { correctionId: 'c-1' }, after: { correctionId: 'c-1' } },
      translatedInput: { version: 1, expected: { correctionId: 'c-1' }, replacement: { correctionId: 'c-1' } },
      returnedApplication: { before: { correctionId: 'c-1' }, after: { correctionId: 'c-1' } },
    }),
    (error) => /must differ/.test(error.message),
  );
});

test('canonical JSON comparison normalizes object key order', () => {
  // Origin: null -> {z, a}. Undo head: {a, z} -> null (keys reordered).
  // Redo: expected = null, replacement = {a, z} (reordered); handler returns
  // before = null, after = {z, a} (reordered). Every equality is canonical.
  const canonical = validateApplicationTransition({
    originApplication: { before: null, after: { z: 1, a: 2 } },
    targetApplication: { before: { a: 2, z: 1 }, after: null },
    translatedInput: { version: 1, expected: null, replacement: { a: 2, z: 1 } },
    returnedApplication: { before: null, after: { z: 1, a: 2 } },
  });
  assert.deepEqual(canonical, { before: null, after: { z: 1, a: 2 } });
  assert.equal(canonicalJsonOf(canonical.after), '{"a":2,"z":1}');
});

function canonicalJsonOf(value) {
  return solutionCanonicalJson(value);
}

function solutionCanonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(solutionCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${solutionCanonicalJson(value[name])}`).join(',')}}`;
  }
  return String(value);
}

test('applicationPrivateFactView unwraps compound envelopes only', () => {
  const contribution = deleteContribution();
  const envelope = constructCompoundOriginEnvelope({
    application: { before: null, after: { correctionId: 'c-1' } },
    contributions: [contribution],
  });
  const parsed = parseCompoundContributionFact(envelope);
  const view = applicationPrivateFactView(parsed);
  assert.deepEqual(view, { before: null, after: { correctionId: 'c-1' } });
  assert.equal(Object.hasOwn(view, 'contributions'), false);
  assert.equal(Object.hasOwn(view, 'kind'), false);
  // Non-compound facts pass through unchanged.
  const plain = { before: { a: 1 }, after: null };
  assert.deepEqual(applicationPrivateFactView(plain), plain);
});

test('compound kind detection requires the exact version', () => {
  assert.equal(compoundKindOf({ version: 1, kind: COMPOUND_ORIGIN_KIND }), COMPOUND_ORIGIN_KIND);
  assert.equal(compoundKindOf({ version: 0, kind: COMPOUND_ORIGIN_KIND }), null);
  assert.equal(compoundKindOf({ version: 1, kind: 'other' }), null);
});