import { describe, it, expect } from 'vitest';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import { IsoTimestampSchema } from '../../src/core/clock.js';
import { CheckpointIdSchema, SlugSchema } from '../../src/core/ids.js';
import { project } from '../../src/state/projector.js';
import type { CheckpointStateRecord } from '../../src/state/workitem.js';
import type { GatePolicy } from '../../src/supervisor/checkpointPolicy.js';
import {
  assumptionGateDraft,
  checkpointDraft,
  checkpointOwner,
  gatePolicyAt,
  nextAssumptionSerial,
  nextCheckpointSerial,
  slaCandidates,
} from '../../src/supervisor/checkpointPolicy.js';
import type { AssumptionFact } from '../../src/supervisor/assumptions.js';

const ITEM_ID = 'wi-example-abc123';
const RUN_ID = 'run-00000000-0000-4000-8000-000000000001';
const SLUG = SlugSchema.parse('example');
const AT = IsoTimestampSchema.parse('2024-01-01T00:00:00.000Z');

const DEFAULT_POLICY: GatePolicy = {
  owner: 'operator',
  reversible: { slaSeconds: 86400, default: 'accept' },
  irreversible: { slaSeconds: null, default: null },
  blastRadius: {
    migrationOrSchemaPaths: [],
    sensitivePaths: [],
    externalContractPaths: [],
    protectedPaths: [],
    dependencyManifestPaths: [],
    maxDiffLines: 400,
    maxFilesTouched: 20,
    severity: {
      'migration-or-schema': 'blocking',
      'sensitive-surface': 'blocking',
      'external-contract': 'blocking',
      'protected-surface': 'blocking',
      'dependency-manifest': 'blocking',
      'diff-size': 'advisory',
    },
  },
  maxStackDepth: 2,
};

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

function workItemCreated(seq: number): MienguEvent {
  return mkEvent(seq, 'WorkItemCreated', {
    title: 'Example item',
    slug: SLUG,
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    config_hash: 'deadbeef',
  });
}

function runStarted(seq: number, config: unknown): MienguEvent {
  return mkEvent(seq, 'RunStarted', {
    miengu_version: '0.0.0',
    node_version: 'v20.0.0',
    config_hash: 'deadbeef',
    config,
  });
}

function checkpointRaised(
  seq: number,
  n: number,
  overrides: { slaSeconds?: number | null; defaultDecision?: 'accept' | 'reject' | null; blocking?: boolean; kind?: 'irreversible' | 'blast-radius' | 'assumption-gate' | 'escalation' | 'agent-originated' } = {},
): MienguEvent {
  return mkEvent(seq, 'CheckpointRaised', {
    checkpoint: `cp-${SLUG}-${String(n)}`,
    kind: overrides.kind ?? 'irreversible',
    stage: 'architecture',
    summary: 'summary',
    blocking: overrides.blocking ?? true,
    sla_seconds: overrides.slaSeconds ?? null,
    default_decision: overrides.defaultDecision ?? null,
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

function mkCheckpointRecord(id: string, overrides: Partial<CheckpointStateRecord> = {}): CheckpointStateRecord {
  return {
    id: CheckpointIdSchema.parse(id),
    kind: 'irreversible',
    stage: 'architecture',
    blocking: true,
    status: 'open',
    raisedAt: AT,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe('nextCheckpointSerial', () => {
  it('is 1 over an empty map', () => {
    expect(nextCheckpointSerial({})).toBe(1);
  });

  it('is 4 over {cp-x-3}', () => {
    expect(nextCheckpointSerial({ [`cp-${SLUG}-3`]: mkCheckpointRecord(`cp-${SLUG}-3`) })).toBe(4);
  });

  it('is 11 over ten checkpoints, and a resolved or rejected checkpoint still consumes its serial', () => {
    const checkpoints: Record<string, CheckpointStateRecord> = {};
    for (let n = 1; n <= 10; n += 1) {
      const status = n === 3 ? 'accepted' : n === 7 ? 'rejected' : 'open';
      checkpoints[`cp-${SLUG}-${String(n)}`] = mkCheckpointRecord(`cp-${SLUG}-${String(n)}`, { status });
    }
    expect(nextCheckpointSerial(checkpoints)).toBe(11);
  });

  it('two producers minting from the same state never collide, and a re-run never reissues a live id', () => {
    const checkpoints: Record<string, CheckpointStateRecord> = {
      [`cp-${SLUG}-1`]: mkCheckpointRecord(`cp-${SLUG}-1`, { status: 'accepted' }),
    };
    const base = nextCheckpointSerial(checkpoints);
    // A producer raising k checkpoints in one step uses serial, serial+1, ..., serial+k-1.
    const minted = [base, base + 1, base + 2];
    expect(new Set(minted).size).toBe(minted.length);
    expect(minted.every((n) => !(`cp-${SLUG}-${String(n)}` in checkpoints))).toBe(true);

    const afterMint: Record<string, CheckpointStateRecord> = { ...checkpoints };
    for (const n of minted) {
      afterMint[`cp-${SLUG}-${String(n)}`] = mkCheckpointRecord(`cp-${SLUG}-${String(n)}`, { status: 'accepted' });
    }
    // A re-run of the stage (invalidation) starts from this same accepted state and must mint
    // strictly beyond every id already present, never resurrecting one via a gap.
    expect(nextCheckpointSerial(afterMint)).toBe(base + minted.length);
  });
});

describe('nextAssumptionSerial', () => {
  it('is 1 over an empty array', () => {
    expect(nextAssumptionSerial([])).toBe(1);
  });
});

describe('checkpointDraft', () => {
  it('gives a blocking draft null/null and a non-blocking draft the reversible policy', () => {
    const blocking = checkpointDraft({
      serial: 1,
      slug: SLUG,
      kind: 'irreversible',
      stage: 'architecture',
      summary: 'decision is irreversible',
      reversibility: 'irreversible',
      policy: DEFAULT_POLICY,
    });
    expect(blocking.blocking).toBe(true);
    expect(blocking.slaSeconds).toBeNull();
    expect(blocking.defaultDecision).toBeNull();

    const nonBlocking = checkpointDraft({
      serial: 2,
      slug: SLUG,
      kind: 'agent-originated',
      stage: 'architecture',
      summary: 'agent originated',
      reversibility: 'reversible',
      policy: DEFAULT_POLICY,
    });
    expect(nonBlocking.blocking).toBe(false);
    expect(nonBlocking.slaSeconds).toBe(86400);
    expect(nonBlocking.defaultDecision).toBe('accept');
  });
});

describe('assumptionGateDraft', () => {
  const fact: AssumptionFact = {
    id: `assumption-${SLUG}-1` as AssumptionFact['id'],
    affects: ['req-1'],
    depth: 0,
    resolved: false,
    seq: 1,
    gateCheckpointId: null,
  };

  it('returns null with nothing unresolved', () => {
    expect(
      assumptionGateDraft({
        serial: 1,
        slug: SLUG,
        stage: 'architecture',
        open: [],
        checkpoints: {},
        policy: DEFAULT_POLICY,
      }),
    ).toBeNull();
  });

  it('returns null when a gate is already open', () => {
    const checkpoints: Record<string, CheckpointStateRecord> = {
      [`cp-${SLUG}-1`]: mkCheckpointRecord(`cp-${SLUG}-1`, { kind: 'assumption-gate', status: 'open' }),
    };
    expect(
      assumptionGateDraft({
        serial: 2,
        slug: SLUG,
        stage: 'architecture',
        open: [fact],
        checkpoints,
        policy: DEFAULT_POLICY,
      }),
    ).toBeNull();
  });

  it('raises a blocking assumption-gate draft when unresolved assumptions exist and no gate is open', () => {
    const draft = assumptionGateDraft({
      serial: 1,
      slug: SLUG,
      stage: 'architecture',
      open: [fact],
      checkpoints: {},
      policy: DEFAULT_POLICY,
    });
    expect(draft).not.toBeNull();
    expect(draft?.kind).toBe('assumption-gate');
    expect(draft?.blocking).toBe(true);
    expect(draft?.slaSeconds).toBeNull();
    expect(draft?.defaultDecision).toBeNull();
  });
});

describe('slaCandidates', () => {
  it('excludes every blocking checkpoint, every resolved checkpoint and every checkpoint missing either half of the SLA pair', () => {
    const events: MienguEvent[] = [
      workItemCreated(1),
      checkpointRaised(2, 1, { blocking: true, slaSeconds: null, defaultDecision: null }), // blocking, irreversible: excluded
      checkpointRaised(3, 2, { blocking: false, slaSeconds: 86400, defaultDecision: 'accept' }), // eligible
      checkpointRaised(4, 3, { blocking: false, slaSeconds: 86400, defaultDecision: 'accept' }),
      checkpointDecided(5, 3, 'accept'), // resolved: excluded
      checkpointRaised(6, 4, { blocking: false, slaSeconds: null, defaultDecision: 'accept' }), // missing sla: excluded
      checkpointRaised(7, 5, { blocking: false, slaSeconds: 86400, defaultDecision: null }), // missing default: excluded
    ];
    const state = project(events);
    const candidates = slaCandidates(events, state);
    expect(candidates.map((c) => c.checkpoint)).toEqual([CheckpointIdSchema.parse(`cp-${SLUG}-2`)]);
    expect(candidates[0]).toMatchObject({ slaSeconds: 86400, defaultDecision: 'accept' });
  });
});

describe('checkpointOwner / gatePolicyAt', () => {
  it("reads the in-force RunStarted, is unaffected by a later RunStarted, and falls back to 'operator' for a pre-Phase-5 config", () => {
    const events: MienguEvent[] = [
      workItemCreated(1),
      runStarted(2, {}), // pre-Phase-5: no `checkpoints` key at all
      checkpointRaised(3, 1),
      runStarted(4, { checkpoints: { defaultOwner: 'later-owner' } }),
    ];
    expect(checkpointOwner(events, CheckpointIdSchema.parse(`cp-${SLUG}-1`))).toBe('operator');
  });

  it('reads the owner in force at the raise seq when one is declared', () => {
    const events: MienguEvent[] = [
      workItemCreated(1),
      runStarted(2, { checkpoints: { defaultOwner: 'early-owner' } }),
      checkpointRaised(3, 1),
      runStarted(4, { checkpoints: { defaultOwner: 'later-owner' } }),
    ];
    expect(checkpointOwner(events, CheckpointIdSchema.parse(`cp-${SLUG}-1`))).toBe('early-owner');
  });

  it('gatePolicyAt returns schema defaults for a seq before any RunStarted', () => {
    const events: MienguEvent[] = [workItemCreated(1)];
    const policy = gatePolicyAt(events, 1);
    expect(policy.owner).toBe('operator');
    expect(policy.maxStackDepth).toBe(2);
  });
});
