import { describe, it, expect } from 'vitest';
import { buildCandidates, reviewerModule } from '../../src/agents/reviewer.js';
import { ROLE_PACK_POLICY, assemblePack } from '../../src/wiki/contextpack.js';
import type { ContextPackSection } from '../../src/wiki/contextpack.js';
import { ContextPackError } from '../../src/errors.js';
import { ReviewVerdictSchema } from '../../src/contracts/reviewVerdict.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import { WorkItemIdSchema } from '../../src/core/ids.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');

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

describe("reviewer.buildCandidates excludes coder-transcript, frozen-test-bodies, source-files", () => {
  it('never emits those kinds even when every raw material is populated', () => {
    const full = pack({
      sourceFiles: [{ path: 'src/a.ts', body: 'x' }],
      frozenTestBodies: [{ path: 'test/a.test.ts', body: 'x' }],
      frozenTestList: [{ testId: 't', intent: 'i' }],
      diff: 'diff',
    });
    const sections = buildCandidates(full);
    const kinds = sections.map((s) => s.kind);
    expect(kinds).not.toContain('coder-transcript');
    expect(kinds).not.toContain('frozen-test-bodies');
    expect(kinds).not.toContain('source-files');
  });

  it('assemblePack throws if a coder-transcript section is offered to the reviewer role, even though buildCandidates never produces one', () => {
    const sneaked: ContextPackSection = {
      kind: 'coder-transcript',
      heading: 'sneaked in',
      body: 'the coder said...',
      tier: 'T3',
      sourceEventId: null,
    };
    expect(() =>
      assemblePack({
        itemId,
        stage: 'review',
        role: 'reviewer',
        candidates: [sneaked],
        budgetTokens: 100000,
        tierFloor: 'T3',
      }),
    ).toThrow(ContextPackError);
    expect(ROLE_PACK_POLICY.reviewer.omits).toContain('coder-transcript');
  });
});

describe('reviewerModule', () => {
  it('a revise verdict yields {kind:"ok"} and no escalation event of any kind is emitted', async () => {
    const verdict = ReviewVerdictSchema.parse({
      task_id: 'task-example-1',
      verdict: 'revise',
      findings: [
        { severity: 'major', kind: 'correctness', detail: 'off by one', path: 'src/a.ts' },
      ],
      escalate_to: null,
    });

    const result = await reviewerModule.postStep({
      itemId,
      slug: undefined as never,
      artifact: verdict,
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

  it('binds role, stage and artifactKind consistently', () => {
    expect(reviewerModule.role).toBe('reviewer');
    expect(reviewerModule.stage).toBe('review');
    expect(reviewerModule.artifactKind).toBe('review-verdict');
  });
});
