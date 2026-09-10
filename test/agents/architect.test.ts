import { describe, it, expect } from 'vitest';
import { architectModule, buildCandidates, postStep } from '../../src/agents/architect.js';
import { ROLE_PACK_POLICY } from '../../src/wiki/contextpack.js';
import { ArchitecturePlanSchema } from '../../src/contracts/architecturePlan.js';
import type { ArchitecturePlan } from '../../src/contracts/index.js';
import type { GateContext } from '../../src/agents/agent.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import type { TieredBody } from '../../src/wiki/packmaterials.js';
import { SlugSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import type { GatePolicy } from '../../src/supervisor/checkpointPolicy.js';
import { nextCheckpointSerial } from '../../src/supervisor/checkpointPolicy.js';
import type { AssumptionFact } from '../../src/supervisor/assumptions.js';
import { project } from '../../src/state/projector.js';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const slug = SlugSchema.parse('example');

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

function gate(overrides: Partial<GateContext> = {}): GateContext {
  return {
    nextCheckpointSerial: 1,
    nextAssumptionSerial: 1,
    openAssumptions: [],
    checkpoints: {},
    policy: DEFAULT_POLICY,
    ...overrides,
  };
}

function tieredBody(body: string): TieredBody {
  return { body, tier: 'T2', sourceEventId: null };
}

function emptyRaw(): PackBuildInput['raw'] {
  return {
    prd: null,
    wikiIndex: [],
    existingReqIds: [],
    priorOutOfScope: [],
    stackFacts: [],
    systemSkeleton: [],
    fileMap: [],
    testConventions: null,
    sourceFiles: [],
    frozenTestList: [],
    frozenTestBodies: [],
    diff: null,
    oracleResults: null,
    currentTaskReviewerFindings: null,
    escalationContext: null,
    assumptions: [],
    artifactTiers: {
      requirementSet: 'T2',
      architecturePlan: 'T2',
      taskGraph: 'T2',
      testSuiteSpec: 'T2',
    },
  };
}

function pack(overrides: Partial<PackBuildInput['raw']> = {}): PackBuildInput {
  return {
    itemId,
    checkContext: {
      requirementSet: null,
      architecturePlan: null,
      taskGraph: null,
      maxPathsPerTask: 8,
      testDirs: ['test/'],
    },
    task: null,
    raw: { ...emptyRaw(), ...overrides },
  };
}

describe('architect.buildCandidates', () => {
  it("never emits a kind in the Architect's omits list, even when every raw material is populated", () => {
    const full = pack({
      prd: 'the request',
      wikiIndex: [tieredBody('wiki')],
      existingReqIds: [],
      priorOutOfScope: ['out'],
      stackFacts: [tieredBody('stack')],
      systemSkeleton: [tieredBody('skeleton')],
      fileMap: [tieredBody('files')],
      testConventions: 'conventions',
      sourceFiles: [{ path: 'src/a.ts', body: 'x' }],
      frozenTestList: [{ testId: 't', intent: 'i' }],
      frozenTestBodies: [{ path: 'test/a.test.ts', body: 'x' }],
      diff: 'diff',
      oracleResults: 'oracle',
      reviewerFindings: 'findings',
      assumptions: [{ question: 'q', chosen: 'c', affects: [] }],
    });
    const sections = buildCandidates(full);
    const omits = ROLE_PACK_POLICY.architect.omits;
    for (const section of sections) {
      expect(omits).not.toContain(section.kind);
    }
  });
});

function plan(decisions: ArchitecturePlan['decisions']): ArchitecturePlan {
  return ArchitecturePlanSchema.parse({
    decisions,
    components: [
      { component_id: 'component-example-1', responsibility: 'r', paths: ['src/a.ts'], depends_on: [] },
    ],
    interfaces: [],
  });
}

const CHECK_CONTEXT = {
  requirementSet: null,
  architecturePlan: null,
  taskGraph: null,
  maxPathsPerTask: 8,
  testDirs: [] as string[],
};

async function runPostStep(artifact: ArchitecturePlan, gateContext: GateContext = gate()) {
  return postStep({
    itemId,
    slug,
    artifact,
    checkContext: CHECK_CONTEXT,
    ids: undefined as never,
    workdir: '/tmp',
    frozenTestsDir: '/tmp/frozen-tests',
    frozenTests: null,
    appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as never }),
    gate: gateContext,
  });
}

const IRREVERSIBLE_PLAN = plan([
  {
    decision_id: 'decision-example-1',
    title: 'migrate schema',
    choice: 'X',
    alternatives: ['Y'],
    rationale: 'r',
    req_ids: ['REQ-example-1' as never],
    supersedes: null,
    blast_radius: 'irreversible',
  },
]);

describe('architect.postStep', () => {
  it('produces exactly one CheckpointRaised for one irreversible decision', async () => {
    const result = await runPostStep(IRREVERSIBLE_PLAN);
    const checkpoints = result.derived.filter((d) => d.type === 'CheckpointRaised');
    expect(checkpoints).toHaveLength(1);
    expect((checkpoints[0]?.data as { blocking: boolean }).blocking).toBe(true);
  });

  it('raises no checkpoint for a reversible-only plan', async () => {
    const artifact = plan([
      {
        decision_id: 'decision-example-1',
        title: 'use X',
        choice: 'X',
        alternatives: ['Y'],
        rationale: 'r',
        req_ids: ['REQ-example-1' as never],
        supersedes: null,
        blast_radius: 'reversible',
      },
    ]);
    const result = await runPostStep(artifact);
    expect(result.derived.filter((d) => d.type === 'CheckpointRaised')).toHaveLength(0);
  });

  it('flags decisions with req_ids: [] as agent-originated', async () => {
    const artifact = plan([
      {
        decision_id: 'decision-example-1',
        title: 'use X',
        choice: 'X',
        alternatives: ['Y'],
        rationale: 'r',
        req_ids: [],
        supersedes: null,
        blast_radius: 'reversible',
      },
    ]);
    const result = await runPostStep(artifact);
    expect(result.derived.filter((d) => d.type === 'ItemArtifactRecorded')).toHaveLength(1);
  });

  it('mints checkpoint ids continuing from gate.nextCheckpointSerial', async () => {
    const result = await runPostStep(IRREVERSIBLE_PLAN, gate({ nextCheckpointSerial: 5 }));
    const checkpoint = result.derived.find((d) => d.type === 'CheckpointRaised');
    expect((checkpoint?.data as { checkpoint: string }).checkpoint).toBe(`cp-${slug}-5`);
  });

  it('irreversible checkpoints carry sla_seconds: null and default_decision: null', async () => {
    const result = await runPostStep(IRREVERSIBLE_PLAN);
    const checkpoint = result.derived.find((d) => d.type === 'CheckpointRaised');
    expect(checkpoint?.data).toMatchObject({ kind: 'irreversible', sla_seconds: null, default_decision: null });
  });

  it('raises an assumption gate exactly once when unresolved assumptions exist, and never when none do', async () => {
    const openFact: AssumptionFact = {
      id: `assumption-${slug}-1` as AssumptionFact['id'],
      affects: ['REQ-example-1'],
      depth: 0,
      resolved: false,
      seq: 1,
      gateCheckpointId: null,
    };

    const withOpen = await runPostStep(IRREVERSIBLE_PLAN, gate({ nextCheckpointSerial: 1, openAssumptions: [openFact] }));
    const gatesWithOpen = withOpen.derived.filter(
      (d) => d.type === 'CheckpointRaised' && (d.data as { kind: string }).kind === 'assumption-gate',
    );
    expect(gatesWithOpen).toHaveLength(1);
    expect((gatesWithOpen[0]?.data as { checkpoint: string }).checkpoint).toBe(`cp-${slug}-2`);

    const withoutOpen = await runPostStep(IRREVERSIBLE_PLAN, gate({ nextCheckpointSerial: 1, openAssumptions: [] }));
    expect(
      withoutOpen.derived.filter((d) => d.type === 'CheckpointRaised' && (d.data as { kind: string }).kind === 'assumption-gate'),
    ).toHaveLength(0);
  });

  it('a re-run after invalidation mints fresh ids and never overwrites a decided checkpoint', async () => {
    const firstRun = await runPostStep(IRREVERSIBLE_PLAN, gate({ nextCheckpointSerial: 1 }));
    const firstCheckpoint = firstRun.derived.find((d) => d.type === 'CheckpointRaised');
    expect((firstCheckpoint?.data as { checkpoint: string }).checkpoint).toBe(`cp-${slug}-1`);

    function mkEvent(seq: number, type: EventType, data: unknown): MienguEvent {
      return MienguEventSchema.parse({
        schema_version: 3,
        event_id: `evt-00000000-0000-4000-8000-00000000000${String(seq)}`,
        seq,
        item_id: itemId,
        run_id: 'run-00000000-0000-4000-8000-000000000001',
        ts: `2024-01-01T00:00:00.00${String(seq)}Z`,
        tier: DEFAULT_TIER[type],
        actor: { kind: 'system', id: null },
        causation_id: null,
        type,
        data,
      });
    }

    const events: MienguEvent[] = [
      mkEvent(1, 'WorkItemCreated', {
        title: 'Example item',
        slug,
        source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
        config_hash: 'deadbeef',
      }),
      mkEvent(2, 'CheckpointRaised', firstCheckpoint?.data),
      mkEvent(3, 'CheckpointDecided', { checkpoint: `cp-${slug}-1`, decision: 'accept', by: 'human', reason: null }),
    ];
    const stateAfterFirstRun = project(events);
    expect(stateAfterFirstRun.checkpoints[`cp-${slug}-1`]?.status).toBe('accepted');

    // A re-run of the architecture stage (invalidation) must mint from the current state,
    // never re-mint `cp-${slug}-1` — the collision the projector's `CheckpointRaised` fold
    // would silently resolve by resetting the already-accepted record back to `open`.
    const secondRun = await runPostStep(
      IRREVERSIBLE_PLAN,
      gate({ nextCheckpointSerial: nextCheckpointSerial(stateAfterFirstRun.checkpoints) }),
    );
    const secondCheckpoint = secondRun.derived.find((d) => d.type === 'CheckpointRaised');
    expect((secondCheckpoint?.data as { checkpoint: string }).checkpoint).toBe(`cp-${slug}-2`);

    const eventsAfterSecondRun: MienguEvent[] = [
      ...events,
      mkEvent(4, 'CheckpointRaised', secondCheckpoint?.data),
    ];
    const stateAfterSecondRun = project(eventsAfterSecondRun);
    expect(stateAfterSecondRun.checkpoints[`cp-${slug}-1`]?.status).toBe('accepted');
    expect(stateAfterSecondRun.checkpoints[`cp-${slug}-2`]?.status).toBe('open');
  });
});

describe('architectModule', () => {
  it('binds role, stage and artifactKind consistently', () => {
    expect(architectModule.role).toBe('architect');
    expect(architectModule.stage).toBe('architecture');
    expect(architectModule.artifactKind).toBe('architecture-plan');
  });
});
