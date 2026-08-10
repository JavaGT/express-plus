import { DatabaseSync } from 'node:sqlite';
import { createServer, durableMutationVariant } from '../src/pipeline.mjs';
import { frameworkLogDDL } from '../src/committed-log.mjs';

const N = Number(process.env.COMMIT_LOOP_N ?? 20_000);
const WARMUP = Number(process.env.COMMIT_LOOP_WARMUP ?? 2_000);

function countedDatabase() {
  const raw = new DatabaseSync(':memory:');
  const counts = { prepare: 0, run: 0, get: 0, all: 0, exec: 0, bySql: new Map() };
  const db = {
    exec(sql) { counts.exec += 1; return raw.exec(sql); },
    prepare(sql) {
      counts.prepare += 1;
      counts.bySql.set(sql, (counts.bySql.get(sql) ?? 0) + 1);
      const statement = raw.prepare(sql);
      return {
        run(...args) { counts.run += 1; return statement.run(...args); },
        get(...args) { counts.get += 1; return statement.get(...args); },
        all(...args) { counts.all += 1; return statement.all(...args); },
      };
    },
  };
  return { raw, db, counts };
}

const { raw, db, counts } = countedDatabase();
db.exec(frameworkLogDDL().join('\n'));
const server = createServer({
  db,
  authorize: async () => true,
  pipeline: durableMutationVariant(),
  handlers: {
    'Probe.add': ({ payload, scope }) => [{ type: 'Probe.added', scope, data: payload }],
  },
});

for (let i = 0; i < WARMUP; i += 1) {
  await server.dispatch({ actionId: `warm-${i}`, type: 'Probe.add', scope: 'Probe:p1', payload: { value: i }, principal: { type: 'system', id: 'bench' } });
}
counts.prepare = counts.run = counts.get = counts.all = counts.exec = 0;
counts.bySql.clear();
const start = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) {
  const result = await server.dispatch({ actionId: `action-${i}`, type: 'Probe.add', scope: 'Probe:p1', payload: { value: i }, principal: { type: 'system', id: 'bench' } });
  if (!result.ok || result.events.length !== 1 || result.events[0].seq !== WARMUP + i + 1) throw new Error(`bad result at ${i}`);
}
const elapsedNs = Number(process.hrtime.bigint() - start);
const sorted = [...counts.bySql.entries()].sort((a, b) => b[1] - a[1]);
console.log(JSON.stringify({
  n: N,
  ops_s: Math.round(N * 1e9 / elapsedNs),
  us: +(elapsedNs / N / 1e3).toFixed(2),
  counts: { ...counts, bySql: sorted },
}));
raw.close();
