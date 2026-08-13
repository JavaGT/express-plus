import { schedule, date, scope, everyone, grant, read, text } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entity } from '../build/internal.mjs';
import { schedulerSource } from '../build/schedule.mjs';

// P6d Spine A step 1: time-driven sources (ADR #10). Import-surface only —
// constructuring + entity-slot acceptance. Firing/dispatch/reaper wiring
// lands in step 4; while/when discovery in step 2; tick in step 5.

test('schedule.at(fieldDesc) returns a frozen object with kind and field', () => {
  const publishedAt = date();
  const trigger = schedule.at(publishedAt);
  assert.equal(trigger.kind, 'schedule.at');
  assert.equal(trigger.field, publishedAt);
  assert.ok(Object.isFrozen(trigger));
});

test('schedule.after(fieldDesc, "7d") returns frozen object with parsed delay', () => {
  const createdAt = date();
  const trigger = schedule.after(createdAt, '7d');
  assert.equal(trigger.kind, 'schedule.after');
  assert.equal(trigger.field, createdAt);
  assert.equal(trigger.delay, 604_800_000); // 7 * 24 * 60 * 60 * 1000
  assert.ok(Object.isFrozen(trigger));
});

test('schedule.after delay parsing: various duration strings', () => {
  const f = date();
  assert.equal(schedule.after(f, '12h').delay, 43_200_000); // 12 * 60 * 60 * 1000
  assert.equal(schedule.after(f, '30m').delay, 1_800_000); // 30 * 60 * 1000
  assert.equal(schedule.after(f, '90s').delay, 90_000); // 90 * 1000
  assert.equal(schedule.after(f, 0).delay, 0); // number 0, not string '0'
  assert.equal(schedule.after(f, 5000).delay, 5000);
});

test('schedule.after delay parsing: rejects invalid delay', () => {
  const f = date();
  assert.throws(
    () => schedule.after(f, 'bad'),
    /schedule\.after: invalid delay/,
  );
  assert.throws(
    () => schedule.after(f, -1),
    /schedule\.after: invalid delay/,
  );
});

test('schedule.at(null) throws', () => {
  assert.throws(
    () => schedule.at(null),
    /schedule\.at: field must be a field descriptor/,
  );
});

test('schedule.after(null, "7d") throws', () => {
  assert.throws(
    () => schedule.after(null, '7d'),
    /schedule\.after: field must be a field descriptor/,
  );
});

test('entity with schedule slot: builds and record.schedule is frozen', () => {
  const publishedAt = date();
  const Blog = entity('BlogWithSchedule', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  assert.ok(Blog);
  assert.ok(Blog.schedule);
  assert.ok(Object.isFrozen(Blog.schedule));
  assert.ok(Object.isFrozen(Blog.schedule.update));
  assert.equal(Blog.schedule.update.kind, 'schedule.at');
  assert.equal(Blog.schedule.update.field, publishedAt);
});

test('entity with schedule.after: builds correctly', () => {
  const createdAt = date();
  const Todo = entity('TodoWithSchedule', {
    grant: scope(() => everyone()).can(() => grant(read)),
        createdAt,

    schedule: {
      update: schedule.after(createdAt, '7d'),
    },
  });
  assert.ok(Todo);
  assert.ok(Todo.schedule);
  assert.equal(Todo.schedule.update.kind, 'schedule.after');
  assert.equal(Todo.schedule.update.delay, 604_800_000);
});

test('entity rejects a deadline field that auto-touches during its own mutation', () => {
  const updatedAt = date({ touch: true });
  assert.throws(
    () => entity('SelfMovingDeadline', {
      grant: scope(() => everyone()).can(() => grant(read)),
      updatedAt,
      schedule: {
        update: schedule.at(updatedAt),
      },
    }),
    /deadline field 'updatedAt'.*touch.*repeatedly/i,
  );
});

test('entity rejects malformed schedule: bogus kind', () => {
  const f = date();
  assert.throws(
    () => entity('BadEntity1', {
      grant: scope(() => everyone()).can(() => grant(read)),
            f,

      schedule: {
        update: { kind: 'bogus' },
      },
    }),
    /schedule\.update: expected schedule\.at\(\.\.\.\), schedule\.after\(\.\.\.\), tick\.hz\(\.\.\.\), or tick\.every\(\.\.\.\)/,
  );
});

test('entity rejects malformed schedule: empty verb name', () => {
  const f = date();
  assert.throws(
    () => entity('BadEntity2', {
      grant: scope(() => everyone()).can(() => grant(read)),
            f,

      schedule: {
        '': schedule.at(f),
      },
    }),
    /schedule: verb name must be a non-empty string/,
  );
});

test('schedule.at rejects bare-string field (import-surface guard)', () => {
  // schedule.at() itself guards against bare strings at import time
  assert.throws(
    () => schedule.at('notadescriptor'),
    /schedule\.at: field must be a field descriptor/,
  );
});

test('entity WITHOUT schedule slot: builds + record.schedule is null', () => {
  const NoSchedule = entity('NoScheduleEntity', {
    grant: scope(() => everyone()).can(() => grant(read)),
        name: date()

  });
  assert.ok(NoSchedule);
  assert.equal(NoSchedule.schedule, null);
});

test('schedule trigger field identity: same object identity rides through', () => {
  const publishedAt = date();
  const Blog = entity('BlogIdentityTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  // Proves descriptors ride through untouched for later identity-matching
  assert.strictEqual(Blog.schedule.update.field, publishedAt);
});

test('schedule constructors accept any object as field (identity-matching happens later)', () => {
  // Import-surface only: field validation is identity-matching at WIRING time (step 4)
  // Here we just verify the descriptor is constructed and frozen
  const fakeField = { fake: 'descriptor' };
  const trigger = schedule.at(fakeField);
  assert.equal(trigger.kind, 'schedule.at');
  assert.strictEqual(trigger.field, fakeField);
  assert.ok(Object.isFrozen(trigger));
});

test('schedule.at with non-object field throws', () => {
  assert.throws(
    () => schedule.at('string'),
    /schedule\.at: field must be a field descriptor/,
  );
  assert.throws(
    () => schedule.at(123),
    /schedule\.at: field must be a field descriptor/,
  );
});

test('schedule.after with negative number throws', () => {
  const f = date();
  assert.throws(
    () => schedule.after(f, -100),
    /schedule\.after: invalid delay/,
  );
});

test('schedule.after with non-finite number throws', () => {
  const f = date();
  assert.throws(
    () => schedule.after(f, Infinity),
    /schedule\.after: invalid delay/,
  );
  assert.throws(
    () => schedule.after(f, NaN),
    /schedule\.after: invalid delay/,
  );
});

// Step 2: while predicate support

test('schedule.at(field, { while }) carries the while fn on the descriptor', () => {
  const publishedAt = date();
  const whilePredicate = ({ fields }) => fields.status.is('queued');
  const trigger = schedule.at(publishedAt, { while: whilePredicate });
  assert.equal(trigger.kind, 'schedule.at');
  assert.strictEqual(trigger.field, publishedAt);
  assert.strictEqual(trigger.while, whilePredicate);
  assert.ok(Object.isFrozen(trigger));
});

test('schedule.at(field, { while: "notafn" }) throws at construction', () => {
  const f = date();
  assert.throws(
    () => schedule.at(f, { while: 'notafn' }),
    /schedule\.at: while must be a function/,
  );
});

test('schedule declarations reject explicitly async lifecycle functions', () => {
  const f = date();
  assert.throws(
    () => schedule.at(f, { while: async ({ fields }) => fields.status.is('queued') }),
    /schedule\.at: while must be synchronous/,
  );
  assert.throws(
    () => schedule.after(f, '1m', { when: async () => true }),
    /schedule\.after: when must be synchronous/,
  );
  assert.throws(
    () => schedule.at(f, { with: async () => ({ status: 'published' }) }),
    /schedule\.at: with must be synchronous/,
  );
});

test('schedule.at(f) and schedule.after(f, 1000) without options still work (backward-compat)', () => {
  const f1 = date();
  const f2 = date();
  const t1 = schedule.at(f1);
  const t2 = schedule.after(f2, 1000);
  assert.strictEqual(t1.while, undefined);
  assert.strictEqual(t2.while, undefined);
});

test('entity with schedule.at + while: compiles to whileSql, whileParams, whileAst', () => {
  const status = text();
  const publishedAt = date();
  const Blog = entity('BlogWhileAt', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status, publishedAt,

    schedule: {
      update: schedule.at(publishedAt, { while: ({ fields }) => fields.status.is('queued') }),
    },
  });
  assert.ok(Blog);
  assert.ok(Blog.schedule);
  assert.ok(Blog.schedule.update);
  assert.ok(typeof Blog.schedule.update.whileSql === 'string' && Blog.schedule.update.whileSql.length > 0);
  assert.ok(Blog.schedule.update.whileSql.includes('status'));
  assert.ok(Blog.schedule.update.whileParams && typeof Blog.schedule.update.whileParams === 'object' && Object.keys(Blog.schedule.update.whileParams).length > 0);
  assert.ok(Blog.schedule.update.whileAst && typeof Blog.schedule.update.whileAst === 'object');
});

test('entity with schedule.after + while: compiles to whileSql, whileParams, whileAst', () => {
  const status = text();
  const createdAt = date();
  const Todo = entity('TodoWhileAfter', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status, createdAt,

    schedule: {
      update: schedule.after(createdAt, '1h', { while: ({ fields }) => fields.status.is('pending') }),
    },
  });
  assert.ok(Todo);
  assert.ok(Todo.schedule);
  assert.ok(Todo.schedule.update);
  assert.ok(typeof Todo.schedule.update.whileSql === 'string' && Todo.schedule.update.whileSql.length > 0);
  assert.ok(Todo.schedule.update.whileSql.includes('status'));
  assert.ok(Todo.schedule.update.whileParams && typeof Todo.schedule.update.whileParams === 'object' && Object.keys(Todo.schedule.update.whileParams).length > 0);
  assert.ok(Todo.schedule.update.whileAst && typeof Todo.schedule.update.whileAst === 'object');
});

test('entity with no while on schedule trigger: whileSql is undefined', () => {
  const publishedAt = date();
  const Blog = entity('BlogNoWhile', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt,

    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  assert.ok(Blog);
  assert.strictEqual(Blog.schedule.update.whileSql, undefined);
  assert.strictEqual(Blog.schedule.update.whileParams, undefined);
  assert.strictEqual(Blog.schedule.update.whileAst, undefined);
});

test('non-compilable while: load-time error (NonCompilableError propagates)', () => {
  const publishedAt = date();
  assert.throws(
    () => entity('BadWhileEntity', {
      grant: scope(() => everyone()).can(() => grant(read)),
            publishedAt,

      schedule: {
        update: schedule.at(publishedAt, { while: ({ fields }) => fields.nonexistent.eq(1) }),
      },
    }),
    /schedule\.update while on entity/,
  );
});

test("'when' lifecycle guard compiles when it is a function", () => {
  const publishedAt = date();
  const when = ({ row }) => row.status === 'playing';
  const status = text();
  const Scheduled = entity('WhenEntity', {
    grant: scope(() => everyone()).can(() => grant(read)),
    publishedAt,
    status,
    schedule: {
      update: schedule.at(publishedAt, { when }),
    },
  });
  assert.strictEqual(Scheduled.schedule.update.when, when);
});

test("schedule.at rejects a non-function 'when' guard", () => {
  const publishedAt = date();
  assert.throws(
    () => schedule.at(publishedAt, { when: 'playing' }),
    /schedule\.at: when must be a function/,
  );
});

test('while referencing a value-kind comparable field compiles', () => {
  const status = text();
  const publishedAt = date();
  const Doc = entity('DocWhileValue', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status, publishedAt,

    schedule: {
      update: schedule.at(publishedAt, { while: ({ fields }) => fields.status.is('draft') }),
    },
  });
  assert.ok(Doc);
  assert.ok(Doc.schedule);
  assert.ok(Doc.schedule.update);
  assert.ok(typeof Doc.schedule.update.whileSql === 'string');
  assert.ok(Doc.schedule.update.whileParams);
});

test('schedule key becomes the stable compiled trigger identity', () => {
  const dueAt = date();
  const Doc = entity('KeyedDeadline', {
    grant: scope(() => everyone()).can(() => grant(read)),
    dueAt,
    schedule: {
      update: schedule.at(dueAt, { key: 'publish-primary' }),
    },
  });

  assert.equal(Doc.schedule.update.triggerId, 'publish-primary');
  assert.equal(
    schedulerSource('KeyedDeadline', 'update', Doc.schedule.update.triggerId),
    'KeyedDeadline.update.publish-primary',
  );
});

test('entity rejects colliding schedule trigger identities unless keys distinguish them', () => {
  const dueAt = date();
  assert.throws(
    () => entity('CollidingDeadlines', {
      grant: scope(() => everyone()).can(() => grant(read)),
      dueAt,
      schedule: {
        update: [schedule.at(dueAt), schedule.at(dueAt)],
      },
    }),
    /duplicate trigger identity/,
  );

  const Distinct = entity('DistinctDeadlines', {
    grant: scope(() => everyone()).can(() => grant(read)),
    dueAt,
    schedule: {
      update: [
        schedule.at(dueAt, { key: 'first' }),
        schedule.at(dueAt, { key: 'second' }),
      ],
    },
  });
  assert.deepEqual(Distinct.schedule.update.map((trigger) => trigger.triggerId), ['first', 'second']);
});

test('schedule constructors reject malformed trigger keys', () => {
  const dueAt = date();
  for (const key of ['', 'has spaces', 'slash/not-allowed', 42]) {
    assert.throws(() => schedule.at(dueAt, { key }), /schedule\.at: key/);
  }
});
