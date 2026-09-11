import { describe, it, expect } from 'vitest';
import { analystModule, buildCandidates, postStep } from '../../src/agents/analyst.js';
import { ROLE_PACK_POLICY } from '../../src/wiki/contextpack.js';
import { RequirementSetSchema } from '../../src/contracts/requirementSet.js';
import type { RequirementSet } from '../../src/contracts/index.js';
import type { GateContext } from '../../src/agents/agent.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import type { TieredBody } from '../../src/wiki/packmaterials.js';
import { AssumptionIdSchema, SlugSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import type { GatePolicy } from '../../src/supervisor/checkpointPolicy.js';
import type { AssumptionFact } from '../../src/supervisor/assumptions.js';

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

describe('analyst.buildCandidates', () => {
  it('never emits a kind in the Analyst\'s omits list, even when every raw material is populated', () => {
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
    const omits = ROLE_PACK_POLICY.analyst.omits;
    for (const section of sections) {
      expect(omits).not.toContain(section.kind);
    }
  });
});

const REQUIREMENT_SET_WITH_AMBIGUITIES: RequirementSet = RequirementSetSchema.parse({
  requirements: [
    {
      req_id: 'REQ-example-1',
      statement: 'a',
      rationale: 'b',
      acceptance: ['c'],
      priority: 'must',
      source_span: 'quoted text',
    },
  ],
  ambiguities: [
    {
      question: 'q1',
      affects: ['REQ-example-1'],
      options: ['a', 'b'],
      recommended: 'b',
    },
    {
      question: 'q2',
      affects: ['REQ-example-1'],
      options: ['x', 'y'],
      recommended: null,
    },
  ],
  out_of_scope: [],
});

describe('analyst.postStep', () => {
  it('produces two AssumptionRecorded events for two ambiguities, with the right chosen value', async () => {
    const result = await postStep({
      itemId,
      slug,
      artifact: REQUIREMENT_SET_WITH_AMBIGUITIES,
      checkContext: { requirementSet: null, architecturePlan: null, taskGraph: null, maxPathsPerTask: 8, testDirs: [] },
      ids: undefined as never,
      workdir: '/tmp',
      frozenTestsDir: '/tmp/frozen-tests',
      frozenTests: null,
      appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as never }),
      gate: gate(),
    });

    expect(result.kind).toBe('ok');
    const assumptionEvents = result.derived.filter((d) => d.type === 'AssumptionRecorded');
    expect(assumptionEvents).toHaveLength(2);
    const chosenValues = assumptionEvents.map((e) => (e.data as { chosen: string }).chosen);
    expect(chosenValues).toEqual(['b', 'x']); // second ambiguity's recommended:null picks options[0]
  });

  it('never blocks: always returns kind "ok"', async () => {
    const result = await postStep({
      itemId,
      slug,
      artifact: REQUIREMENT_SET_WITH_AMBIGUITIES,
      checkContext: { requirementSet: null, architecturePlan: null, taskGraph: null, maxPathsPerTask: 8, testDirs: [] },
      ids: undefined as never,
      workdir: '/tmp',
      frozenTestsDir: '/tmp/frozen-tests',
      frozenTests: null,
      appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as never }),
      gate: gate(),
    });
    expect(result.kind).toBe('ok');
  });

  it('mints ids continuing from gate.nextAssumptionSerial, never restarting at 1 on a re-run', async () => {
    const result = await postStep({
      itemId,
      slug,
      artifact: REQUIREMENT_SET_WITH_AMBIGUITIES,
      checkContext: { requirementSet: null, architecturePlan: null, taskGraph: null, maxPathsPerTask: 8, testDirs: [] },
      ids: undefined as never,
      workdir: '/tmp',
      frozenTestsDir: '/tmp/frozen-tests',
      frozenTests: null,
      appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as never }),
      gate: gate({ nextAssumptionSerial: 5 }),
    });
    const ids = result.derived
      .filter((d) => d.type === 'AssumptionRecorded')
      .map((d) => (d.data as { id: string }).id);
    expect(ids).toEqual([`assumption-${slug}-5`, `assumption-${slug}-6`]);
  });

  it('records a real chain depth, resting a later ambiguity on an earlier one from the same batch', async () => {
    const chained = RequirementSetSchema.parse({
      requirements: REQUIREMENT_SET_WITH_AMBIGUITIES.requirements,
      ambiguities: [
        { question: 'q1', affects: ['REQ-example-1'], options: ['a', 'b'], recommended: 'b' },
        { question: 'q2', affects: ['REQ-example-1'], options: ['x', 'y'], recommended: 'x' },
      ],
      out_of_scope: [],
    });
    const result = await postStep({
      itemId,
      slug,
      artifact: chained,
      checkContext: { requirementSet: null, architecturePlan: null, taskGraph: null, maxPathsPerTask: 8, testDirs: [] },
      ids: undefined as never,
      workdir: '/tmp',
      frozenTestsDir: '/tmp/frozen-tests',
      frozenTests: null,
      appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as never }),
      gate: gate(),
    });
    const depths = result.derived
      .filter((d) => d.type === 'AssumptionRecorded')
      .map((d) => (d.data as { depth: number }).depth);
    expect(depths).toEqual([0, 1]);
  });

  it('an assumption whose depth reaches the cap raises one blocking escalation checkpoint and still records the assumption', async () => {
    const existingOpen: AssumptionFact = {
      id: AssumptionIdSchema.parse(`assumption-${slug}-1`),
      affects: ['REQ-example-1'],
      depth: 1,
      resolved: false,
      seq: 1,
      gateCheckpointId: null,
    };
    const oneAmbiguity = RequirementSetSchema.parse({
      requirements: REQUIREMENT_SET_WITH_AMBIGUITIES.requirements,
      ambiguities: [
        { question: 'q1', affects: ['REQ-example-1'], options: ['a', 'b'], recommended: 'b' },
      ],
      out_of_scope: [],
    });
    const result = await postStep({
      itemId,
      slug,
      artifact: oneAmbiguity,
      checkContext: { requirementSet: null, architecturePlan: null, taskGraph: null, maxPathsPerTask: 8, testDirs: [] },
      ids: undefined as never,
      workdir: '/tmp',
      frozenTestsDir: '/tmp/frozen-tests',
      frozenTests: null,
      appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as never }),
      gate: gate({ nextAssumptionSerial: 2, nextCheckpointSerial: 1, openAssumptions: [existingOpen] }),
    });
    const assumptionEvents = result.derived.filter((d) => d.type === 'AssumptionRecorded');
    expect(assumptionEvents).toHaveLength(1);
    expect((assumptionEvents[0]?.data as { depth: number }).depth).toBe(2);
    const checkpoints = result.derived.filter((d) => d.type === 'CheckpointRaised');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.data).toMatchObject({ kind: 'escalation', blocking: true, sla_seconds: null, default_decision: null });
  });
});

describe('analystModule', () => {
  it('binds role, stage and artifactKind consistently', () => {
    expect(analystModule.role).toBe('analyst');
    expect(analystModule.stage).toBe('analysis');
    expect(analystModule.artifactKind).toBe('requirement-set');
  });
});

describe('analystModule.validate', () => {
  const ctx = {
    requirementSet: null, architecturePlan: null, taskGraph: null,
    maxPathsPerTask: 8, testDirs: [] as string[],
  };

  function setWith(question: string): RequirementSet {
    return RequirementSetSchema.parse({
      requirements: [
        {
          req_id: 'REQ-example-1', statement: 'a', rationale: 'b',
          acceptance: ['c'], priority: 'must', source_span: 'quoted text',
        },
      ],
      ambiguities: [{ question, affects: ['REQ-example-1'], options: ['a', 'b'], recommended: null }],
      out_of_scope: [],
    });
  }

  it('rejects an ambiguity the brownfield ladder can answer mechanically', () => {
    const failures = analystModule.validate(setWith('Does src/app.ts exist in the current tree?'), ctx);
    expect(failures.some((f) => f.includes('mechanically answerable'))).toBe(true);
  });

  it('allows a genuine intent question', () => {
    const failures = analystModule.validate(setWith('Should the product charge admins a monthly fee?'), ctx);
    expect(failures.some((f) => f.includes('mechanically answerable'))).toBe(false);
  });
});
