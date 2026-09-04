import { describe, it, expect } from 'vitest';
import { systemClock, fixedClock, IsoTimestampSchema } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';

describe('systemClock', () => {
  it('now() returns a UTC ISO timestamp with millisecond precision', () => {
    const ts = systemClock.now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(() => IsoTimestampSchema.parse(ts)).not.toThrow();
  });

  it('monotonicMs() returns a non-negative number that does not decrease', () => {
    const a = systemClock.monotonicMs();
    const b = systemClock.monotonicMs();
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('fixedClock', () => {
  const START_LITERAL = '2024-01-01T00:00:00.000Z';
  const start = START_LITERAL as IsoTimestamp;

  it('IsoTimestampSchema accepts the fixture literal', () => {
    expect(() => IsoTimestampSchema.parse(START_LITERAL)).not.toThrow();
  });

  it('returns the start timestamp on the first call', () => {
    const clock = fixedClock(start);
    expect(clock.now()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('advances by the default step of 1000ms per now() call', () => {
    const clock = fixedClock(start);
    expect(clock.now()).toBe('2024-01-01T00:00:00.000Z');
    expect(clock.now()).toBe('2024-01-01T00:00:01.000Z');
    expect(clock.now()).toBe('2024-01-01T00:00:02.000Z');
  });

  it('advances by a custom step', () => {
    const clock = fixedClock(start, 5000);
    expect(clock.now()).toBe('2024-01-01T00:00:00.000Z');
    expect(clock.now()).toBe('2024-01-01T00:00:05.000Z');
  });

  it('is deterministic: two independently constructed clocks agree', () => {
    const clockA = fixedClock(start, 250);
    const clockB = fixedClock(start, 250);
    for (let i = 0; i < 5; i += 1) {
      expect(clockA.now()).toBe(clockB.now());
    }
  });

  it('monotonicMs() also advances deterministically by the step', () => {
    const clock = fixedClock(start, 100);
    expect(clock.monotonicMs()).toBe(0);
    expect(clock.monotonicMs()).toBe(100);
    expect(clock.monotonicMs()).toBe(200);
  });
});
