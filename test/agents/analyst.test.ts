import { describe, it, expect } from 'vitest';
import { analystModule, buildCandidates, postStep } from '../../src/agents/analyst.js';
import { ROLE_PACK_POLICY } from '../../src/wiki/contextpack.js';
import { RequirementSetSchema } from '../../src/contracts/requirementSet.js';
import type { RequirementSet } from '../../src/contracts/index.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import type { TieredBody } from '../../src/wiki/packmaterials.js';
import { SlugSchema, WorkItemIdSchema } from '../../src/core/ids.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const slug = SlugSchema.parse('example');

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
    });
    expect(result.kind).toBe('ok');
  });
});

describe('analystModule', () => {
  it('binds role, stage and artifactKind consistently', () => {
    expect(analystModule.role).toBe('analyst');
    expect(analystModule.stage).toBe('analysis');
    expect(analystModule.artifactKind).toBe('requirement-set');
  });
});
