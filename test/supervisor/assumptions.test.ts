import { describe, it, expect } from 'vitest';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import {
  assumptionDepth,
  assumptionFacts,
  escalates,
  openAssumptions,
} from '../../src/supervisor/assumptions.js';
import { AssumptionIdSchema, CheckpointIdSchema, SlugSchema } from '../../src/core/ids.js';

const ITEM_ID = 'wi-example-abc123';
const RUN_ID = 'run-00000000-0000-4000-8000-000000000001';
const SLUG = SlugSchema.parse('example');

function hexId(prefix: string, n: number): string {
  const hex = n.toString(16).padStart(32, '0');
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function tsAt(n: number): string {
  return `2024-01-01T00:00:00.${String(n).padStart(3, '0')}Z`;
}

function mkEvent(seq: number, type: EventType, data: unknown): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 3,
    event_id: hexId('evt', seq),
    seq,
    item_id: ITEM_ID,
    run_id: RUN_ID,
    ts: tsAt(seq),
    tier: DEFAULT_TIER[type],
    actor: { kind: 'system', id: null },
    causation_id: null,
    type,
    data,
  });
}

function assumptionRecorded(seq: number, n: number, affects: readonly string[], depth: number): MienguEvent {
  return mkEvent(seq, 'AssumptionRecorded', {
    id: `assumption-${SLUG}-${String(n)}`,
    question: `question ${String(n)}`,
    chosen: 'chosen',
    alternatives: [],
    affects,
    depth,
  });
}

function checkpointRaised(seq: number, n: number, kind: 'assumption-gate' | 'irreversible' = 'assumption-gate'): MienguEvent {
  return mkEvent(seq, 'CheckpointRaised', {
    checkpoint: `cp-${SLUG}-${String(n)}`,
    kind,
    stage: 'analysis',
    summary: 'summary',
    blocking: true,
    sla_seconds: null,
    default_decision: null,
  });
}

function checkpointDecided(seq: number, n: number, decision: 'accept' | 'reject'): MienguEvent {
  return mkEvent(seq, 'CheckpointDecided', {
    checkpoint: `cp-${SLUG}-${String(n)}`,
    decision,
    by: 'human',
    reason: null,
  });
}

function autoApproved(seq: number, n: number): MienguEvent {
  return mkEvent(seq, 'AutoApproved', {
    checkpoint: `cp-${SLUG}-${String(n)}`,
    after: '86400s',
    no_human_response: true,
  });
}

describe('assumptionDepth — binding decision 9', () => {
  it('is 0 for empty affects', () => {
    expect(assumptionDepth([], [])).toBe(0);
  });

  it('is 0 when no open assumption intersects affects', () => {
    const events = [assumptionRecorded(1, 1, ['req-1'], 0)];
    const open = openAssumptions(events);
    expect(assumptionDepth(['req-2'], open)).toBe(0);
  });

  it('is 1 for one unresolved intersecting predecessor', () => {
    const events = [assumptionRecorded(1, 1, ['req-1'], 0)];
    const open = openAssumptions(events);
    expect(assumptionDepth(['req-1'], open)).toBe(1);
  });

  it('is 2 for a chain of two', () => {
    const events = [
      assumptionRecorded(1, 1, ['req-1'], 0),
      assumptionRecorded(2, 2, ['req-1'], 1),
    ];
    const open = openAssumptions(events);
    expect(assumptionDepth(['req-1'], open)).toBe(2);
  });

  it('stays 1 when the deeper ancestor is resolved', () => {
    const events = [
      assumptionRecorded(1, 1, ['req-1'], 0),
      assumptionRecorded(2, 2, ['req-1'], 1),
      checkpointRaised(3, 1),
      checkpointDecided(4, 1, 'accept'),
      assumptionRecorded(5, 3, ['req-1'], 0),
    ];
    // assumption 2 (depth 1) is now resolved by the accepted gate; only assumption 3 (depth 0)
    // remains open and intersects, so a new sibling assumption should see depth 1, not 2.
    const open = openAssumptions(events);
    expect(open.map((f) => f.id)).toEqual([`assumption-${SLUG}-3`]);
    expect(assumptionDepth(['req-1'], open)).toBe(1);
  });

  it('a resolved predecessor never contributes', () => {
    const events = [
      assumptionRecorded(1, 1, ['req-1'], 0),
      checkpointRaised(2, 1),
      checkpointDecided(3, 1, 'accept'),
    ];
    const open = openAssumptions(events);
    expect(open).toEqual([]);
    expect(assumptionDepth(['req-1'], open)).toBe(0);
  });

  it('a rejection does not resolve', () => {
    const events = [
      assumptionRecorded(1, 1, ['req-1'], 0),
      checkpointRaised(2, 1),
      checkpointDecided(3, 1, 'reject'),
    ];
    const facts = assumptionFacts(events);
    expect(facts[0]?.resolved).toBe(false);
    const open = openAssumptions(events);
    expect(open).toHaveLength(1);
  });

  it('an AutoApproved does not resolve', () => {
    const events = [
      assumptionRecorded(1, 1, ['req-1'], 0),
      checkpointRaised(2, 1),
      autoApproved(3, 1),
    ];
    const facts = assumptionFacts(events);
    expect(facts[0]?.resolved).toBe(false);
  });

  it('escalates at exactly maxStackDepth, not before', () => {
    expect(escalates(1, 2)).toBe(false);
    expect(escalates(2, 2)).toBe(true);
    expect(escalates(3, 2)).toBe(true);
  });

  it('a batch of three ambiguities where the third rests on the second which rests on the first yields depths 0,1,2', () => {
    // Within one postStep batch, a later ambiguity's depth is computed against the open set
    // accumulated so far — each recorded depth is fed straight into the next `affects`-
    // intersecting sibling, exactly as src/agents/analyst.ts (item 20) accumulates `open`.
    const firstDepth = assumptionDepth(['req-1'], []);
    const first = assumptionRecorded(1, 1, ['req-1'], firstDepth);

    const secondDepth = assumptionDepth(['req-1'], openAssumptions([first]));
    const second = assumptionRecorded(2, 2, ['req-1'], secondDepth);

    const thirdDepth = assumptionDepth(['req-1'], openAssumptions([first, second]));
    const third = assumptionRecorded(3, 3, ['req-1'], thirdDepth);

    expect([firstDepth, secondDepth, thirdDepth]).toEqual([0, 1, 2]);

    const facts = assumptionFacts([first, second, third]);
    expect(facts.map((f) => f.depth)).toEqual([0, 1, 2]);
  });
});

describe('assumptionFacts / openAssumptions', () => {
  it('records AssumptionId, affects, depth, seq and starts unresolved with no gate', () => {
    const events = [assumptionRecorded(1, 1, ['req-1'], 0)];
    const facts = assumptionFacts(events);
    expect(facts).toEqual([
      {
        id: AssumptionIdSchema.parse(`assumption-${SLUG}-1`),
        affects: ['req-1'],
        depth: 0,
        resolved: false,
        seq: 1,
        gateCheckpointId: null,
      },
    ]);
  });

  it('a CheckpointRaised{assumption-gate} gates every currently unresolved fact', () => {
    const events = [
      assumptionRecorded(1, 1, ['req-1'], 0),
      assumptionRecorded(2, 2, ['req-2'], 0),
      checkpointRaised(3, 1),
    ];
    const facts = assumptionFacts(events);
    expect(facts.every((f) => f.gateCheckpointId === CheckpointIdSchema.parse(`cp-${SLUG}-1`))).toBe(true);
  });

  it('an assumption recorded after the gate is not itself gated by it', () => {
    const events = [
      assumptionRecorded(1, 1, ['req-1'], 0),
      checkpointRaised(2, 1),
      assumptionRecorded(3, 2, ['req-2'], 0),
    ];
    const facts = assumptionFacts(events);
    expect(facts[0]?.gateCheckpointId).toBe(CheckpointIdSchema.parse(`cp-${SLUG}-1`));
    expect(facts[1]?.gateCheckpointId).toBe(null);
  });

  it('openAssumptions is ascending by seq and excludes resolved facts', () => {
    const events = [
      assumptionRecorded(1, 1, ['req-1'], 0),
      assumptionRecorded(2, 2, ['req-2'], 0),
      checkpointRaised(3, 1),
      checkpointDecided(4, 1, 'accept'),
      assumptionRecorded(5, 3, ['req-3'], 0),
    ];
    const open = openAssumptions(events);
    expect(open.map((f) => f.seq)).toEqual([5]);
  });
});
