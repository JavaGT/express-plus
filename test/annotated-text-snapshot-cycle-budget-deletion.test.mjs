import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveDeliverySession } from '../public/workbench-client.mjs';

const SIGNATURE = 'snapshot recovery exceeded four attempts in one cycle';

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('snapshot recovery cannot exceed four attempts in one cycle', async () => {
  let count = 0;
  const session = createLiveDeliverySession({
    bootstrap: async () => {
      count += 1;
      if (count > 4) throw new Error(SIGNATURE);
      return { kind: 'retry' };
    },
    subscribe: async () => ({ close() {} }),
    validateSnapshot: (snapshot) => snapshot,
    fold: (snapshot) => snapshot,
    optimistic: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready.catch((error) => {
    if (error?.message === SIGNATURE) throw error;
  });
  await wait(0);
  if (count > 4) throw new Error(SIGNATURE);
  assert.ok(count <= 4);
  session.close();
});
