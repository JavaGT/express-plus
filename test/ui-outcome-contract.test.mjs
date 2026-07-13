// ui-outcome-contract.test.mjs — RED tests for UI binding consumption of the
// new DispatchResult contract.
//
// DispatchResult exact arms (no optional error compatibility field):
//   { ok: true, status: 'committed' }
//   { ok: false, status: 'failed-rolled-back', failure: WorkbenchFailure }
//   { ok: false, status: 'outcome-unknown', deliveryError: { message: string } }
//
// The bindings must preserve the distinction and display the matching message.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let bindAction, bindField;
before(async () => {
  const mod = await import('../public/workbench-ui-bindings.mjs');
  bindAction = mod.bindAction;
  bindField = mod.bindField;
});

function noopStore(overrides = {}) {
  return {
    overlayFor: () => null,
    onRender: () => () => {},
    dispatch: async () => ({ ok: true, status: 'committed' }),
    update: async () => ({ ok: true, status: 'committed' }),
    ...overrides,
  };
}

describe('bindAction — DispatchResult contract', () => {
  it('displays failure.message for failed-rolled-back outcome', async () => {
    const store = noopStore({
      dispatch: async () => ({
        ok: false,
        status: 'failed-rolled-back',
        opId: 'op-failed',
        failure: { category: 'conflict', message: 'conflict error' },
      }),
    });
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    const result = await action.dispatch();

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed-rolled-back');
    assert.equal(result.failure.message, 'conflict error');
    assert.equal(result.error, undefined);
    assert.equal(action.status, 'failed');
    assert.equal(action.error, 'conflict error');
  });

  it('displays deliveryError.message for outcome-unknown outcome', async () => {
    const store = noopStore({
      dispatch: async () => ({
        ok: false,
        status: 'outcome-unknown',
        opId: 'op-unknown',
        deliveryError: { message: 'network error' },
      }),
    });
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    const result = await action.dispatch();

    assert.equal(result.ok, false);
    assert.equal(result.status, 'outcome-unknown');
    assert.equal(result.deliveryError.message, 'network error');
    assert.equal(result.error, undefined);
    assert.equal(action.status, 'failed');
    assert.equal(action.error, 'network error');
  });
});

describe('bindField — DispatchResult contract', () => {
  it('displays failure.message for failed-rolled-back outcome', async () => {
    const store = noopStore({
      update: async () => ({
        ok: false,
        status: 'failed-rolled-back',
        opId: 'op-failed',
        failure: { category: 'conflict', message: 'conflict error' },
      }),
    });
    const field = bindField(store, { id: '1', field: 'title' });
    const result = await field.update('x');

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed-rolled-back');
    assert.equal(result.failure.message, 'conflict error');
    assert.equal(result.error, undefined);
    assert.equal(field.status, 'failed');
    assert.equal(field.error, 'conflict error');
  });

  it('displays deliveryError.message for outcome-unknown outcome', async () => {
    const store = noopStore({
      update: async () => ({
        ok: false,
        status: 'outcome-unknown',
        opId: 'op-unknown',
        deliveryError: { message: 'network error' },
      }),
    });
    const field = bindField(store, { id: '1', field: 'title' });
    const result = await field.update('x');

    assert.equal(result.ok, false);
    assert.equal(result.status, 'outcome-unknown');
    assert.equal(result.deliveryError.message, 'network error');
    assert.equal(result.error, undefined);
    assert.equal(field.status, 'failed');
    assert.equal(field.error, 'network error');
  });
});

describe('defensive catch — DispatchResult contract', () => {
  it('converts caught exception in bindAction to outcome-unknown deliveryError', async () => {
    const store = noopStore({
      dispatch: async () => { throw new Error('throw error'); },
    });
    const action = bindAction(store, { id: '1', action: 'Doc.update', payload: () => ({}) });
    const result = await action.dispatch();

    assert.equal(result.ok, false);
    assert.equal(result.status, 'outcome-unknown');
    assert.equal(result.deliveryError.message, 'throw error');
    assert.equal(result.error, undefined);
    assert.equal(action.status, 'failed');
    assert.equal(action.error, 'throw error');
  });

  it('converts caught exception in bindField to outcome-unknown deliveryError', async () => {
    const store = noopStore({
      update: async () => { throw new Error('throw error'); },
    });
    const field = bindField(store, { id: '1', field: 'title' });
    const result = await field.update('x');

    assert.equal(result.ok, false);
    assert.equal(result.status, 'outcome-unknown');
    assert.equal(result.deliveryError.message, 'throw error');
    assert.equal(result.error, undefined);
    assert.equal(field.status, 'failed');
    assert.equal(field.error, 'throw error');
  });
});
