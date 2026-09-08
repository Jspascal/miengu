import { describe, it, expect } from 'vitest';
import { buildCandidates, plannerModule } from '../../src/agents/planner.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import type { TieredBody } from '../../src/wiki/packmaterials.js';
import { WorkItemIdSchema } from '../../src/core/ids.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');

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

describe("planner.buildCandidates excludes source-files and frozen-test-bodies", () => {
  it('never emits source-files or frozen-test-bodies even when offered', () => {
    const full = pack({
      sourceFiles: [{ path: 'src/a.ts', body: 'x' }],
      frozenTestBodies: [{ path: 'test/a.test.ts', body: 'x' }],
      frozenTestList: [{ testId: 't', intent: 'i' }],
      fileMap: [tieredBody('files')],
      diff: 'diff',
    });
    const sections = buildCandidates(full);
    const kinds = sections.map((s) => s.kind);
    expect(kinds).not.toContain('source-files');
    expect(kinds).not.toContain('frozen-test-bodies');
    expect(kinds).not.toContain('diff');
  });
});

describe('planner.buildCandidates escalation-context tier honesty (binding decision 13)', () => {
  it('never emits a T1 section whose body includes the reviewer findings it carries', () => {
    const full = pack({
      escalationContext: {
        category: 'requirement-miss',
        affectedRequirementIds: [],
        summary: 'task looks right',
        componentIds: [],
        t1OracleSummaries: [],
        taskIds: ['t-1'],
        currentTaskReviewerFindings: 'the reviewer thinks the edge case is unhandled',
      },
    });
    const sections = buildCandidates(full);
    const findingsCarryingT1 = sections.find(
      (s) => s.kind === 'escalation-context' && s.tier === 'T1' && s.body.includes('the reviewer thinks the edge case is unhandled'),
    );
    expect(findingsCarryingT1).toBeUndefined();
  });
});

describe('plannerModule', () => {
  it('binds role, stage and artifactKind consistently, and has no post-step side effects', async () => {
    expect(plannerModule.role).toBe('planner');
    expect(plannerModule.stage).toBe('planning');
    expect(plannerModule.artifactKind).toBe('task-graph');

    const result = await plannerModule.postStep({
      itemId,
      slug: undefined as never,
      artifact: { tasks: [] },
      checkContext: { requirementSet: null, architecturePlan: null, taskGraph: null, maxPathsPerTask: 8, testDirs: [] },
      ids: undefined as never,
      workdir: '/tmp',
      frozenTestsDir: '/tmp/frozen-tests',
      frozenTests: null,
      appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as never }),
    });
    expect(result.kind).toBe('ok');
    expect(result.derived).toEqual([]);
  });
});
