import { z } from 'zod';

export const PROVENANCE_TIERS = ['T0', 'T1', 'T2', 'T3'] as const;
export type ProvenanceTier = (typeof PROVENANCE_TIERS)[number];
export const ProvenanceTierSchema = z.enum(PROVENANCE_TIERS);

const TIER_RANK = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
} as const satisfies Record<ProvenanceTier, 0 | 1 | 2 | 3>;

/** T0 human-authored/approved · T1 machine-verified · T2 agent-asserted · T3 provisional */
export function tierRank(t: ProvenanceTier): 0 | 1 | 2 | 3 {
  return TIER_RANK[t];
}

export function isAtLeast(t: ProvenanceTier, floor: ProvenanceTier): boolean {
  return tierRank(t) <= tierRank(floor);
}

export type ContradictionOutcome =
  | { readonly kind: 'winner'; readonly winner: ProvenanceTier; readonly quarantine: ProvenanceTier }
  | { readonly kind: 'tie' };

/** §7: on contradiction T1 wins and the T2 record is quarantined, never overwritten. */
export function resolveContradiction(a: ProvenanceTier, b: ProvenanceTier): ContradictionOutcome {
  const rankA = tierRank(a);
  const rankB = tierRank(b);
  if (rankA === rankB) {
    return { kind: 'tie' };
  }
  return rankA < rankB
    ? { kind: 'winner', winner: a, quarantine: b }
    : { kind: 'winner', winner: b, quarantine: a };
}
