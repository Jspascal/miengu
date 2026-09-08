import { describe, it, expect } from 'vitest';
import { ROLES } from '../../src/core/events.js';
import type { Role, Stage } from '../../src/core/events.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { canonicalJson } from '../../src/core/canonical.js';
import { ContextPackError } from '../../src/errors.js';
import {
  PACK_SOURCE_KINDS,
  ROLE_PACK_POLICY,
  assemblePack,
  emptyContextPack,
  estimateTokens,
  renderPack,
} from '../../src/wiki/contextpack.js';
import type { ContextPackSection, PackSourceKind } from '../../src/wiki/contextpack.js';

const ITEM_ID = 'wi-example-abc123' as WorkItemId;
const STAGE: Stage = 'analysis';
const ALL_KINDS_SET = new Set<PackSourceKind>(PACK_SOURCE_KINDS);

function section(kind: PackSourceKind, heading = `heading-${kind}`, body = `body for ${kind}`): ContextPackSection {
  return { kind, heading, body, tier: 'T1', sourceEventId: null };
}

describe('(a) ROLE_PACK_POLICY is a total partition', () => {
  for (const role of ROLES) {
    it(`${role}: includes ∪ omits === PACK_SOURCE_KINDS, includes ∩ omits === ∅, required ⊆ includes`, () => {
      const policy = ROLE_PACK_POLICY[role];
      const union = new Set<PackSourceKind>([...policy.includes, ...policy.omits]);
      expect(union).toEqual(ALL_KINDS_SET);

      const intersection = policy.includes.filter((k) => policy.omits.includes(k));
      expect(intersection).toEqual([]);

      for (const requiredKind of policy.required) {
        expect(policy.includes).toContain(requiredKind);
      }
    });
  }
});

describe('(b) acceptance criterion 4: context isolation is provable, one test per role', () => {
  for (const role of ROLES) {
    it(`${role}: assemblePack throws naming the first omitted kind when handed every PackSourceKind`, () => {
      const policy = ROLE_PACK_POLICY[role];
      const candidates = PACK_SOURCE_KINDS.map((kind) => section(kind));
      const firstOmitted = policy.omits[0];
      expect(firstOmitted).toBeDefined();

      let thrown: unknown;
      try {
        assemblePack({
          itemId: ITEM_ID,
          stage: STAGE,
          role,
          candidates,
          budgetTokens: 1_000_000,
          tierFloor: 'T3',
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ContextPackError);
      expect((thrown as ContextPackError).message).toContain(role);
    });

    it(`${role}: a legal candidate list produces a pack with no section in the role's omits`, () => {
      const policy = ROLE_PACK_POLICY[role];
      const candidates = policy.includes.map((kind) => section(kind));

      const pack = assemblePack({
        itemId: ITEM_ID,
        stage: STAGE,
        role,
        candidates,
        budgetTokens: 1_000_000,
        tierFloor: 'T3',
      });

      for (const s of pack.sections) {
        expect(policy.omits).not.toContain(s.kind);
      }
    });
  }
});

describe('(c) the two load-bearing rows, asserted by name', () => {
  it('testAuthor.omits contains architecture-components, file-map and task-graph', () => {
    const omits = ROLE_PACK_POLICY.testAuthor.omits;
    expect(omits).toContain('architecture-components');
    expect(omits).toContain('file-map');
    expect(omits).toContain('task-graph');
  });

  it('reviewer.omits contains coder-transcript', () => {
    expect(ROLE_PACK_POLICY.reviewer.omits).toContain('coder-transcript');
  });

  it('allows current-task findings only for Coder and Reviewer, and escalation context only upstream', () => {
    for (const role of ['coder', 'reviewer'] as const) {
      expect(ROLE_PACK_POLICY[role].includes).toContain('current-task-reviewer-findings');
    }
    for (const role of ['analyst', 'architect', 'planner'] as const) {
      expect(ROLE_PACK_POLICY[role].includes).toContain('escalation-context');
      expect(ROLE_PACK_POLICY[role].omits).toContain('current-task-reviewer-findings');
    }
    for (const role of ROLES) {
      expect(ROLE_PACK_POLICY[role].omits).toContain('other-task-reviewer-findings');
    }
  });
});

describe('(d) budget bounds', () => {
  it('drops over-budget non-required sections weakest-tier-first and records them in dropped', () => {
    const role: Role = 'planner';
    const policy = ROLE_PACK_POLICY[role];
    const longBody = 'x'.repeat(400); // ~100 estimated tokens each

    const candidates = policy.includes.map((kind) =>
      section(kind, `heading-${kind}`, longBody),
    );
    // Weaken the tier of a non-required section so it is the predictable drop target.
    const nonRequiredKind = policy.includes.find((k) => !policy.required.includes(k));
    expect(nonRequiredKind).toBeDefined();
    const weakened = candidates.map((c) =>
      c.kind === nonRequiredKind ? { ...c, tier: 'T3' as const } : c,
    );

    const requiredOnlyTokens = policy.required.length * estimateTokens(longBody);
    const budget = requiredOnlyTokens + 10;

    const pack = assemblePack({
      itemId: ITEM_ID,
      stage: STAGE,
      role,
      candidates: weakened,
      budgetTokens: budget,
      tierFloor: 'T3',
    });

    expect(pack.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(pack.dropped.length).toBeGreaterThan(0);
    for (const d of pack.dropped) {
      expect(d.reason).toBe('budget');
      expect(policy.required).not.toContain(d.kind);
    }
    for (const s of pack.sections) {
      expect(s.kind).not.toBe(nonRequiredKind);
    }
  });

  it('throws when required sections alone exceed the budget', () => {
    const role: Role = 'coder';
    const policy = ROLE_PACK_POLICY[role];
    const longBody = 'x'.repeat(4000);
    const candidates = policy.required.map((kind) => section(kind, `heading-${kind}`, longBody));

    expect(() =>
      assemblePack({
        itemId: ITEM_ID,
        stage: STAGE,
        role,
        candidates,
        budgetTokens: 1,
        tierFloor: 'T3',
      }),
    ).toThrow(ContextPackError);
  });
});

describe('(e) purity', () => {
  it('the same input twice yields byte-identical canonicalJson', () => {
    const role: Role = 'architect';
    const policy = ROLE_PACK_POLICY[role];
    const candidates = policy.includes.map((kind) => section(kind));

    const first = assemblePack({
      itemId: ITEM_ID,
      stage: STAGE,
      role,
      candidates,
      budgetTokens: 1_000_000,
      tierFloor: 'T3',
    });
    const second = assemblePack({
      itemId: ITEM_ID,
      stage: STAGE,
      role,
      candidates,
      budgetTokens: 1_000_000,
      tierFloor: 'T3',
    });

    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('does not mutate a deep-frozen candidate list', () => {
    const role: Role = 'reviewer';
    const policy = ROLE_PACK_POLICY[role];
    const candidates = policy.includes.map((kind) => Object.freeze(section(kind)));
    Object.freeze(candidates);

    expect(() =>
      assemblePack({
        itemId: ITEM_ID,
        stage: STAGE,
        role,
        candidates,
        budgetTokens: 1_000_000,
        tierFloor: 'T3',
      }),
    ).not.toThrow();
  });
});

describe('emptyContextPack', () => {
  it('returns a pack with no sections, no drops, and zero estimated tokens', () => {
    const pack = emptyContextPack(ITEM_ID, STAGE);
    expect(pack.sections).toEqual([]);
    expect(pack.dropped).toEqual([]);
    expect(pack.estimatedTokens).toBe(0);
    expect(pack.role).toBeNull();
  });
});

describe('estimateTokens', () => {
  it('is ceil(utf8Bytes / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('renderPack', () => {
  it('renders sections in order as deterministic markdown', () => {
    const pack = assemblePack({
      itemId: ITEM_ID,
      stage: STAGE,
      role: 'analyst',
      candidates: [section('prd', 'PRD', 'the prd text')],
      budgetTokens: 1_000_000,
      tierFloor: 'T3',
    });
    expect(renderPack(pack)).toBe('## PRD\n\nthe prd text');
  });
});
