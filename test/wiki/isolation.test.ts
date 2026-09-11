import { describe, it, expect } from 'vitest';
import { ROLES } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { ReqId, WorkItemId } from '../../src/core/ids.js';
import { tierRank } from '../../src/core/provenance.js';
import { ContextPackError } from '../../src/errors.js';
import { ROLE_MODULES } from '../../src/agents/agent.js';
import type { PackBuildInput, RawPackMaterials } from '../../src/agents/agent.js';
import { ROLE_PACK_POLICY, assemblePack, renderPack } from '../../src/wiki/contextpack.js';
import type { ContextPackSection, PackSourceKind } from '../../src/wiki/contextpack.js';
import type { TieredBody } from '../../src/wiki/packmaterials.js';
import { fileMapBodies, stackFactsBodies, systemSkeletonBodies, wikiIndexBodies } from '../../src/wiki/packmaterials.js';
import { deriveClaims } from '../../src/wiki/records.js';
import { RequirementSetSchema } from '../../src/contracts/requirementSet.js';
import { ArchitecturePlanSchema } from '../../src/contracts/architecturePlan.js';
import { TaskGraphSchema } from '../../src/contracts/taskGraph.js';
import type { RequirementSet, ArchitecturePlan, TaskGraph } from '../../src/contracts/index.js';

const ITEM_ID = 'wi-example-abc123' as WorkItemId;

function sentinel(kind: string): string {
  return `MIENGU_SENTINEL_${kind.toUpperCase().replace(/-/g, '_')}`;
}

function tieredBody(kind: string, tier: TieredBody['tier'] = 'T2'): TieredBody {
  return { body: sentinel(kind), tier, sourceEventId: null };
}

const REQUIREMENT_SET: RequirementSet = RequirementSetSchema.parse({
  requirements: [
    {
      req_id: 'REQ-example-1',
      statement: sentinel('requirement-set'),
      rationale: 'r',
      acceptance: ['a'],
      priority: 'must',
      source_span: 'prd.md:1',
    },
  ],
  ambiguities: [],
  out_of_scope: [],
});

const ARCHITECTURE_PLAN: ArchitecturePlan = ArchitecturePlanSchema.parse({
  decisions: [
    {
      decision_id: 'decision-example-1',
      title: sentinel('architecture-decisions'),
      choice: sentinel('architecture-decisions'),
      alternatives: ['alt'],
      rationale: 'r',
      req_ids: ['REQ-example-1'],
      supersedes: null,
      blast_radius: 'reversible',
    },
  ],
  components: [
    {
      component_id: 'component-example-1',
      responsibility: sentinel('architecture-components'),
      paths: ['src/x.ts'],
      depends_on: [],
    },
  ],
  interfaces: [
    {
      interface_id: 'interface-example-1',
      component_id: 'component-example-1',
      signature: 'f(): void',
      behaviour: sentinel('architecture-interfaces'),
      req_ids: ['REQ-example-1'],
    },
  ],
  falsifications: [],
});

const TASK_GRAPH: TaskGraph = TaskGraphSchema.parse({
  tasks: [
    {
      task_id: 'task-example-1',
      title: sentinel('task'),
      req_ids: ['REQ-example-1'],
      component_ids: ['component-example-1'],
      expected_paths: ['src/x.ts'],
      depends_on: [],
      definition_of_done: ['d'],
      estimated_turns: 1,
    },
  ],
});

/** Every field non-null/non-empty; every body carries a unique sentinel (§5's isolation proof). */
function maximalRaw(): RawPackMaterials {
  return {
    prd: sentinel('prd'),
    wikiIndex: [tieredBody('wiki-index')],
    existingReqIds: [sentinel('existing-req-ids') as unknown as ReqId],
    priorOutOfScope: [sentinel('prior-out-of-scope')],
    stackFacts: [tieredBody('stack-facts', 'T0')],
    systemSkeleton: [tieredBody('system-skeleton')],
    fileMap: [tieredBody('file-map', 'T1')],
    testConventions: sentinel('test-conventions'),
    sourceFiles: [{ path: 'src/sentinel.ts', body: sentinel('source-files') }],
    frozenTestList: [{ testId: 'test-sentinel-1', intent: sentinel('frozen-test-list') }],
    frozenTestBodies: [{ path: 'test/sentinel.test.ts', body: sentinel('frozen-test-bodies') }],
    diff: sentinel('diff'),
    oracleResults: sentinel('oracle-results'),
    currentTaskReviewerFindings: sentinel('current-task-reviewer-findings'),
    escalationContext: {
      category: 'cat',
      affectedRequirementIds: ['REQ-example-1' as ReqId],
      summary: sentinel('escalation-context'),
      componentIds: ['component-example-1'],
      t1OracleSummaries: [],
      taskIds: [],
      currentTaskReviewerFindings: null,
    },
    brownfieldHistory: [tieredBody('brownfield-history', 'T1')],
    brownfieldFalsification: [tieredBody('brownfield-falsification', 'T1')],
    brownfieldDrift: [tieredBody('brownfield-drift', 'T1')],
    assumptions: [{ question: 'q', chosen: sentinel('assumptions'), affects: [] }],
    artifactTiers: {
      requirementSet: 'T2',
      architecturePlan: 'T2',
      taskGraph: 'T2',
      testSuiteSpec: 'T2',
    },
  };
}

function maximalPack(): PackBuildInput {
  return {
    itemId: ITEM_ID,
    checkContext: {
      requirementSet: REQUIREMENT_SET,
      architecturePlan: ARCHITECTURE_PLAN,
      taskGraph: TASK_GRAPH,
      maxPathsPerTask: 8,
      testDirs: ['test/'],
    },
    task: TASK_GRAPH.tasks[0]!,
    activeT1OracleFailure: false,
    activeCauseLevel: null,
    raw: maximalRaw(),
  };
}

function section(kind: PackSourceKind, tier: ContextPackSection['tier'] = 'T3'): ContextPackSection {
  return { kind, heading: `heading-${kind}`, body: sentinel(kind), tier, sourceEventId: null };
}

describe('acceptance criterion 4: the rendered pack bytes exclude every kind in the role\'s omits', () => {
  for (const role of ROLES) {
    it(`${role}: renderPack(assemblePack(module.buildCandidates(maximal))) contains no sentinel from ${role}'s omits`, () => {
      const module = ROLE_MODULES[role];
      const candidates = module.buildCandidates(maximalPack());
      const pack = assemblePack({
        itemId: ITEM_ID,
        stage: module.stage,
        role,
        candidates,
        budgetTokens: 1_000_000,
        tierFloor: 'T3',
      });
      const rendered = renderPack(pack);
      for (const kind of ROLE_PACK_POLICY[role].omits) {
        expect(rendered).not.toContain(sentinel(kind));
      }
    });
  }
});

describe('the two load-bearing rows, asserted by name', () => {
  it('Analyst and Test Author never receive any brownfield section', () => {
    for (const role of ['analyst', 'testAuthor'] as const) {
      const module = ROLE_MODULES[role];
      const rendered = renderPack(assemblePack({
        itemId: ITEM_ID,
        stage: module.stage,
        role,
        candidates: module.buildCandidates(maximalPack()),
        budgetTokens: 1_000_000,
        tierFloor: 'T3',
      }));
      for (const kind of ['brownfield-history', 'brownfield-falsification', 'brownfield-drift']) {
        expect(rendered).not.toContain(sentinel(kind));
      }
    }
  });

  it('Architect, Planner, Coder and Reviewer receive only supplied normalized brownfield sections', () => {
    for (const role of ['architect', 'planner', 'coder', 'reviewer'] as const) {
      const module = ROLE_MODULES[role];
      const rendered = renderPack(assemblePack({
        itemId: ITEM_ID,
        stage: module.stage,
        role,
        candidates: module.buildCandidates(maximalPack()),
        budgetTokens: 1_000_000,
        tierFloor: 'T3',
      }));
      for (const kind of ['brownfield-history', 'brownfield-falsification', 'brownfield-drift']) {
        expect(rendered).toContain(sentinel(kind));
      }
    }
  });

  it("the Test Author's rendered pack contains no implementation, diff, source-file, task-graph, architecture-component, file-map, wiki-index or system-skeleton sentinel", () => {
    const module = ROLE_MODULES.testAuthor;
    const candidates = module.buildCandidates(maximalPack());
    const pack = assemblePack({
      itemId: ITEM_ID,
      stage: module.stage,
      role: 'testAuthor',
      candidates,
      budgetTokens: 1_000_000,
      tierFloor: 'T3',
    });
    const rendered = renderPack(pack);
    for (const kind of [
      'diff', 'source-files', 'task-graph', 'architecture-components', 'file-map', 'wiki-index', 'system-skeleton',
    ] as const) {
      expect(rendered).not.toContain(sentinel(kind));
    }
  });

  it("the Reviewer's rendered pack contains no coder-transcript sentinel", () => {
    const module = ROLE_MODULES.reviewer;
    const candidates = module.buildCandidates(maximalPack());
    const pack = assemblePack({
      itemId: ITEM_ID,
      stage: module.stage,
      role: 'reviewer',
      candidates,
      budgetTokens: 1_000_000,
      tierFloor: 'T3',
    });
    const rendered = renderPack(pack);
    expect(rendered).not.toContain(sentinel('coder-transcript'));
  });
});

describe('exhaustive negative: every (role, kind) with kind in omits throws, generated from the policy', () => {
  for (const role of ROLES) {
    for (const kind of ROLE_PACK_POLICY[role].omits) {
      it(`${role} rejects a lone ${kind} candidate`, () => {
        let thrown: unknown;
        try {
          assemblePack({
            itemId: ITEM_ID,
            stage: ROLE_MODULES[role].stage,
            role,
            candidates: [section(kind)],
            budgetTokens: 1_000_000,
            tierFloor: 'T3',
          });
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(ContextPackError);
        const message = (thrown as ContextPackError).message;
        expect(message).toContain(role);
        expect(message).toContain(kind);
      });
    }
  }
});

describe('tier plumbing end to end', () => {
  it('a tierFloor: T1 pack contains no T2/T3 section on a mixed-tier maximal fixture', () => {
    const input = maximalPack();
    const raw: RawPackMaterials = {
      ...input.raw,
      artifactTiers: {
        requirementSet: 'T2',
        architecturePlan: 'T3',
        taskGraph: 'T2',
        testSuiteSpec: 'T2',
      },
    };
    const module = ROLE_MODULES.architect;
    const candidates = module.buildCandidates({ ...input, raw });
    const pack = assemblePack({
      itemId: ITEM_ID,
      stage: module.stage,
      role: 'architect',
      candidates,
      budgetTokens: 1_000_000,
      tierFloor: 'T1',
    });
    for (const s of pack.sections) {
      expect(tierRank(s.tier)).toBeLessThanOrEqual(tierRank('T1'));
    }
    expect(pack.sections.length).toBeGreaterThan(0);
  });

  it('under a binding budget, the first dropped section is the weakest-tier non-required one', () => {
    const module = ROLE_MODULES.architect;
    const policy = ROLE_PACK_POLICY.architect;
    const candidates = module.buildCandidates(maximalPack());
    const nonRequired = candidates.filter((c) => !policy.required.includes(c.kind));
    const weakestRank = Math.max(...nonRequired.map((c) => tierRank(c.tier)));
    const requiredTokens = candidates
      .filter((c) => policy.required.includes(c.kind))
      .reduce((sum, c) => sum + c.body.length, 0);
    const budget = Math.ceil(requiredTokens / 4) + 5;

    const pack = assemblePack({
      itemId: ITEM_ID,
      stage: module.stage,
      role: 'architect',
      candidates,
      budgetTokens: budget,
      tierFloor: 'T3',
    });
    expect(pack.dropped.length).toBeGreaterThan(0);
    const firstDropped = candidates.find((c) => c.kind === pack.dropped[0]?.kind);
    expect(firstDropped).toBeDefined();
    expect(tierRank(firstDropped?.tier ?? 'T0')).toBe(weakestRank);
  });
});

// ---- non-active claims never reach a pack ----

function hexId(prefix: string, n: number): string {
  const hex = n.toString(16).padStart(32, '0');
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function tsAt(n: number): string {
  return `2024-01-01T00:00:00.${String(n).padStart(3, '0')}Z`;
}

function mkEvent(seq: number, type: EventType, data: unknown): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 4,
    event_id: hexId('evt', seq),
    seq,
    item_id: ITEM_ID,
    run_id: 'run-00000000-0000-4000-8000-000000000001',
    ts: tsAt(seq),
    tier: DEFAULT_TIER[type],
    actor: { kind: 'system', id: null },
    causation_id: null,
    type,
    data,
  });
}

function created(): MienguEvent {
  return mkEvent(1, 'WorkItemCreated', {
    title: 'Example item',
    slug: 'example',
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    config_hash: 'deadbeef',
  });
}

function architectureStageCompleted(seq: number, componentId: string, responsibility: string): MienguEvent {
  return mkEvent(seq, 'StageCompleted', {
    stage: 'architecture',
    attempt: 1,
    artifact: {
      kind: 'architecture-plan',
      sha256: 'b'.repeat(64),
      body: {
        decisions: [],
        components: [{ component_id: componentId, responsibility, paths: [], depends_on: [] }],
        interfaces: [],
        falsifications: [],
      },
    },
  });
}

function driftDetected(seq: number, claim: string): MienguEvent {
  return mkEvent(seq, 'DriftDetected', {
    claim_item: ITEM_ID,
    claim,
    expected: 'expected',
    observed: 'observed',
    area: null,
  });
}

function artifactsInvalidated(seq: number, artifactEventIds: string[]): MienguEvent {
  return mkEvent(seq, 'ArtifactsInvalidated', {
    cause_id: hexId('evt', 500),
    target: 'coder',
    affected_ids: { req_ids: [], component_ids: [], task_ids: [] },
    artifact_event_ids: artifactEventIds,
    reason: 'invalidated for test',
  });
}

describe('non-active claims never reach a pack', () => {
  it('a quarantined, a superseded and an invalidated claim, each planted with a sentinel, are absent from all six rendered packs', () => {
    const superseded1 = sentinel('SUPERSEDED_V1');
    const superseded2 = sentinel('SUPERSEDED_V2');
    const quarantinedSentinel = sentinel('QUARANTINED');
    const invalidatedSentinel = sentinel('INVALIDATED');

    const eventSupersededV1 = architectureStageCompleted(2, 'component-example-1', superseded1);
    const eventSupersededV2 = architectureStageCompleted(3, 'component-example-1', superseded2);
    const eventQuarantined = architectureStageCompleted(4, 'component-example-2', quarantinedSentinel);
    const eventInvalidated = architectureStageCompleted(5, 'component-example-3', invalidatedSentinel);

    const preliminary = [created(), eventSupersededV1, eventSupersededV2, eventQuarantined, eventInvalidated];
    const quarantinedId = deriveClaims(preliminary).claims.find((c) => c.subject === 'component-example-2')?.id;
    expect(quarantinedId).toBeDefined();

    const events = [
      ...preliminary,
      driftDetected(6, quarantinedId as string),
      artifactsInvalidated(7, [eventInvalidated.event_id]),
    ];
    const set = deriveClaims(events);

    const raw: RawPackMaterials = {
      ...maximalRaw(),
      wikiIndex: wikiIndexBodies(set),
      systemSkeleton: systemSkeletonBodies(set),
      fileMap: fileMapBodies(set),
      stackFacts: stackFactsBodies(set),
    };
    const input: PackBuildInput = { ...maximalPack(), raw };

    for (const role of ROLES) {
      const module = ROLE_MODULES[role];
      const candidates = module.buildCandidates(input);
      const pack = assemblePack({
        itemId: ITEM_ID,
        stage: module.stage,
        role,
        candidates,
        budgetTokens: 1_000_000,
        tierFloor: 'T3',
      });
      const rendered = renderPack(pack);
      expect(rendered).not.toContain(superseded1);
      expect(rendered).not.toContain(quarantinedSentinel);
      expect(rendered).not.toContain(invalidatedSentinel);
    }
  });
});
