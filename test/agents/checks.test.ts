import { describe, it, expect } from 'vitest';
import {
  ArchitecturePlanSchema,
  ImplementationSchema,
  RequirementSetSchema,
  ReviewVerdictSchema,
  TaskGraphSchema,
  TestSuiteSpecDraftSchema,
} from '../../src/contracts/index.js';
import type {
  ArchitecturePlan,
  Implementation,
  RequirementSet,
  ReviewVerdict,
  TaskGraph,
  TestSuiteSpecDraft,
} from '../../src/contracts/index.js';
import {
  checkArchitecturePlan,
  checkImplementation,
  checkRequirementSet,
  checkReviewVerdict,
  checkTaskGraph,
  checkTestSuiteSpec,
  mustRequirements,
  topoOrder,
} from '../../src/agents/checks.js';
import type { CheckContext } from '../../src/agents/checks.js';

function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    requirementSet: null,
    architecturePlan: null,
    taskGraph: null,
    maxPathsPerTask: 8,
    testDirs: ['test/'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_REQUIREMENT_SET: RequirementSet = RequirementSetSchema.parse({
  requirements: [
    {
      req_id: 'REQ-example-1',
      statement: 'the system does X',
      rationale: 'because Y',
      acceptance: ['X is observable'],
      priority: 'must',
      source_span: null,
    },
    {
      req_id: 'REQ-example-2',
      statement: 'the system does Z',
      rationale: 'because W',
      acceptance: ['Z is observable'],
      priority: 'should',
      source_span: null,
    },
  ],
  ambiguities: [
    {
      question: 'what should happen on empty input?',
      affects: ['REQ-example-1'],
      options: ['reject', 'accept'],
      recommended: null,
    },
  ],
  out_of_scope: [],
});

const VALID_ARCHITECTURE_PLAN: ArchitecturePlan = ArchitecturePlanSchema.parse({
  decisions: [
    {
      decision_id: 'decision-example-1',
      title: 'use X',
      choice: 'X',
      alternatives: ['Y'],
      rationale: 'X is simpler',
      req_ids: ['REQ-example-1'],
      supersedes: null,
      blast_radius: 'reversible',
    },
  ],
  components: [
    {
      component_id: 'component-example-1',
      responsibility: 'does the thing',
      paths: ['src/thing.ts'],
      depends_on: [],
    },
  ],
  interfaces: [
    {
      interface_id: 'interface-example-1',
      component_id: 'component-example-1',
      signature: 'doThing(): void',
      behaviour: 'does the thing observably',
      req_ids: ['REQ-example-1'],
    },
  ],
});

const VALID_TASK_GRAPH: TaskGraph = TaskGraphSchema.parse({
  tasks: [
    {
      task_id: 'task-example-1',
      title: 'implement thing',
      req_ids: ['REQ-example-1'],
      component_ids: ['component-example-1'],
      expected_paths: ['src/thing.ts'],
      depends_on: [],
      definition_of_done: ['doThing() returns void and does the thing'],
      estimated_turns: 3,
    },
  ],
});

const VALID_TEST_SUITE: TestSuiteSpecDraft = TestSuiteSpecDraftSchema.parse({
  suite_id: 'suite-example-1',
  cases: [
    {
      test_id: 'test-example-1',
      req_ids: ['REQ-example-1'],
      path: 'test/thing.test.ts',
      intent: 'asserts thing happens',
      negative: false,
      asserts_output: true,
    },
    {
      test_id: 'test-example-2',
      req_ids: ['REQ-example-1'],
      path: 'test/thing.test.ts',
      intent: 'asserts thing rejects bad input',
      negative: true,
      asserts_output: false,
    },
  ],
});

const VALID_IMPLEMENTATION: Implementation = ImplementationSchema.parse({
  task_id: 'task-example-1',
  diff_ref: 'diff-sha-abc',
  files_touched: ['src/thing.ts'],
  assumption_ids: [],
  deviations: [],
});

const VALID_REVIEW_VERDICT: ReviewVerdict = ReviewVerdictSchema.parse({
  task_id: 'task-example-1',
  verdict: 'accept',
  findings: [],
  escalate_to: null,
});

// ---------------------------------------------------------------------------
// analyst
// ---------------------------------------------------------------------------

describe('checkRequirementSet (analyst)', () => {
  it('passes on a valid fixture', () => {
    expect(checkRequirementSet(VALID_REQUIREMENT_SET, ctx())).toEqual([]);
  });

  it('rejects a duplicate req_id', () => {
    const bad: RequirementSet = {
      ...VALID_REQUIREMENT_SET,
      requirements: [
        VALID_REQUIREMENT_SET.requirements[0]!,
        { ...VALID_REQUIREMENT_SET.requirements[0]!, req_id: VALID_REQUIREMENT_SET.requirements[0]!.req_id },
      ],
    };
    const failures = checkRequirementSet(bad, ctx());
    expect(failures).toContain('req_id is not unique: REQ-example-1');
  });

  it('rejects numbering with a gap', () => {
    const bad: RequirementSet = RequirementSetSchema.parse({
      ...VALID_REQUIREMENT_SET,
      requirements: [
        VALID_REQUIREMENT_SET.requirements[0],
        { ...VALID_REQUIREMENT_SET.requirements[1], req_id: 'REQ-example-5' },
      ],
    });
    const failures = checkRequirementSet(bad, ctx());
    expect(failures).toContain('req_id numbering is not monotonic from 1 with no gaps');
  });

  it('rejects an ambiguity whose affects[] does not resolve', () => {
    const bad: RequirementSet = {
      ...VALID_REQUIREMENT_SET,
      ambiguities: [{ ...VALID_REQUIREMENT_SET.ambiguities[0]!, affects: ['REQ-example-9' as never] }],
    };
    const failures = checkRequirementSet(bad, ctx());
    expect(failures.some((f) => f.includes("unresolved req_id 'REQ-example-9'"))).toBe(true);
  });

  it('rejects an ambiguity with fewer than 2 options', () => {
    // options.min(2) is schema-enforced, so exercise the check function directly with a
    // hand-built object that bypasses the schema to prove the mechanical check itself fires.
    const bad: RequirementSet = {
      ...VALID_REQUIREMENT_SET,
      ambiguities: [{ ...VALID_REQUIREMENT_SET.ambiguities[0]!, options: ['only-one'] }],
    };
    const failures = checkRequirementSet(bad, ctx());
    expect(failures.some((f) => f.includes('fewer than 2 options'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// architect
// ---------------------------------------------------------------------------

describe('checkArchitecturePlan (architect)', () => {
  it('passes on a valid fixture', () => {
    expect(
      checkArchitecturePlan(VALID_ARCHITECTURE_PLAN, ctx({ requirementSet: VALID_REQUIREMENT_SET })),
    ).toEqual([]);
  });

  it('rejects a duplicate decision_id', () => {
    const bad: ArchitecturePlan = {
      ...VALID_ARCHITECTURE_PLAN,
      decisions: [VALID_ARCHITECTURE_PLAN.decisions[0]!, VALID_ARCHITECTURE_PLAN.decisions[0]!],
    };
    const failures = checkArchitecturePlan(bad, ctx());
    expect(failures).toContain('decision_id is not unique: decision-example-1');
  });

  it("rejects a supersedes that does not resolve to a prior decision", () => {
    const bad: ArchitecturePlan = {
      ...VALID_ARCHITECTURE_PLAN,
      decisions: [{ ...VALID_ARCHITECTURE_PLAN.decisions[0]!, supersedes: 'decision-example-9' as never }],
    };
    const failures = checkArchitecturePlan(bad, ctx());
    expect(
      failures.some((f) => f.includes("supersedes 'decision-example-9', which is not a prior decision")),
    ).toBe(true);
  });

  it('rejects an unresolved req_id on a decision', () => {
    const bad: ArchitecturePlan = {
      ...VALID_ARCHITECTURE_PLAN,
      decisions: [{ ...VALID_ARCHITECTURE_PLAN.decisions[0]!, req_ids: ['REQ-example-9' as never] }],
    };
    const failures = checkArchitecturePlan(bad, ctx({ requirementSet: VALID_REQUIREMENT_SET }));
    expect(failures.some((f) => f.includes("unresolved req_id 'REQ-example-9'"))).toBe(true);
  });

  it('rejects a must requirement untouched by any decision or interface', () => {
    const bad: ArchitecturePlan = {
      ...VALID_ARCHITECTURE_PLAN,
      decisions: [{ ...VALID_ARCHITECTURE_PLAN.decisions[0]!, req_ids: [] }],
      interfaces: [{ ...VALID_ARCHITECTURE_PLAN.interfaces[0]!, req_ids: ['REQ-example-2'] }],
    };
    const failures = checkArchitecturePlan(bad, ctx({ requirementSet: VALID_REQUIREMENT_SET }));
    expect(failures).toContain("must requirement 'REQ-example-1' is not touched by any decision or interface");
  });

  it('rejects a decision with no alternatives', () => {
    const bad: ArchitecturePlan = {
      ...VALID_ARCHITECTURE_PLAN,
      decisions: [{ ...VALID_ARCHITECTURE_PLAN.decisions[0]!, alternatives: [] }],
    };
    const failures = checkArchitecturePlan(bad, ctx());
    expect(failures).toContain("decision 'decision-example-1' has no alternatives");
  });

  it("rejects an interface whose component_id does not resolve", () => {
    const bad: ArchitecturePlan = {
      ...VALID_ARCHITECTURE_PLAN,
      interfaces: [{ ...VALID_ARCHITECTURE_PLAN.interfaces[0]!, component_id: 'component-example-9' as never }],
    };
    const failures = checkArchitecturePlan(bad, ctx());
    expect(
      failures.some((f) => f.includes("unresolved component_id 'component-example-9'")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planner
// ---------------------------------------------------------------------------

describe('checkTaskGraph (planner)', () => {
  it('passes on a valid fixture', () => {
    expect(
      checkTaskGraph(
        VALID_TASK_GRAPH,
        ctx({ requirementSet: VALID_REQUIREMENT_SET, architecturePlan: VALID_ARCHITECTURE_PLAN }),
      ),
    ).toEqual([]);
  });

  it('rejects a duplicate task_id', () => {
    const bad: TaskGraph = {
      tasks: [VALID_TASK_GRAPH.tasks[0]!, VALID_TASK_GRAPH.tasks[0]!],
    };
    const failures = checkTaskGraph(bad, ctx());
    expect(failures).toContain('task_id is not unique: task-example-1');
  });

  it('rejects a cyclic graph (acceptance criterion 2)', () => {
    const bad: TaskGraph = TaskGraphSchema.parse({
      tasks: [
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-example-1', depends_on: ['task-example-2'] },
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-example-2', depends_on: ['task-example-1'] },
      ],
    });
    const failures = checkTaskGraph(bad, ctx());
    expect(failures).toContain('task graph contains a cycle');
  });

  it('rejects a graph with an unreachable task (same cyclic fixture, distinct message)', () => {
    const bad: TaskGraph = TaskGraphSchema.parse({
      tasks: [
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-example-1', depends_on: ['task-example-2'] },
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-example-2', depends_on: ['task-example-1'] },
      ],
    });
    const failures = checkTaskGraph(bad, ctx());
    expect(
      failures.some((f) => f.includes('is unreachable from any zero-dependency root')),
    ).toBe(true);
  });

  it('rejects an uncovered must requirement (acceptance criterion 2)', () => {
    const bad: TaskGraph = {
      tasks: [{ ...VALID_TASK_GRAPH.tasks[0]!, req_ids: ['REQ-example-2'] }],
    };
    const failures = checkTaskGraph(bad, ctx({ requirementSet: VALID_REQUIREMENT_SET }));
    expect(failures).toContain("must requirement 'REQ-example-1' is not covered by any task");
  });

  it('rejects a task with more expected_paths than maxPathsPerTask', () => {
    const bad: TaskGraph = {
      tasks: [{ ...VALID_TASK_GRAPH.tasks[0]!, expected_paths: ['a.ts', 'b.ts', 'c.ts'] }],
    };
    const failures = checkTaskGraph(bad, ctx({ maxPathsPerTask: 2 }));
    expect(
      failures.some((f) => f.includes('exceeding maxPathsPerTask (2)')),
    ).toBe(true);
  });

  it('rejects an unresolved component_id', () => {
    const bad: TaskGraph = {
      tasks: [{ ...VALID_TASK_GRAPH.tasks[0]!, component_ids: ['component-example-9' as never] }],
    };
    const failures = checkTaskGraph(bad, ctx({ architecturePlan: VALID_ARCHITECTURE_PLAN }));
    expect(
      failures.some((f) => f.includes("unresolved component_id 'component-example-9'")),
    ).toBe(true);
  });

  it('rejects a self-dependency', () => {
    const bad: TaskGraph = {
      tasks: [{ ...VALID_TASK_GRAPH.tasks[0]!, depends_on: ['task-example-1'] }],
    };
    const failures = checkTaskGraph(bad, ctx());
    expect(failures).toContain("task 'task-example-1' depends on itself");
  });

  it('rejects a dependency on a non-existent task', () => {
    const bad: TaskGraph = {
      tasks: [{ ...VALID_TASK_GRAPH.tasks[0]!, depends_on: ['task-example-9' as never] }],
    };
    const failures = checkTaskGraph(bad, ctx());
    expect(
      failures.some((f) => f.includes("depends on non-existent task 'task-example-9'")),
    ).toBe(true);
  });
});

describe('topoOrder', () => {
  it('is deterministic on a diamond across 100 shuffles of the input tasks array', () => {
    const diamond: TaskGraph = TaskGraphSchema.parse({
      tasks: [
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-d-1', depends_on: [] },
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-d-2', depends_on: ['task-d-1'] },
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-d-3', depends_on: ['task-d-1'] },
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-d-4', depends_on: ['task-d-2', 'task-d-3'] },
      ],
    });
    const expected = topoOrder(diamond);
    expect(expected).not.toBeNull();

    let seed = 42;
    function nextRandom(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    for (let i = 0; i < 100; i += 1) {
      const shuffled = [...diamond.tasks];
      for (let j = shuffled.length - 1; j > 0; j -= 1) {
        const k = Math.floor(nextRandom() * (j + 1));
        const tmp = shuffled[j]!;
        shuffled[j] = shuffled[k]!;
        shuffled[k] = tmp;
      }
      expect(topoOrder({ tasks: shuffled })).toEqual(expected);
    }
  });

  it('returns null on a cyclic graph', () => {
    const cyclic: TaskGraph = TaskGraphSchema.parse({
      tasks: [
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-c-1', depends_on: ['task-c-2'] },
        { ...VALID_TASK_GRAPH.tasks[0]!, task_id: 'task-c-2', depends_on: ['task-c-1'] },
      ],
    });
    expect(topoOrder(cyclic)).toBeNull();
  });
});

describe('mustRequirements', () => {
  it('returns only priority: must requirements, in order', () => {
    expect(mustRequirements(VALID_REQUIREMENT_SET)).toEqual(['REQ-example-1']);
  });
});

// ---------------------------------------------------------------------------
// testAuthor
// ---------------------------------------------------------------------------

describe('checkTestSuiteSpec (testAuthor)', () => {
  it('passes on a valid fixture', () => {
    expect(
      checkTestSuiteSpec(VALID_TEST_SUITE, ctx({ requirementSet: VALID_REQUIREMENT_SET })),
    ).toEqual([]);
  });

  it('rejects a suite with no negative case (acceptance criterion 5)', () => {
    const bad: TestSuiteSpecDraft = {
      ...VALID_TEST_SUITE,
      cases: VALID_TEST_SUITE.cases.map((c) => ({ ...c, negative: false })),
    };
    const failures = checkTestSuiteSpec(bad, ctx());
    expect(failures).toContain('no test case has negative: true');
  });

  it('rejects a suite with no asserts_output case (acceptance criterion 5)', () => {
    const bad: TestSuiteSpecDraft = {
      ...VALID_TEST_SUITE,
      cases: VALID_TEST_SUITE.cases.map((c) => ({ ...c, asserts_output: false })),
    };
    const failures = checkTestSuiteSpec(bad, ctx());
    expect(failures).toContain('no test case has asserts_output: true');
  });

  it('rejects an uncovered must requirement', () => {
    const bad: TestSuiteSpecDraft = {
      ...VALID_TEST_SUITE,
      cases: VALID_TEST_SUITE.cases.map((c) => ({ ...c, req_ids: ['REQ-example-2'] })),
    };
    const failures = checkTestSuiteSpec(bad, ctx({ requirementSet: VALID_REQUIREMENT_SET }));
    expect(failures).toContain("must requirement 'REQ-example-1' is not covered by any test case");
  });

  it('rejects a path outside the target test directories', () => {
    const bad: TestSuiteSpecDraft = {
      ...VALID_TEST_SUITE,
      cases: [{ ...VALID_TEST_SUITE.cases[0]!, path: 'src/thing.ts' }],
    };
    const failures = checkTestSuiteSpec(bad, ctx());
    expect(failures.some((f) => f.includes("outside the target's test directories"))).toBe(true);
  });

  it('rejects a duplicate test_id', () => {
    const bad: TestSuiteSpecDraft = {
      ...VALID_TEST_SUITE,
      cases: [VALID_TEST_SUITE.cases[0]!, { ...VALID_TEST_SUITE.cases[0]! }],
    };
    const failures = checkTestSuiteSpec(bad, ctx());
    expect(failures).toContain('test_id is not unique: test-example-1');
  });
});

// ---------------------------------------------------------------------------
// coder
// ---------------------------------------------------------------------------

describe('checkImplementation (coder)', () => {
  it('passes on a valid fixture', () => {
    expect(
      checkImplementation(
        VALID_IMPLEMENTATION,
        ctx({ taskGraph: VALID_TASK_GRAPH, architecturePlan: VALID_ARCHITECTURE_PLAN }),
      ),
    ).toEqual([]);
  });

  it('rejects a task_id that does not match the dispatched task', () => {
    const bad: Implementation = { ...VALID_IMPLEMENTATION, task_id: 'task-example-9' as never };
    const failures = checkImplementation(bad, ctx({ taskGraph: VALID_TASK_GRAPH }));
    expect(failures).toContain("task_id 'task-example-9' does not match the dispatched task");
  });

  it('rejects a deviation whose from_decision_id does not resolve', () => {
    const bad: Implementation = {
      ...VALID_IMPLEMENTATION,
      deviations: [{ from_decision_id: 'decision-example-9' as never, reason: 'because' }],
    };
    const failures = checkImplementation(bad, ctx({ architecturePlan: VALID_ARCHITECTURE_PLAN }));
    expect(
      failures.some((f) => f.includes("unresolved from_decision_id 'decision-example-9'")),
    ).toBe(true);
  });

  it('rejects an empty files_touched', () => {
    const bad: Implementation = { ...VALID_IMPLEMENTATION, files_touched: [] };
    const failures = checkImplementation(bad, ctx());
    expect(failures).toContain('files_touched is empty');
  });
});

// ---------------------------------------------------------------------------
// reviewer
// ---------------------------------------------------------------------------

describe('checkReviewVerdict (reviewer)', () => {
  it('passes on a valid fixture', () => {
    expect(checkReviewVerdict(VALID_REVIEW_VERDICT, ctx({ taskGraph: VALID_TASK_GRAPH }))).toEqual([]);
  });

  it("rejects verdict: 'accept' with a blocking finding as incoherent", () => {
    const bad: ReviewVerdict = {
      ...VALID_REVIEW_VERDICT,
      findings: [{ severity: 'blocking', kind: 'correctness', detail: 'broken', path: null }],
    };
    const failures = checkReviewVerdict(bad, ctx());
    expect(failures).toContain("verdict: 'accept' with a blocking finding is incoherent");
  });

  it("rejects escalate_to non-null with verdict: 'revise'", () => {
    const bad: ReviewVerdict = { ...VALID_REVIEW_VERDICT, verdict: 'revise', escalate_to: 'planner' };
    const failures = checkReviewVerdict(bad, ctx());
    expect(failures).toContain("escalate_to must be non-null iff verdict === 'escalate'");
  });

  it("rejects verdict: 'escalate' with escalate_to: null", () => {
    const bad: ReviewVerdict = { ...VALID_REVIEW_VERDICT, verdict: 'escalate', escalate_to: null };
    const failures = checkReviewVerdict(bad, ctx());
    expect(failures).toContain("escalate_to must be non-null iff verdict === 'escalate'");
  });

  it('rejects a task_id that does not match the reviewed task', () => {
    const bad: ReviewVerdict = { ...VALID_REVIEW_VERDICT, task_id: 'task-example-9' as never };
    const failures = checkReviewVerdict(bad, ctx({ taskGraph: VALID_TASK_GRAPH }));
    expect(failures).toContain("task_id 'task-example-9' does not match the reviewed task");
  });
});
