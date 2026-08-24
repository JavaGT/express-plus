// W2 application-transition contract (scope#992 rev 3 §1 / Finding 3 origin).
// The package-owned validator runs inside the coordinated transaction on a
// history move, before _PrivateActionFact canonicalization. W2 owns the
// validator and this suite; W3's complete durable-history move execution
// consumes it. Every mismatch produces the exact prefix
// `compound application transition mismatch: <field>` and this suite asserts
// each field separately against real canonical envelope state, with zero
// writes to _PrivateActionFact / _ActionReceipt / cursor / operated-event /
// correction-ledger.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  constructCompoundOriginEnvelope,
  parseCompoundContributionFact,
  validateApplicationTransition,
  applicationPrivateFactView,
} from '../build/compound-contribution-fact.mjs';
import { captureDeleteContribution } from '../build/annotated-text-delete-history.mjs';
import { importTextToFamily } from '../build/annotated-text-continuous.mjs';

function originEnvelope() {
  const family = importTextToFamily('doc-1', 'a'.repeat(32), 'hello world');
  const contribution = captureDeleteContribution({ documentId: 'doc-1', family, fromUtf16: 0, toUtf16: 5 });
  return parseCompoundContributionFact(constructCompoundOriginEnvelope({
    application: { before: null, after: { correctionId: 'c-1' } },
    contributions: [contribution],
  }));
}

const MISMATCH_PREFIX = 'compound application transition mismatch: ';

function expectMismatch(field, call) {
  assert.throws(call, (error) => {
    assert.equal(error.message.startsWith(MISMATCH_PREFIX), true, `expected the mismatch prefix, got: ${error.message}`);
    assert.equal(error.message, `${MISMATCH_PREFIX}${field}`);
    return true;
  });
}

test('validated origin application is the canonical envelope half', () => {
  const envelope = originEnvelope();
  const view = applicationPrivateFactView(envelope);
  assert.deepEqual(view, { before: null, after: { correctionId: 'c-1' } });
  assert.equal(Object.hasOwn(view, 'contributions'), false);
});

test('expected must equal the target after (undo direction)', () => {
  // Undo of the origin: head == origin { null -> correction }.
  const envelope = originEnvelope();
  const target = envelope.application;
  const returned = { before: envelope.application.after, after: envelope.application.before };
  expectMismatch('expected', () => validateApplicationTransition({
    originApplication: envelope.application,
    targetApplication: target,
    translatedInput: { version: 1, expected: { correctionId: 'WRONG' }, replacement: target.before },
    returnedApplication: returned,
  }));
});

test('replacement must equal the target before', () => {
  const envelope = originEnvelope();
  const target = envelope.application;
  const returned = { before: envelope.application.after, after: envelope.application.before };
  expectMismatch('replacement', () => validateApplicationTransition({
    originApplication: envelope.application,
    targetApplication: target,
    translatedInput: { version: 1, expected: target.after, replacement: { correctionId: 'WRONG' } },
    returnedApplication: returned,
  }));
});

test('returned.before must equal expected', () => {
  const envelope = originEnvelope();
  const target = envelope.application;
  expectMismatch('returned.before', () => validateApplicationTransition({
    originApplication: envelope.application,
    targetApplication: target,
    translatedInput: { version: 1, expected: target.after, replacement: target.before },
    returnedApplication: { before: { correctionId: 'DRIFTED' }, after: target.before },
  }));
});

test('returned.after must equal replacement', () => {
  const envelope = originEnvelope();
  const target = envelope.application;
  expectMismatch('returned.after', () => validateApplicationTransition({
    originApplication: envelope.application,
    targetApplication: target,
    translatedInput: { version: 1, expected: target.after, replacement: target.before },
    returnedApplication: { before: target.after, after: { correctionId: 'DRIFTED' } },
  }));
});

test('applied transition must differ', () => {
  // Rule 8 is a semantic backstop: a stored applied head can never have
  // before == after, so a handler that smuggles an application no-op must fail
  // even when it agrees with the degenerate head's expected/replacement.
  const envelope = originEnvelope();
  const degenerate = { before: envelope.application.after, after: envelope.application.after };
  expectMismatch('application transition before and after must differ for an applied transition', () => validateApplicationTransition({
    originApplication: envelope.application,
    targetApplication: degenerate,
    translatedInput: { version: 1, expected: degenerate.after, replacement: degenerate.after },
    returnedApplication: { before: degenerate.after, after: degenerate.after },
  }));
});

test('valid undo of the origin returns the exact inverse', () => {
  const envelope = originEnvelope();
  const { before, after } = envelope.application;
  const validated = validateApplicationTransition({
    originApplication: { before, after },
    targetApplication: { before, after },
    translatedInput: { version: 1, expected: after, replacement: before },
    returnedApplication: { before: after, after: before },
  });
  assert.deepEqual(validated, { before: after, after: before });
});

test('valid redo of a compensation head returns the forward transition', () => {
  const envelope = originEnvelope();
  // Undo head: { correction -> null }.
  const head = { before: envelope.application.after, after: envelope.application.before };
  const validated = validateApplicationTransition({
    originApplication: envelope.application,
    targetApplication: head,
    // Redo: expected = head.after (null), replacement = head.before (correction).
    translatedInput: { version: 1, expected: head.after, replacement: head.before },
    returnedApplication: { before: head.after, after: head.before },
  });
  assert.deepEqual(validated, envelope.application);
});

test('shape-valid correction fact with changed provenance field fails', () => {
  // The returned transition matches expected/replacement but the fact carries
  // provenance Workbench does not accept (a changed provenance field).
  const envelope = originEnvelope();
  const { before, after } = envelope.application;
  assert.throws(
    () => validateApplicationTransition({
      originApplication: { before, after },
      targetApplication: { before, after },
      translatedInput: { version: 1, expected: after, replacement: before },
      returnedApplication: { before: { ...after, provenance: 'changed' }, after: before },
    }),
    (error) => error.message === 'compound application transition mismatch: returned.before',
  );
});

test('parseCompoundApplicationTransitionInput rejects a {before, after} fact', () => {
  assert.throws(
    () => validateApplicationTransition({
      originApplication: originEnvelope().application,
      targetApplication: originEnvelope().application,
      translatedInput: { version: 1, before: null, after: { x: 1 } },
      returnedApplication: { before: null, after: { x: 1 } },
    }),
    /must be \{ version: 1, expected, replacement \}/,
  );
});