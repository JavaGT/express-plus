import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createClock } from '../build/internal.mjs';

describe('createClock', () => {
  it('add returns a watcher with remove()', () => {
    const clock = createClock({ now: () => 0 });
    const w = clock.add({ name: 'test', intervalMs: 1000, fn: () => {} });
    assert.equal(typeof w.remove, 'function');
    clock.stop();
  });

  it('fires watcher at interval via _tick', () => {
    const clock = createClock({ now: () => 0 });
    let fired = 0;
    clock.add({ name: 'a', intervalMs: 100, fn: () => { fired++; } });
    clock._tick(50);
    assert.equal(fired, 0);
    clock._tick(100);
    assert.equal(fired, 1);
    clock._tick(200);
    assert.equal(fired, 2);
    clock.stop();
  });

  it('fires multiple watchers, each at their own interval', () => {
    const clock = createClock({ now: () => 0 });
    let fast = 0, slow = 0;
    clock.add({ name: 'slow', intervalMs: 100, fn: () => { slow++; } });
    clock.add({ name: 'fast', intervalMs: 50, fn: () => { fast++; } });
    clock._tick(50); // only fast due (lastFiredAt=0, 0+50=50)
    assert.equal(fast, 1);
    assert.equal(slow, 0);
    clock._tick(99); // fast lastFiredAt=50, slow=0 — neither due
    assert.equal(fast, 1);
    assert.equal(slow, 0);
    clock._tick(100); // fast due at 50+50=100, slow due at 0+100=100 — both fire
    assert.equal(fast, 2);
    assert.equal(slow, 1);
    clock.stop();
  });

  it('remove() stops the watcher from firing', () => {
    const clock = createClock({ now: () => 0 });
    let fired = 0;
    const w = clock.add({ name: 'a', intervalMs: 50, fn: () => { fired++; } });
    clock._tick(50);
    assert.equal(fired, 1);
    w.remove();
    clock._tick(100);
    assert.equal(fired, 1);
    clock.stop();
  });

  it('stop() fires no watchers after', () => {
    const clock = createClock({ now: () => 0 });
    let fired = 0;
    clock.add({ name: 'a', intervalMs: 50, fn: () => { fired++; } });
    clock.stop();
    clock._tick(100);
    assert.equal(fired, 0);
  });

  it('add with same name replaces prior watcher', () => {
    const clock = createClock({ now: () => 0 });
    let a = 0, b = 0;
    clock.add({ name: 'x', intervalMs: 50, fn: () => { a++; } });
    clock.add({ name: 'x', intervalMs: 100, fn: () => { b++; } });
    clock._tick(50);
    assert.equal(a, 0); // replaced, new one fires at 100
    assert.equal(b, 0);
    clock._tick(100);
    assert.equal(b, 1);
    clock._tick(200);
    assert.equal(b, 2);
    clock.stop();
  });

  it('one watcher throw does not prevent others from firing', () => {
    const clock = createClock({ now: () => 0 });
    let good = 0;
    clock.add({ name: 'bad', intervalMs: 50, fn: () => { throw new Error('boom'); } });
    clock.add({ name: 'good', intervalMs: 50, fn: () => { good++; } });
    clock._tick(50);
    assert.equal(good, 1);
    clock.stop();
  });

  it('delayMs defers first fire beyond the interval', () => {
    const clock = createClock({ now: () => 0 });
    let fired = 0;
    clock.add({ name: 'd', intervalMs: 100, fn: () => { fired++; }, delayMs: 150 });
    // initialFired = 0 - 100 + 150 = 50; first fire at 50 + 100 = 150
    clock._tick(100);
    assert.equal(fired, 0);
    clock._tick(150);
    assert.equal(fired, 1);
    clock._tick(250);
    assert.equal(fired, 2);
    clock.stop();
  });

  it('no timer when no watchers (idempotent stop)', () => {
    const clock = createClock();
    clock.stop();
  });
});
