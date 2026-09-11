import { describe, expect, it } from 'vitest';

import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import { ClaimIdSchema, ComponentIdSchema, EventIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import { compareClaims, dedupeDrift, isTouched } from '../../src/integrator/drift.js';
import type { Claim } from '../../src/wiki/records.js';

const OWNER = WorkItemIdSchema.parse('wi-owner-aaaaaa');
const OBSERVER = WorkItemIdSchema.parse('wi-observer-bbbbbb');
const COMPONENT = ComponentIdSchema.parse('component-example-1');

function claim(
  id: string,
  kind: Claim['kind'],
  tier: Claim['tier'],
  options: { subject?: string; statement?: string; components?: readonly typeof COMPONENT[]; paths?: readonly string[] } = {},
): Claim {
  return {
    id: ClaimIdSchema.parse(id), itemId: OWNER, kind, tier,
    subject: options.subject ?? id, statement: options.statement ?? 'expected',
    agentOriginated: false, status: 'active',
    trace: { reqIds: [], componentIds: options.components ?? [], taskIds: [], decisionIds: [], paths: options.paths ?? [] },
    originEventId: 'evt-00000000-0000-4000-8000-000000000001', originSeq: 1,
    at: '2024-01-01T00:00:00.000Z', supersededByClaimId: null, supersedesClaimId: null, quarantine: null,
  };
}

function driftEvent(claimId: string, observed = '"actual"') {
  return MienguEventSchema.parse({
    schema_version: 4, event_id: 'evt-00000000-0000-4000-8000-000000000002', seq: 2,
    item_id: OBSERVER, run_id: 'run-00000000-0000-4000-8000-000000000001',
    ts: '2024-01-01T00:00:00.000Z', tier: DEFAULT_TIER.DriftDetected,
    actor: { kind: 'system', id: null }, causation_id: 'evt-00000000-0000-4000-8000-000000000001',
    type: 'DriftDetected', data: { claim_item: OWNER, claim: ClaimIdSchema.parse(claimId), expected: '"expected"', observed, area: COMPONENT },
  });
}

describe('drift comparison', () => {
  it.each(['T0', 'T1', 'T2', 'T3'] as const)('compares eligible stack facts at %s without changing provenance policy', (tier) => {
    const stack = claim('claim-example-1', 'stack-fact', tier, { subject: 'target.mode', statement: 'worktree' });
    const found = compareClaims({ claims: [stack], observations: [{ kind: 'stack-fact', key: 'target.mode', value: 'clone' }] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ claimItem: OWNER, claim: stack.id, expected: '"worktree"', observed: '"clone"', area: null });
  });

  it('compares only allowlisted path claims and never turns missing evidence into drift', () => {
    const task = claim('claim-example-1', 'task', 'T2', { paths: ['src/a.ts'], components: [COMPONENT] });
    const decision = claim('claim-example-2', 'decision', 'T2', { paths: ['src/a.ts'], components: [COMPONENT] });
    expect(compareClaims({ claims: [task, decision], observations: [] })).toEqual([]);
    expect(compareClaims({ claims: [task, decision], observations: [{ kind: 'path-exists', path: 'src/a.ts', exists: false }] }))
      .toMatchObject([{ claim: task.id, expected: 'true', observed: 'false', area: COMPONENT }]);
  });

  it('retains a changed explicit predicate target even when the target claim is unknown', () => {
    const result = compareClaims({
      claims: [],
      observations: [{ kind: 'predicate', claimItem: OWNER, claim: ClaimIdSchema.parse('claim-example-99'), outcome: 'refuted', expected: true, observed: false, paths: ['src/z.ts'] }],
    });
    expect(result).toMatchObject([{ claimItem: OWNER, claim: 'claim-example-99', expected: 'true', observed: 'false', area: 'src/z.ts' }]);
  });

  it('ignores inconclusive predicates and supports repeat versus changed tuple dedupe', () => {
    const target = claim('claim-example-1', 'file', 'T1', { paths: ['src/a.ts'] });
    const [candidate] = compareClaims({ claims: [target], observations: [{ kind: 'predicate', claimItem: OWNER, claim: target.id, outcome: 'refuted', expected: 'expected', observed: 'actual' }] });
    if (candidate === undefined) throw new Error('candidate missing');
    const prior = driftEvent(target.id);
    expect(dedupeDrift([prior], [{ ...candidate, expected: '"expected"', observed: '"actual"', area: COMPONENT }])).toEqual([]);
    expect(dedupeDrift([prior], [{ ...candidate, expected: '"expected"', observed: '"changed"', area: COMPONENT }])).toHaveLength(1);
    expect(compareClaims({ claims: [target], observations: [{ kind: 'predicate', claimItem: OWNER, claim: target.id, outcome: 'inconclusive', expected: true, observed: false }] })).toEqual([]);
  });

  it('carries each observation source event onto its own candidate and keeps it out of the dedupe tuple', () => {
    const EVIDENCE_EVENT = EventIdSchema.parse('evt-00000000-0000-4000-8000-0000000000e1');
    const PREDICATE_EVENT = EventIdSchema.parse('evt-00000000-0000-4000-8000-0000000000e2');
    const missingPath = claim('claim-example-1', 'file', 'T1', { paths: ['src/a.ts'] });
    const refuted = claim('claim-example-2', 'file', 'T1', { paths: ['src/b.ts'] });
    const found = compareClaims({
      claims: [missingPath, refuted],
      observations: [
        { kind: 'path-exists', path: 'src/a.ts', exists: false, sourceEventId: EVIDENCE_EVENT },
        { kind: 'predicate', claimItem: OWNER, claim: refuted.id, outcome: 'refuted', expected: 'x', observed: 'y', sourceEventId: PREDICATE_EVENT },
      ],
    });
    expect(found).toHaveLength(2);
    expect(found.find((candidate) => candidate.claim === missingPath.id)?.sourceEventId).toBe(EVIDENCE_EVENT);
    expect(found.find((candidate) => candidate.claim === refuted.id)?.sourceEventId).toBe(PREDICATE_EVENT);
    // Distinct provenance must not split a durable tuple: same tuple, different source event.
    const a = { ...found[0]!, sourceEventId: EVIDENCE_EVENT };
    const b = { ...found[0]!, sourceEventId: PREDICATE_EVENT };
    expect(dedupeDrift([], [a, b])).toEqual([a]);
  });

  it('defaults candidate provenance to null when the observation carries no source event', () => {
    const target = claim('claim-example-1', 'file', 'T1', { paths: ['src/a.ts'] });
    const [candidate] = compareClaims({ claims: [target], observations: [{ kind: 'path-exists', path: 'src/a.ts', exists: false }] });
    expect(candidate?.sourceEventId).toBeNull();
  });

  it('requires traced component or selected-path overlap before drift is touched', () => {
    const [traced] = compareClaims({ claims: [claim('claim-example-1', 'file', 'T1', { components: [COMPONENT], paths: ['src/a.ts'] })], observations: [{ kind: 'path-exists', path: 'src/a.ts', exists: false }] });
    const [untraced] = compareClaims({ claims: [], observations: [{ kind: 'predicate', claimItem: OWNER, claim: ClaimIdSchema.parse('claim-example-99'), outcome: 'refuted', expected: true, observed: false }] });
    if (traced === undefined || untraced === undefined) throw new Error('candidate missing');
    expect(isTouched({ candidate: traced, relevantComponentIds: [COMPONENT], selectedScopePaths: [] })).toBe(true);
    expect(isTouched({ candidate: traced, relevantComponentIds: [], selectedScopePaths: ['src/a.ts'] })).toBe(true);
    expect(isTouched({ candidate: untraced, relevantComponentIds: [], selectedScopePaths: [] })).toBe(false);
  });
});
