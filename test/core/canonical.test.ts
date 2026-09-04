import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/core/canonical.js';
import { CanonicalError } from '../../src/errors.js';

describe('canonicalJson', () => {
  it('sorts object keys lexicographically at every depth, independent of insertion order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it('preserves array order without sorting', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serialises nested arrays of objects deterministically', () => {
    const value = [{ b: 1, a: 2 }, { d: 4, c: 3 }];
    expect(canonicalJson(value)).toBe('[{"a":2,"b":1},{"c":3,"d":4}]');
  });

  it('produces no whitespace', () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).not.toMatch(/\s/);
  });

  it('rejects undefined anywhere', () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalError);
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalError);
    expect(() => canonicalJson([1, undefined, 3])).toThrow(CanonicalError);
    expect(() => canonicalJson({ a: { b: undefined } })).toThrow(CanonicalError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalError);
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(CanonicalError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalError);
  });

  it('rejects Date, Map, Set, BigInt, functions, and symbols', () => {
    expect(() => canonicalJson(new Date())).toThrow(CanonicalError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalError);
    expect(() => canonicalJson(new Set())).toThrow(CanonicalError);
    expect(() => canonicalJson(BigInt(1))).toThrow(CanonicalError);
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalError);
    expect(() => canonicalJson(Symbol('x'))).toThrow(CanonicalError);
    expect(() => canonicalJson({ a: new Date() })).toThrow(CanonicalError);
  });

  it('is stable across 1000 shuffled re-serialisations of one fixture', () => {
    const fixture = {
      zeta: 1,
      alpha: { nested: true, arr: [1, 2, 3], deep: { z: 1, a: 2 } },
      beta: [{ y: 1, x: 2 }, { b: 1, a: 2 }],
      gamma: 'value',
    };
    const expected = canonicalJson(fixture);

    function shuffleKeys(value: unknown): unknown {
      if (Array.isArray(value)) {
        return value.map(shuffleKeys);
      }
      if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).map(
          ([k, v]) => [k, shuffleKeys(v)] as const,
        );
        for (let i = entries.length - 1; i > 0; i -= 1) {
          const j = Math.floor(((i + 1) * (i * 7919 + 13)) % (i + 1));
          const tmp = entries[i]!;
          entries[i] = entries[j]!;
          entries[j] = tmp;
        }
        return Object.fromEntries(entries);
      }
      return value;
    }

    for (let i = 0; i < 1000; i += 1) {
      const shuffled = shuffleKeys(fixture);
      expect(canonicalJson(shuffled)).toBe(expected);
    }
  });
});
