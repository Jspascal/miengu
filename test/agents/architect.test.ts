import { describe, it, expect } from 'vitest';
import { architectModule, buildCandidates, postStep } from '../../src/agents/architect.js';
import { ROLE_PACK_POLICY } from '../../src/wiki/contextpack.js';
import { ArchitecturePlanSchema } from '../../src/contracts/architecturePlan.js';
import type { ArchitecturePlan } from '../../src/contracts/index.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import { SlugSchema, WorkItemIdSchema } from '../../src/core/ids.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const slug = SlugSchema.parse('example');

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

describe('architect.buildCandidates', () => {
  it("never emits a kind in the Architect's omits list, even when every raw material is populated", () => {
    const full = pack({
      prd: 'the request',
      wikiIndex: 'wiki',
      existingReqIds: [],
      priorOutOfScope: ['out'],
      stackFacts: 'stack',
      systemSkeleton: 'skeleton',
      fileMap: 'files',
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

async function runPostStep(artifact: ArchitecturePlan) {
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
  });
}

describe('architect.postStep', () => {
  it('produces exactly one CheckpointRaised for one irreversible decision', async () => {
    const artifact = plan([
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
    const result = await runPostStep(artifact);
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
});

describe('architectModule', () => {
  it('binds role, stage and artifactKind consistently', () => {
    expect(architectModule.role).toBe('architect');
    expect(architectModule.stage).toBe('architecture');
    expect(architectModule.artifactKind).toBe('architecture-plan');
  });
});
