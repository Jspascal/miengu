import { describe, it, expect } from 'vitest';
import { buildCandidates, plannerModule } from '../../src/agents/planner.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import { WorkItemIdSchema } from '../../src/core/ids.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');

function emptyRaw(): PackBuildInput['raw'] {
  return {
    prd: null,
    wikiIndex: null,
    existingReqIds: [],
    priorOutOfScope: [],
    stackFacts: null,
    systemSkeleton: null,
    fileMap: null,
    testConventions: null,
    sourceFiles: [],
    frozenTestList: [],
    frozenTestBodies: [],
    diff: null,
    oracleResults: null,
    reviewerFindings: null,
    assumptions: [],
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
      fileMap: 'files',
      diff: 'diff',
    });
    const sections = buildCandidates(full);
    const kinds = sections.map((s) => s.kind);
    expect(kinds).not.toContain('source-files');
    expect(kinds).not.toContain('frozen-test-bodies');
    expect(kinds).not.toContain('diff');
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
