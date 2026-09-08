import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidates, buildTaskSection, coderModule, postStep } from '../../src/agents/coder.js';
import { freezeTests } from '../../src/supervisor/freeze.js';
import { TaskGraphSchema } from '../../src/contracts/taskGraph.js';
import { ImplementationSchema } from '../../src/contracts/implementation.js';
import type { TaskGraph } from '../../src/contracts/index.js';
import type { CheckContext } from '../../src/agents/checks.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import { SlugSchema, SuiteIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import type { FrozenTestsState } from '../../src/state/workitem.js';
import type { IsoTimestamp } from '../../src/core/clock.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const slug = SlugSchema.parse('example');

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

const TWO_TASK_GRAPH: TaskGraph = TaskGraphSchema.parse({
  tasks: [
    {
      task_id: 'task-example-2',
      title: 'second task',
      req_ids: ['REQ-example-2'],
      component_ids: [],
      expected_paths: ['src/b.ts'],
      depends_on: ['task-example-1'],
      definition_of_done: ['b works'],
      estimated_turns: 2,
    },
    {
      task_id: 'task-example-1',
      title: 'first task',
      req_ids: ['REQ-example-1'],
      component_ids: [],
      expected_paths: ['src/a.ts'],
      depends_on: [],
      definition_of_done: ['a works'],
      estimated_turns: 2,
    },
  ],
});

function checkContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    requirementSet: null,
    architecturePlan: null,
    taskGraph: TWO_TASK_GRAPH,
    maxPathsPerTask: 8,
    testDirs: ['test/'],
    ...overrides,
  };
}

function pack(overrides: Partial<PackBuildInput['raw']> = {}, ctxOverrides: Partial<CheckContext> = {}): PackBuildInput {
  return {
    itemId,
    checkContext: checkContext(ctxOverrides),
    task: TWO_TASK_GRAPH.tasks[0]!,
    activeT1OracleFailure: false,
    activeCauseLevel: null,
    raw: { ...emptyRaw(), ...overrides },
  };
}

describe('coder.buildCandidates / buildTaskSection use the state-selected task', () => {
  it('buildTaskSection dispatches task-example-2 (the selected task), not task-example-1', () => {
    const text = buildTaskSection(pack());
    expect(text).toContain('task-example-2');
    expect(text).not.toContain('task-example-1');
  });

  it("buildCandidates' pack contains only the selected task", () => {
    const sections = buildCandidates(
      pack({ sourceFiles: [{ path: 'src/a.ts', body: 'a' }, { path: 'src/b.ts', body: 'b' }] }),
    );
    const taskSection = sections.find((s) => s.kind === 'task');
    expect(taskSection?.body).toContain('task-example-2');
    expect(taskSection?.body).toContain('"task_id": "task-example-2"');

    const sourceSection = sections.find((s) => s.kind === 'source-files');
    expect(sourceSection?.body).not.toContain('src/a.ts');
    expect(sourceSection?.body).toContain('src/b.ts');
  });

  it('never emits prd, wiki-index, requirement-set, task-graph, coder-transcript or other-task findings', () => {
    const sections = buildCandidates(pack());
    const kinds = sections.map((s) => s.kind);
    for (const forbidden of ['prd', 'wiki-index', 'requirement-set', 'task-graph', 'coder-transcript', 'other-task-reviewer-findings']) {
      expect(kinds).not.toContain(forbidden);
    }
  });
});

let root: string;
let workdir: string;
let frozenTestsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'miengu-coder-'));
  workdir = join(root, 'workdir');
  frozenTestsDir = join(root, 'frozen-tests');
  await mkdir(join(workdir, 'test'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const VALID_IMPLEMENTATION = ImplementationSchema.parse({
  task_id: 'task-example-1',
  diff_ref: 'diff-sha-abc',
  files_touched: ['src/a.ts'],
  assumption_ids: [],
  deviations: [],
});

async function frozenState(): Promise<FrozenTestsState> {
  await writeFile(join(workdir, 'test/a.test.ts'), 'original body');
  const frozen = await freezeTests({
    workdir,
    frozenCopyDir: frozenTestsDir,
    paths: ['test/a.test.ts'],
    suiteId: SuiteIdSchema.parse('suite-example-1'),
  });
  return {
    suiteId: SuiteIdSchema.parse('suite-example-1'),
    contentHash: frozen.contentHash,
    files: frozen.files,
    frozenCopyDir: frozenTestsDir,
    at: '2024-01-01T00:00:00.000Z' as IsoTimestamp,
  };
}

describe("coder.postStep — the Coder's re-hash", () => {
  it('a mutated test file emits TestsTampered, restores the bytes, and returns tests-tampered', async () => {
    const frozen = await frozenState();
    await writeFile(join(workdir, 'test/a.test.ts'), 'TAMPERED CONTENT');

    const result = await postStep({
      itemId,
      slug,
      artifact: VALID_IMPLEMENTATION,
      checkContext: checkContext(),
      ids: undefined as never,
      workdir,
      frozenTestsDir,
      frozenTests: frozen,
      appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as IsoTimestamp }),
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('tests-tampered');
    }
    const tampered = result.derived.find((d) => d.type === 'TestsTampered');
    expect(tampered).toBeDefined();
    expect((tampered?.data as { restored: boolean }).restored).toBe(true);

    const { readFile } = await import('node:fs/promises');
    const restored = await readFile(join(workdir, 'test/a.test.ts'), 'utf8');
    expect(restored).toBe('original body');
  });

  it('an intact suite completes normally with no derived events', async () => {
    const frozen = await frozenState();

    const result = await postStep({
      itemId,
      slug,
      artifact: VALID_IMPLEMENTATION,
      checkContext: checkContext(),
      ids: undefined as never,
      workdir,
      frozenTestsDir,
      frozenTests: frozen,
      appendDerived: async () => ({ ts: '2024-01-01T00:00:00.000Z' as IsoTimestamp }),
    });

    expect(result.kind).toBe('ok');
    expect(result.derived).toEqual([]);
  });
});

describe('coderModule', () => {
  it('binds role, stage and artifactKind consistently', () => {
    expect(coderModule.role).toBe('coder');
    expect(coderModule.stage).toBe('implementation');
    expect(coderModule.artifactKind).toBe('implementation');
  });
});
