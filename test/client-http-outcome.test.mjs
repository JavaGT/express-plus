// RED-phase tests for intended browser HTTP decoding (decodeResult).
// Some tests document existing contract (GREEN), others specify behavior the
// current decodeResult does not yet implement (RED).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeResult } from '../public/workbench-client.mjs';
import { isWorkbenchFailure, failure } from '../build/outcome.mjs';

describe('decodeResult — browser HTTP response decoder', () => {
  it('204 returns a successful HTTP outcome', async () => {
    const result = await decodeResult({ status: 204 });
    assert.deepEqual(result, { ok: true, httpStatus: 204, value: undefined });
  });

  it('200 with body returns body as value', async () => {
    const body = { id: 1, title: 'test' };
    const result = await decodeResult({
      status: 200, ok: true,
      json: async () => body,
    });
    assert.deepEqual(result, { ok: true, httpStatus: 200, value: body });
  });

  it('non-2xx without body returns unknown error with http status', async () => {
    const r500 = await decodeResult({ status: 500, ok: false });
    assert.deepEqual(r500, { ok: false, httpStatus: 500, error: 'http 500' });

    const r404 = await decodeResult({ status: 404, ok: false });
    assert.deepEqual(r404, { ok: false, httpStatus: 404, error: 'http 404' });
  });

  it('non-2xx with non-canonical body returns unknown error, not failure', async () => {
    const result = await decodeResult({
      status: 400, ok: false,
      json: async () => ({ code: 'BAD', message: 'bad request' }),
    });
    // Non-canonical shapes (no category/message matching the 6 categories) produce
    // the generic unknown/unusable result rather than a structured failure.
    assert.deepEqual(result, { ok: false, httpStatus: 400, error: 'http 400' });
  });

  it('preserves canonical WorkbenchFailure from non-2xx response body', async () => {
    const wbFailure = failure('not-found', 'Project not found.', { projectId: 'p1' });
    const result = await decodeResult({
      status: 404, ok: false,
      json: async () => ({ ok: false, failure: wbFailure }),
    });
    // decodeResult should detect the canonical WorkbenchFailure in the body and
    // preserve it rather than returning the generic 'http 404' error.
    assert.ok(isWorkbenchFailure(result.failure));
    assert.equal(result.failure.category, 'not-found');
    assert.equal(result.failure.message, 'Project not found.');
    assert.deepEqual(result.failure.details, { projectId: 'p1' });
  });

  it('rejects a remote failure whose details are not a JSON record', async () => {
    const result = await decodeResult({
      status: 409,
      ok: false,
      json: async () => ({
        ok: false,
        failure: { category: 'conflict', message: 'Busy.', details: ['invalid'] },
      }),
    });

    assert.deepEqual(result, { ok: false, httpStatus: 409, error: 'http 409' });
  });

  it('200 with body containing ok:false remains a value, not treated as failure', async () => {
    const body = { ok: false, error: 'business logic error' };
    const result = await decodeResult({
      status: 200, ok: true,
      json: async () => body,
    });
    // HTTP success (2xx) means the body passes through as a value regardless of
    // its content shape. {ok:false} in the entity payload is data, not failure.
    assert.deepEqual(result, { ok: true, httpStatus: 200, value: body });
  });
});
