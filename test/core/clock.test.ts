import { describe, it, expect } from 'vitest';
import { systemClock, fixedClock, IsoTimestampSchema, epochSeconds } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { StoreError } from '../../src/errors.js';

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

describe('epochSeconds', () => {
  it('returns 0 for the epoch', () => {
    expect(epochSeconds('1970-01-01T00:00:00.000Z' as IsoTimestamp)).toBe(0);
  });

  it('handles a value with milliseconds', () => {
    expect(epochSeconds('2024-01-01T00:00:00.500Z' as IsoTimestamp)).toBe(1704067200);
  });

  it('floors rather than rounds a fractional second', () => {
    expect(epochSeconds('2024-01-01T00:00:00.999Z' as IsoTimestamp)).toBe(1704067200);
  });

  it('throws StoreError on an unparseable value', () => {
    expect(() => epochSeconds('not-a-timestamp' as IsoTimestamp)).toThrow(StoreError);
  });
});
