import { describe, it, expect } from 'vitest';
import {
  PROVENANCE_TIERS,
  tierRank,
  isAtLeast,
  resolveContradiction,
} from '../../src/core/provenance.js';
import type { ProvenanceTier } from '../../src/core/provenance.js';

describe('provenance', () => {
  it('ranks T0 as strongest and T3 as weakest', () => {
    expect(tierRank('T0')).toBe(0);
    expect(tierRank('T1')).toBe(1);
    expect(tierRank('T2')).toBe(2);
    expect(tierRank('T3')).toBe(3);
  });

  it('resolves the full 4x4 contradiction matrix', () => {
    for (const a of PROVENANCE_TIERS) {
      for (const b of PROVENANCE_TIERS) {
        const outcome = resolveContradiction(a, b);
        if (a === b) {
          expect(outcome).toEqual({ kind: 'tie' });
        } else if (tierRank(a) < tierRank(b)) {
          expect(outcome).toEqual({ kind: 'winner', winner: a, quarantine: b });
        } else {
          expect(outcome).toEqual({ kind: 'winner', winner: b, quarantine: a });
        }
      }
    }
  });

  it('T1 beats T2 and the T2 value is returned as quarantine, never discarded', () => {
    const outcome = resolveContradiction('T1', 'T2');
    expect(outcome).toEqual({ kind: 'winner', winner: 'T1', quarantine: 'T2' });

    const reversed = resolveContradiction('T2', 'T1');
    expect(reversed).toEqual({ kind: 'winner', winner: 'T1', quarantine: 'T2' });
  });

  it('isAtLeast reflects tier strength relative to a floor', () => {
    const floor: ProvenanceTier = 'T1';
    expect(isAtLeast('T0', floor)).toBe(true);
    expect(isAtLeast('T1', floor)).toBe(true);
    expect(isAtLeast('T2', floor)).toBe(false);
    expect(isAtLeast('T3', floor)).toBe(false);
  });
});
