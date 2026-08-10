import { performance } from 'node:perf_hooks';

import * as clientFamily from '../public/workbench-annotated-text-continuous.mjs';
import { materializeText as materializeCheckpointText } from '../public/workbench-annotated-text.mjs';
import * as serverFamily from '../src/annotated-text-continuous.mjs';

const WORDS = Array.from({ length: 10 }, (_, index) => `word${index}`).join(' ');
const TEXT = Array.from({ length: 96 }, (_, index) => `${WORDS} ${index}`).join('\n');
const ACTOR = '0123456789abcdef0123456789abcdef';
const SAMPLE_COUNT = 80;
const WARMUP_COUNT = 20;

function actor(index) {
  return index.toString(16).padStart(32, '0');
}

function makeFamily(api, operationCount = 32) {
  let family = api.importTextToFamily('bench-document', ACTOR, TEXT);
  for (let index = 0; index < operationCount; index += 1) {
    family = api.applyTextOperation(family, [
      'workbench.text', 1, [actor(index + 1), 1], index + 2, [], ['insert', ['root'], 'x'],
    ]);
  }
  return family;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[sorted.length >> 1];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function timed(run) {
  const started = performance.now();
  const value = run();
  return { elapsedMs: performance.now() - started, value };
}

function measure(run) {
  let sink = 0;
  for (let index = 0; index < WARMUP_COUNT; index += 1) sink += run();
  const durations = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const result = timed(run);
    sink += result.value;
    durations.push(result.elapsedMs);
  }
  if (sink < 0) throw new Error('benchmark sink underflow');
  return {
    medianMs: median(durations),
    p95Ms: percentile(durations, 0.95),
  };
}

function run(api) {
  const family = makeFamily(api);
  const serialized = JSON.stringify({ id: family.id, checkpoint: api.textFamilyCheckpoint(family).checkpoint });

  const coldRestore = measure(() => {
    const restored = api.restoreTextFamily(JSON.parse(serialized));
    return api.materializeText(restored).length;
  });
  const hotMaterialize = measure(() => api.materializeText(family).length);

  let nextFamily = family;
  let nextActor = 100;
  const applyAndMaterialize = measure(() => {
    nextFamily = api.applyTextOperation(nextFamily, [
      'workbench.text', 1, [actor(nextActor), 1], nextActor + 1, [], ['insert', ['root'], 'x'],
    ]);
    nextActor += 1;
    return api.materializeText(nextFamily).length;
  });

  return { coldRestoreAndMaterialize: coldRestore, hotMaterialize, applyAndMaterialize };
}

process.stdout.write(`${JSON.stringify({
  textLength: TEXT.length,
  operationCount: 32,
  samples: SAMPLE_COUNT,
  uncachedClientFamily: run({
    ...clientFamily,
    materializeText: (family) => materializeCheckpointText(family.checkpoint),
  }),
  clientFamily: run(clientFamily),
  serverFamily: run(serverFamily),
})}\n`);
