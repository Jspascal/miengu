import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EventLog, itemPaths } from '../../src/core/log.js';
import type { Role } from '../../src/core/events.js';
import { RunIdSchema, WorkItemIdSchema, AccountIdSchema, ExecutorInstanceIdSchema } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { createSnapshotStore } from '../../src/core/snapshot.js';
import { project } from '../../src/state/projector.js';
import { WorkItemStateSchema } from '../../src/state/workitem.js';
import type { WorkItemState } from '../../src/state/workitem.js';
import { stateHash } from '../../src/state/stateHash.js';
import { MienguConfigSchema } from '../../src/config/schema.js';
import { policyFromConfig } from '../../src/supervisor/nextStage.js';
import { StubExecutor } from '../../src/executors/stub.js';
import type { StubScript } from '../../src/executors/stub.js';
import { createWorkspaceProvider } from '../../src/executors/isolation.js';
import type {
  Executor,
  ExecutorInput,
  ExecutorResult,
  RawRunRecord,
  RawRunSource,
} from '../../src/executors/executor.js';
import type { ExecutorHandle, ExecutorRegistry, ResolvedRoleSettings } from '../../src/executors/registry.js';
import { runItem, MAX_LOOP_ITERATIONS } from '../../src/supervisor/loop.js';
import type { RunItemDeps } from '../../src/supervisor/loop.js';

const execFileAsync = promisify(execFile);
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const ACCOUNT = AccountIdSchema.parse('stub-account');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

const ROLES: readonly Role[] = ['analyst', 'architect', 'planner', 'testAuthor', 'coder', 'reviewer'];

const EXECUTOR_ID_FOR_ROLE: Readonly<Record<Role, string>> = {
  analyst: 'stub-analyst',
  architect: 'stub-architect',
  planner: 'stub-planner',
  testAuthor: 'stub-testauthor',
  coder: 'stub-coder',
  reviewer: 'stub-reviewer',
};

const RESOLVED: ResolvedRoleSettings = { model: null, effort: null, maxTurns: 8, contextBudgetTokens: 40000 };

let targetRepo: string;
let storeDir: string;

beforeEach(async () => {
  targetRepo = await mkdtemp(join(tmpdir(), 'miengu-loop-target-'));
  await git(targetRepo, ['init', '--initial-branch=main']);
  await git(targetRepo, ['config', 'user.email', 'test@example.com']);
  await git(targetRepo, ['config', 'user.name', 'Test']);
  await writeFile(join(targetRepo, 'README.md'), 'hello\n');
  await git(targetRepo, ['add', 'README.md']);
  await git(targetRepo, ['commit', '-m', 'initial']);
  storeDir = await mkdtemp(join(tmpdir(), 'miengu-loop-store-'));
});

afterEach(async () => {
  await rm(targetRepo, { recursive: true, force: true });
  await rm(storeDir, { recursive: true, force: true });
});

function makeConfig(overrides: { maxWallSecondsPerInvocation?: number; snapshotEvery?: number; failBuildOracle?: boolean; oneAttemptPerRung?: boolean; oracles?: Record<'build' | 'typecheck' | 'lint' | 'test', string | null>; checkpoints?: unknown } = {}) {
  return MienguConfigSchema.parse({
    target: { repo: targetRepo },
    accounts: { 'stub-account': {} },
    executors: {
      'stub-analyst': { type: 'stub', account: 'stub-account' },
      'stub-architect': { type: 'stub', account: 'stub-account' },
      'stub-planner': { type: 'stub', account: 'stub-account' },
      'stub-testauthor': { type: 'stub', account: 'stub-account' },
      'stub-coder': { type: 'stub', account: 'stub-account' },
      'stub-reviewer': { type: 'stub', account: 'stub-account' },
    },
    tiers: {
      'stub-analyst': 1,
      'stub-architect': 1,
      'stub-planner': 1,
      'stub-testauthor': 1,
      'stub-coder': 1,
      'stub-reviewer': 1,
    },
    roles: {
      analyst: { executor: 'stub-analyst', maxTurns: 8, contextBudgetTokens: 40000 },
      architect: { executor: 'stub-architect', maxTurns: 8, contextBudgetTokens: 40000 },
      planner: { executor: 'stub-planner', maxTurns: 8, contextBudgetTokens: 40000 },
      testAuthor: { executor: 'stub-testauthor', maxTurns: 8, contextBudgetTokens: 40000 },
      coder: { executor: 'stub-coder', maxTurns: 8, contextBudgetTokens: 40000 },
      reviewer: { executor: 'stub-reviewer', maxTurns: 8, contextBudgetTokens: 40000 },
    },
    budget: {
      maxWallSecondsPerInvocation: overrides.maxWallSecondsPerInvocation ?? 1800,
    },
    oracles: overrides.oracles ?? (overrides.failBuildOracle ? { build: 'node -e "process.exit(1)"' } : {}),
    limits: overrides.oneAttemptPerRung ? { kOracle: 1, kTest: 1, kReview: 1, maxAttemptsPerStage: 1 } : {},
    store: { snapshotEvery: overrides.snapshotEvery ?? 200 },
    ...(overrides.checkpoints !== undefined ? { checkpoints: overrides.checkpoints } : {}),
  });
}

/** A hand-built registry: `buildExecutorRegistry` only constructs config-declared adapters
 *  (no way to script a `stub` instance's output from config alone), so the loop's own tests
 *  supply per-role `StubExecutor`s directly, exactly like `test/agents/agent.test.ts` does
 *  for a single role. */
function makeStubRegistry(scripts: Partial<Record<Role, StubScript>>, seed: string): ExecutorRegistry {
  const handles = new Map<Role, ExecutorHandle>();
  for (const role of ROLES) {
    const script = scripts[role];
    const executor = new StubExecutor({
      id: ExecutorInstanceIdSchema.parse(EXECUTOR_ID_FOR_ROLE[role]),
      account: ACCOUNT,
      ...(script !== undefined ? { script } : {}),
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng(`${seed}-${role}`)),
    });
    handles.set(role, {
      role,
      executor,
      sandboxIntent: role === 'testAuthor' || role === 'coder' ? 'workspace-write' : 'read-only',
      resolved: RESOLVED,
    });
  }
  return {
    forRole(role: Role): ExecutorHandle {
      const handle = handles.get(role);
      if (handle === undefined) {
        throw new Error(`no stub handle for role "${role}"`);
      }
      return handle;
    },
    accountForRole(): ReturnType<typeof AccountIdSchema.parse> {
      return ACCOUNT;
    },
    get handles(): readonly ExecutorHandle[] {
      return Array.from(handles.values());
    },
  };
}

async function makeDeps(o: {
  itemId: ReturnType<typeof WorkItemIdSchema.parse>;
  seed: string;
  executors: ExecutorRegistry;
  config: ReturnType<typeof makeConfig>;
  retainWorkspace?: boolean;
}): Promise<{ deps: RunItemDeps; log: EventLog }> {
  const runId = RunIdSchema.parse('run-01234567-89ab-cdef-0123-456789abcdef');
  const clock = fixedClock(START);
  const ids = createIdMinter(fixedRng(o.seed));
  const { log } = await EventLog.create({
    storeDir,
    itemId: o.itemId,
    runId,
    clock,
    ids,
    logger: silentLogger,
  });
  await log.append({
    type: 'WorkItemCreated',
    data: {
      title: 'Example item',
      slug: 'example',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
      config_hash: 'deadbeef',
    },
    actor: { kind: 'system', id: null },
    causationId: null,
  });

  const snapshots = createSnapshotStore<WorkItemState>({
    dir: itemPaths(storeDir, o.itemId).snapshotsDir,
    itemId: o.itemId,
    projectionVersion: 1,
    hashState: stateHash,
    parseState: (v) => WorkItemStateSchema.parse(v),
  });

  const paths = itemPaths(storeDir, o.itemId);
  const deps: RunItemDeps = {
    log,
    snapshots,
    config: o.config,
    policy: policyFromConfig(o.config),
    executors: o.executors,
    workspace: createWorkspaceProvider('worktree'),
    targetRepo,
    workspacesDir: paths.workspacesDir,
    promptsDir: join(paths.itemDir, 'prompts'),
    schemasDir: join(paths.itemDir, 'schemas'),
    messagesDir: join(paths.itemDir, 'messages'),
    frozenTestsDir: join(paths.itemDir, 'frozen-tests'),
    clock,
    ids,
    logger: silentLogger,
    signal: new AbortController().signal,
    retainWorkspace: o.retainWorkspace ?? false,
  };
  return { deps, log };
}

function telemetry(turns = 1) {
  return {
    turns,
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    wallSeconds: 1,
  };
}

function completedStep(finalMessage: unknown, writeFiles?: Record<string, string>): StubScript {
  return {
    steps: [
      {
        status: 'completed',
        telemetry: telemetry(),
        finalMessage: JSON.stringify(finalMessage),
        ...(writeFiles !== undefined ? { writeFiles } : {}),
      },
    ],
  };
}

const REQUIREMENT_SET = {
  requirements: [
    {
      req_id: 'REQ-example-1',
      statement: 'the system does X',
      rationale: 'because Y',
      acceptance: ['X is observable'],
      priority: 'must',
      source_span: 'prd:1',
    },
  ],
  ambiguities: [],
  out_of_scope: [],
};

const ARCHITECTURE_PLAN = {
  decisions: [
    {
      decision_id: 'decision-example-1',
      title: 'pick an approach',
      choice: 'do it directly',
      alternatives: ['do it indirectly'],
      rationale: 'simplest thing that works',
      req_ids: ['REQ-example-1'],
      supersedes: null,
      blast_radius: 'reversible',
    },
  ],
  components: [
    {
      component_id: 'component-example-1',
      responsibility: 'does X',
      paths: ['src/x.ts'],
      depends_on: [],
    },
  ],
  interfaces: [
    {
      interface_id: 'interface-example-1',
      component_id: 'component-example-1',
      signature: 'doX(): void',
      behaviour: 'performs X',
      req_ids: ['REQ-example-1'],
    },
  ],
};

const TASK_GRAPH = {
  tasks: [
    {
      task_id: 'task-example-1',
      title: 'implement X',
      req_ids: ['REQ-example-1'],
      component_ids: ['component-example-1'],
      expected_paths: ['src/x.ts'],
      depends_on: [],
      definition_of_done: ['X works'],
      estimated_turns: 1,
    },
  ],
};

const TEST_SUITE_DRAFT = {
  suite_id: 'suite-example-1',
  cases: [
    {
      test_id: 'test-example-1',
      req_ids: ['REQ-example-1'],
      path: 'test/a.test.ts',
      intent: 'asserts X works',
      negative: false,
      asserts_output: true,
    },
    {
      test_id: 'test-example-2',
      req_ids: ['REQ-example-1'],
      path: 'test/b.test.ts',
      intent: 'asserts X rejects bad input',
      negative: true,
      asserts_output: false,
    },
  ],
};

const IMPLEMENTATION = {
  task_id: 'task-example-1',
  diff_ref: 'diffref',
  files_touched: ['src/x.ts'],
  assumption_ids: [],
  deviations: [],
};

const REVIEW_VERDICT = {
  task_id: 'task-example-1',
  verdict: 'accept',
  findings: [],
  escalate_to: null,
};

function happyPathScripts(): Partial<Record<Role, StubScript>> {
  return {
    analyst: completedStep(REQUIREMENT_SET),
    architect: completedStep(ARCHITECTURE_PLAN),
    planner: completedStep(TASK_GRAPH),
    testAuthor: completedStep(TEST_SUITE_DRAFT, {
      'test/a.test.ts': 'test body A\n',
      'test/b.test.ts': 'test body B\n',
    }),
    coder: completedStep(IMPLEMENTATION),
    reviewer: completedStep(REVIEW_VERDICT),
  };
}

function expectedHappyPathTypes(): string[] {
  return [
    'WorkItemCreated',
    'StageEntered',
    'StageCompleted',
    'StageEntered',
    'WorkspacePrepared',
    'WorktreeLockAcquired',
    'ExecutorInvoked',
    'ExecutorReturned',
    'DiffCaptured',
    'BudgetConsumed',
    'StageCompleted',
    'WorktreeLockReleased',
    'StageEntered',
    'WorktreeLockAcquired',
    'ExecutorInvoked',
    'ExecutorReturned',
    'DiffCaptured',
    'BudgetConsumed',
    'StageCompleted',
    'WorktreeLockReleased',
    'StageEntered',
    'WorktreeLockAcquired',
    'ExecutorInvoked',
    'ExecutorReturned',
    'DiffCaptured',
    'BudgetConsumed',
    'StageCompleted',
    'WorktreeLockReleased',
    'TaskGraphActivated',
    'StageEntered',
    'WorktreeLockAcquired',
    'ExecutorInvoked',
    'ExecutorReturned',
    'TestsFrozen',
    'DiffCaptured',
    'BudgetConsumed',
    'StageCompleted',
    'WorktreeLockReleased',
    'WorkspaceCheckpointed',
    'TaskStarted',
    'StageEntered',
    'WorktreeLockAcquired',
    'ExecutorInvoked',
    'ExecutorReturned',
    'DiffCaptured',
    'BudgetConsumed',
    'StageCompleted',
    'WorktreeLockReleased',
    'OracleSweepStarted',
    'OracleSweepCompleted',
    'StageEntered',
    'WorktreeLockAcquired',
    'ExecutorInvoked',
    'ExecutorReturned',
    'DiffCaptured',
    'BudgetConsumed',
    'StageCompleted',
    'WorktreeLockReleased',
    'WorkspaceCheckpointed',
    'TaskAccepted',
    'OracleSweepStarted',
    'OracleSweepCompleted',
    'FinalPatchCaptured',
    'WorkItemCompleted',
    'WorkspaceDiscarded',
  ];
}

describe('runItem: happy path with StubExecutor', () => {
  it('reaches stage:"done", status:"completed" with the exact expected event-type sequence', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-happy1');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-happy',
      executors: makeStubRegistry(happyPathScripts(), 'loop-happy-exec'),
      config: makeConfig(),
    });

    const result = await runItem(deps);

    expect(result.outcome).toBe('completed');
    expect(result.finalState.status).toBe('completed');
    expect(result.finalState.stage).toBe('done');

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual(expectedHappyPathTypes());
    expect(events.map((e) => e.seq)).toEqual(events.map((_e, i) => i + 1));

    const invoked = events.filter((e) => e.type === 'ExecutorInvoked');
    expect(invoked).toHaveLength(6);
    const returned = events.filter((e) => e.type === 'ExecutorReturned');
    expect(returned).toHaveLength(6);

    await log.close();
  });

  it('intake and integration produce no ExecutorInvoked', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-happy2');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-happy2',
      executors: makeStubRegistry(happyPathScripts(), 'loop-happy2-exec'),
      config: makeConfig(),
    });

    await runItem(deps);
    const events = await log.readAll();

    const stageEnteredForIntake = events.filter(
      (e) => e.type === 'StageEntered' && e.data.stage === 'intake',
    );
    const integrationSweeps = events.filter(
      (e) => e.type === 'OracleSweepStarted' && e.data.scope === 'integration',
    );
    expect(stageEnteredForIntake).toHaveLength(1);
    expect(integrationSweeps).toHaveLength(1);

    // Neither supervisor-owned intake nor the integration sweep invokes an agent.
    const executorInvokedStages = new Set(
      events.filter((e) => e.type === 'ExecutorInvoked').map((e) => e.data.stage),
    );
    expect(executorInvokedStages.has('intake')).toBe(false);
    expect(executorInvokedStages.has('integration')).toBe(false);

    await log.close();
  });

  it('every WorktreeLockAcquired has a matching WorktreeLockReleased', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-happy3');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-happy3',
      executors: makeStubRegistry(happyPathScripts(), 'loop-happy3-exec'),
      config: makeConfig(),
    });

    await runItem(deps);
    const events = await log.readAll();
    const acquired = events.filter((e) => e.type === 'WorktreeLockAcquired');
    const released = events.filter((e) => e.type === 'WorktreeLockReleased');
    expect(acquired).toHaveLength(released.length);
    expect(acquired).toHaveLength(6);

    await log.close();
  });
});

describe('runItem: causal escalation', () => {
  it.each([
    ['planner', 'wi-review-active-plan-000001'],
    ['architect', 'wi-review-active-arch-000001'],
    ['analyst', 'wi-review-active-anal-000001'],
  ] as const)('honors Reviewer escalate_to:%s as a direct upward transition for an active cause', async (target, item) => {
    const itemId = WorkItemIdSchema.parse(item);
    const scripts = happyPathScripts();
    scripts.reviewer = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify({ ...REVIEW_VERDICT, verdict: 'revise', findings: [{ severity: 'major', kind: 'correctness', detail: 'repair', path: null }] }) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify({ ...REVIEW_VERDICT, verdict: 'escalate', escalate_to: target }) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REVIEW_VERDICT) },
    ] };
    scripts.coder = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
    ] };
    scripts.planner = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TASK_GRAPH) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TASK_GRAPH) },
    ] };
    if (target === 'architect' || target === 'analyst') {
      scripts.architect = { steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(ARCHITECTURE_PLAN) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(ARCHITECTURE_PLAN) },
      ] };
      scripts.testAuthor = { steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TEST_SUITE_DRAFT), writeFiles: { 'test/a.test.ts': 'test body A\n', 'test/b.test.ts': 'test body B\n' } },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TEST_SUITE_DRAFT), writeFiles: { 'test/a.test.ts': 'test body A\n', 'test/b.test.ts': 'test body B\n' } },
      ] };
    }
    if (target === 'analyst') {
      scripts.analyst = { steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REQUIREMENT_SET) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REQUIREMENT_SET) },
      ] };
    }
    const { deps, log } = await makeDeps({
      itemId, seed: `loop-review-active-${target}`,
      executors: makeStubRegistry(scripts, `loop-review-active-${target}-exec`), config: makeConfig(),
    });
    const result = await runItem(deps);
    const events = await log.readAll();
    const direct = events.find((event) => event.type === 'EscalationAdvanced' && event.data.from_level === 'coder' && event.data.to_level === target);
    expect(result.outcome).toBe('completed');
    expect(direct).toBeDefined();
    expect(events.filter((event) => event.type === 'FailureCauseOpened')).toHaveLength(1);
    await log.close();
  });

  it.each([
    ['architect', 'wi-stale-arch-000001'],
    ['analyst', 'wi-stale-anal-000001'],
  ] as const)('restores the original base before %s regeneration, removing stale tests and task code', async (target, item) => {
    const itemId = WorkItemIdSchema.parse(item);
    const scripts = happyPathScripts();
    scripts.reviewer = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify({ ...REVIEW_VERDICT, verdict: 'escalate', escalate_to: target }) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REVIEW_VERDICT) },
    ] };
    scripts.coder = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION), writeFiles: { 'src/stale-task.ts': 'stale\n' } },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION), writeFiles: { 'src/fresh-task.ts': 'fresh\n' } },
    ] };
    scripts.architect = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(ARCHITECTURE_PLAN) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(ARCHITECTURE_PLAN) },
    ] };
    scripts.planner = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TASK_GRAPH) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TASK_GRAPH) },
    ] };
    scripts.testAuthor = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TEST_SUITE_DRAFT), writeFiles: { 'test/a.test.ts': 'test body A\n', 'test/b.test.ts': 'test body B\n', 'test/stale.test.ts': 'stale\n' } },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TEST_SUITE_DRAFT), writeFiles: { 'test/a.test.ts': 'test body A\n', 'test/b.test.ts': 'test body B\n', 'test/fresh.test.ts': 'fresh\n' } },
    ] };
    if (target === 'analyst') {
      scripts.analyst = { steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REQUIREMENT_SET) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REQUIREMENT_SET) },
      ] };
    }
    const { deps, log } = await makeDeps({
      itemId, seed: `loop-stale-${target}`,
      executors: makeStubRegistry(scripts, `loop-stale-${target}-exec`), config: makeConfig(), retainWorkspace: true,
    });
    const result = await runItem(deps);
    const events = await log.readAll();
    const prepared = events.find((event) => event.type === 'WorkspacePrepared');
    expect(result.outcome).toBe('completed');
    expect(prepared).toBeDefined();
    if (prepared?.type === 'WorkspacePrepared') {
      await expect(readFile(join(prepared.data.workdir, 'test/stale.test.ts'))).rejects.toThrow();
      await expect(readFile(join(prepared.data.workdir, 'src/stale-task.ts'))).rejects.toThrow();
      expect(await readFile(join(prepared.data.workdir, 'test/fresh.test.ts'), 'utf8')).toBe('fresh\n');
      expect(await readFile(join(prepared.data.workdir, 'src/fresh-task.ts'), 'utf8')).toBe('fresh\n');
    }
    await log.close();
  });

  it.each([
    ['architect', 'architecture', 'architect', 'wi-revarc-000001'],
    ['analyst', 'requirements', 'analyst', 'wi-revana-000001'],
  ] as const)('maps Reviewer escalate_to:%s to the %s cause and %s invalidation boundary', async (escalateTo, kind, target, item) => {
    const itemId = WorkItemIdSchema.parse(item);
    const scripts = happyPathScripts();
    scripts.reviewer = {
      steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify({ ...REVIEW_VERDICT, verdict: 'escalate', escalate_to: escalateTo }) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REVIEW_VERDICT) },
      ],
    };
    if (escalateTo === 'architect') {
      scripts.architect = { steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(ARCHITECTURE_PLAN) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(ARCHITECTURE_PLAN) },
      ] };
    } else {
      scripts.analyst = { steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REQUIREMENT_SET) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REQUIREMENT_SET) },
      ] };
    }
    const { deps, log } = await makeDeps({
      itemId,
      seed: `loop-review-${escalateTo}`,
      executors: makeStubRegistry(scripts, `loop-review-${escalateTo}-exec`),
      config: makeConfig(),
    });

    const result = await runItem(deps);
    const events = await log.readAll();
    const cause = events.find((event) => event.type === 'FailureCauseOpened' && event.data.kind === kind);
    const invalidation = events.find((event) => event.type === 'ArtifactsInvalidated' && event.data.target === target);

    expect(result.outcome).toBe('completed');
    expect(cause).toMatchObject({ type: 'FailureCauseOpened', data: { initial_level: escalateTo } });
    expect(invalidation).toBeDefined();
    expect(events.filter((event) => event.type === 'StageCompleted' && event.data.stage === 'test-authoring')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'TestsFrozen')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'WorkspaceCheckpointed' && event.data.kind === 'tests-frozen')).toHaveLength(2);
    expect(events.some((event) => event.type === 'WorkItemParked' && event.data.reason === 'awaiting-human')).toBe(false);
    await log.close();
  });

  it('runs a fresh sweep after a corrective Coder implementation, then reviews and accepts it', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-rswp01');
    const scripts = happyPathScripts();
    scripts.coder = {
      steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION), writeFiles: { '.oracle-once': '' } },
      ],
    };
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-resweep',
      executors: makeStubRegistry(scripts, 'loop-resweep-exec'),
      // The first task sweep records a durable failure; the corrective Coder execution
      // creates a new implementation event, after which the same oracle passes.
      config: makeConfig({
        oracles: { build: 'test -f .oracle-once || (touch .oracle-once; false)', typecheck: null, lint: null, test: null },
      }),
    });

    const result = await runItem(deps);
    const events = await log.readAll();
    const taskSweeps = events.filter((event) => event.type === 'OracleSweepStarted' && event.data.scope === 'task');
    const implementations = events.filter((event) => event.type === 'StageCompleted' && event.data.stage === 'implementation');
    const secondSweep = taskSweeps[1];
    const review = events.find((event) => event.type === 'StageCompleted' && event.data.stage === 'review');
    const accepted = events.find((event) => event.type === 'TaskAccepted');
    const cause = events.find((event) => event.type === 'FailureCauseOpened' && event.data.kind === 'oracle');
    const resolution = cause === undefined ? undefined : events.find((event) =>
      event.type === 'FailureCauseResolved' && event.data.cause_id === cause.event_id,
    );
    const acceptanceChain = events
      .filter((event) =>
        (event.type === 'OracleSweepCompleted' && event.data.scope === 'task') ||
        (event.type === 'FailureCauseOpened' && event.data.kind === 'oracle') ||
        (event.type === 'FailureAttempted' && event.data.cause_id === cause?.event_id) ||
        (event.type === 'StageCompleted' && event.data.stage === 'review') ||
        (event.type === 'FailureCauseResolved' && event.data.cause_id === cause?.event_id) ||
        (event.type === 'WorkspaceCheckpointed' && event.data.kind === 'task-accepted') ||
        event.type === 'TaskAccepted',
      )
      .map((event) => event.type === 'OracleSweepCompleted' ? `${event.type}:${event.data.outcome}` : event.type);

    expect(result.outcome).toBe('completed');
    expect(implementations).toHaveLength(2);
    expect(taskSweeps).toHaveLength(2);
    expect(secondSweep?.seq).toBeGreaterThan(implementations[1]!.seq);
    expect(review?.seq).toBeGreaterThan(secondSweep!.seq);
    expect(accepted?.seq).toBeGreaterThan(review!.seq);
    expect(acceptanceChain).toEqual([
      'OracleSweepCompleted:failed',
      'FailureCauseOpened',
      'FailureAttempted',
      'OracleSweepCompleted:passed',
      'StageCompleted',
      'FailureCauseResolved',
      'WorkspaceCheckpointed',
      'TaskAccepted',
    ]);
    // A crash after Reviewer acceptance but before the accept-task action must replay as an
    // unresolved cause; resuming then emits exactly one resolution followed by acceptance.
    const resolutionIndex = events.findIndex((event) => event === resolution);
    expect(project(events.slice(0, resolutionIndex)).activeCauseId).toBe(cause?.event_id ?? null);
    expect(project(events).tasks?.records['task-example-1']?.status).toBe('accepted');
    await log.close();
  });

  it('resolves a test-remediation cause before exactly one acceptance', async () => {
    const itemId = WorkItemIdSchema.parse('wi-testremed-000001');
    const scripts = happyPathScripts();
    scripts.coder = {
      steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION), writeFiles: { 'test/a.test.ts': 'tampered\n' } },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
      ],
    };
    const { deps, log } = await makeDeps({
      itemId, seed: 'loop-test-remediation', executors: makeStubRegistry(scripts, 'loop-test-remediation-exec'), config: makeConfig(),
    });

    const result = await runItem(deps);
    const events = await log.readAll();
    const cause = events.find((event) => event.type === 'FailureCauseOpened' && event.data.kind === 'test');
    const accepted = events.filter((event) => event.type === 'TaskAccepted');
    const resolution = cause === undefined ? undefined : events.find((event) =>
      event.type === 'FailureCauseResolved' && event.data.cause_id === cause.event_id,
    );

    expect(result.outcome).toBe('completed');
    expect(events.some((event) => event.type === 'TestsTampered')).toBe(true);
    expect(cause).toBeDefined();
    expect(resolution?.seq).toBeLessThan(accepted[0]?.seq ?? Number.POSITIVE_INFINITY);
    expect(accepted).toHaveLength(1);
    await log.close();
  });

  it('resolves a revise-remediation cause before exactly one acceptance', async () => {
    const itemId = WorkItemIdSchema.parse('wi-revisemed-000001');
    const scripts = happyPathScripts();
    const revise = {
      ...REVIEW_VERDICT,
      verdict: 'revise' as const,
      findings: [{ severity: 'major' as const, kind: 'correctness' as const, detail: 'fix it', path: null }],
    };
    scripts.coder = {
      steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
      ],
    };
    scripts.reviewer = {
      steps: [
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(revise) },
        { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REVIEW_VERDICT) },
      ],
    };
    const { deps, log } = await makeDeps({
      itemId, seed: 'loop-revise-remediation', executors: makeStubRegistry(scripts, 'loop-revise-remediation-exec'), config: makeConfig(),
    });

    const result = await runItem(deps);
    const events = await log.readAll();
    const cause = events.find((event) => event.type === 'FailureCauseOpened' && event.data.kind === 'review-revision');
    const accepted = events.filter((event) => event.type === 'TaskAccepted');
    const resolution = cause === undefined ? undefined : events.find((event) =>
      event.type === 'FailureCauseResolved' && event.data.cause_id === cause.event_id,
    );

    expect(result.outcome).toBe('completed');
    expect(cause).toBeDefined();
    expect(resolution?.seq).toBeLessThan(accepted[0]?.seq ?? Number.POSITIVE_INFINITY);
    expect(accepted).toHaveLength(1);
    await log.close();
  });

  it('turns repeated Reviewer revise verdicts into bounded causal escalation rather than accept-task retries', async () => {
    const itemId = WorkItemIdSchema.parse('wi-revtry-000001');
    const scripts = happyPathScripts();
    const revise = { ...REVIEW_VERDICT, verdict: 'revise' as const, findings: [{ severity: 'major' as const, kind: 'correctness' as const, detail: 'fix it', path: null }] };
    scripts.planner = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TASK_GRAPH) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TASK_GRAPH) },
    ] };
    scripts.coder = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
    ] };
    scripts.reviewer = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(revise) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(revise) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REVIEW_VERDICT) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(REVIEW_VERDICT) },
    ] };
    const { deps, log } = await makeDeps({
      itemId, seed: 'loop-review-retry', executors: makeStubRegistry(scripts, 'loop-review-retry-exec'),
      config: makeConfig({ oneAttemptPerRung: true }),
    });
    const result = await runItem(deps);
    const events = await log.readAll();
    expect(result.outcome).toBe('completed');
    expect(events.filter((event) => event.type === 'StageCompleted' && event.data.stage === 'implementation').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.type === 'StageCompleted' && event.data.stage === 'review').length).toBeGreaterThanOrEqual(2);
    expect(events.some((event) => event.type === 'EscalationAdvanced' && event.data.to_level === 'reviewer')).toBe(true);
    expect(events.some((event) => event.type === 'EscalationAdvanced' && event.data.to_level === 'planner')).toBe(true);
    const resolution = events.find((event) => event.type === 'FailureCauseResolved');
    const accepted = events.filter((event) => event.type === 'TaskAccepted');
    expect(resolution?.seq).toBeLessThan(accepted[0]?.seq ?? Number.POSITIVE_INFINITY);
    expect(accepted).toHaveLength(1);
    expect(events.length).toBeLessThan(MAX_LOOP_ITERATIONS);
    await log.close();
  });

  it('resolves an oracle cause after Planner remediation and accepts the regenerated task pipeline', async () => {
    const itemId = WorkItemIdSchema.parse('wi-oraplan-000001');
    const counter = join(storeDir, 'planner-remediation-oracle-counter');
    const command = `node -e ${JSON.stringify(`const fs=require('fs');const p=${JSON.stringify(counter)};const n=Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0);fs.writeFileSync(p,String(n+1));process.exit(n < 2 ? 1 : 0)`)}`;
    const scripts = happyPathScripts();
    // Planner is called once for the original graph and once to regenerate it after the
    // oracle cause has crossed Coder and Reviewer. The third implementation reaches a fresh,
    // passing sweep; the integration sweep then passes too.
    scripts.planner = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TASK_GRAPH) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(TASK_GRAPH) },
    ] };
    scripts.coder = { steps: [
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
    ] };
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-oracle-planner-remediation',
      executors: makeStubRegistry(scripts, 'loop-oracle-planner-remediation-exec'),
      config: makeConfig({ oneAttemptPerRung: true, oracles: { build: command, typecheck: null, lint: null, test: null } }),
    });

    const result = await runItem(deps);
    const events = await log.readAll();
    const cause = events.find((event) => event.type === 'FailureCauseOpened' && event.data.kind === 'oracle');
    const resolved = events.find((event) => event.type === 'FailureCauseResolved' && event.data.resolution === 'planner remediation completed');
    const taskSweeps = events.filter((event) => event.type === 'OracleSweepStarted' && event.data.scope === 'task');
    const accepted = events.find((event) => event.type === 'TaskAccepted');

    expect(result.outcome).toBe('completed');
    expect(cause).toBeDefined();
    expect(resolved).toBeDefined();
    expect(events.some((event) => event.type === 'FailureAttempted' && event.data.level === 'planner')).toBe(true);
    expect(taskSweeps).toHaveLength(3);
    expect(accepted?.seq).toBeGreaterThan(taskSweeps[2]!.seq);
    expect(events.some((event) => event.type === 'EscalationAdvanced' && event.data.to_level === 'architect')).toBe(false);
    expect(events.some((event) => event.type === 'WorkItemParked' && event.data.reason === 'awaiting-human')).toBe(false);
    await log.close();
  });

  it('resolves an item-scoped integration cause after Planner remediation and resumes the pipeline', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-intrec');
    const counter = join(storeDir, 'oracle-counter');
    const command = `node -e ${JSON.stringify(`const fs=require('fs');const p=${JSON.stringify(counter)};const n=Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0);fs.writeFileSync(p,String(n+1));process.exit(n===1?1:0)` )}`;
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-intrecover',
      executors: makeStubRegistry(happyPathScripts(), 'loop-intrecover-exec'),
      // Invocation 1 is the first task sweep (pass), 2 is integration (fail), 3 is the
      // regenerated task sweep (pass), and 4 is the resumed integration sweep (pass).
      config: makeConfig({ oracles: { build: command, typecheck: null, lint: null, test: null } }),
    });

    const result = await runItem(deps);
    const events = await log.readAll();
    const integrationFailure = events.find((event) => event.type === 'FailureCauseOpened' && event.data.kind === 'integration');
    const resolved = events.find((event) => event.type === 'FailureCauseResolved' && event.data.task_id === null);

    expect(result.outcome).toBe('completed');
    expect(integrationFailure).toBeDefined();
    expect(resolved).toBeDefined();
    expect(events.some((event) => event.type === 'FailureAttempted' && event.data.level === 'planner')).toBe(true);
    expect(events.filter((event) => event.type === 'OracleSweepStarted' && event.data.scope === 'integration')).toHaveLength(2);
    expect(events.some((event) => event.type === 'WorkItemParked' && event.data.reason === 'awaiting-human')).toBe(false);
    await log.close();
  });

  it('walks every automatic rung then parks at human before the loop guard', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-ladder');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-ladder',
      executors: makeStubRegistry(happyPathScripts(), 'loop-ladder-exec'),
      config: makeConfig({ failBuildOracle: true, oneAttemptPerRung: true }),
    });

    const result = await runItem(deps);
    const events = await log.readAll();
    const attempts = events.filter((event) => event.type === 'FailureAttempted');
    expect(events.filter((event) => event.type === 'FailureAttempted' || event.type === 'EscalationAdvanced' || event.type === 'WorkItemParked').map((event) => event.type === 'WorkItemParked' ? `${event.type}:${event.data.reason}` : event.type === 'FailureAttempted' ? `${event.type}:${event.data.level}` : `${event.type}:${event.data.to_level}`)).toEqual([
      // Successful upstream artifacts resolve their causes. A repeated oracle failure opens
      // a child cause at the next rank, so no successful handler is replayed before Human.
      'FailureAttempted:coder', 'EscalationAdvanced:reviewer', 'FailureAttempted:reviewer', 'EscalationAdvanced:planner', 'FailureAttempted:planner', 'FailureAttempted:architect', 'FailureAttempted:analyst', 'WorkItemParked:awaiting-human',
    ]);
    expect(result.outcome).toBe('parked');
    expect(result.finalState.park?.reason).toBe('awaiting-human');
    expect(events.some((event) => event.type === 'WorkItemFailed' && event.data.reason === 'loop-guard')).toBe(false);
    expect(attempts.map((event) => event.type === 'FailureAttempted' ? event.data.level : null)).toEqual([
      'coder', 'reviewer', 'planner', 'architect', 'analyst',
    ]);
    expect(events.filter((event) => event.type === 'EscalationAdvanced').map((event) =>
      event.type === 'EscalationAdvanced' ? event.data.to_level : null,
    )).toEqual(['reviewer', 'planner']);
    expect(events.length).toBeLessThan(MAX_LOOP_ITERATIONS);
    await log.close();
  });
});

describe('runItem: sandbox enforcement', () => {
  it('a read-only stage that writes an ignored file yields StageFailed{sandbox-violation}', async () => {
    await writeFile(join(targetRepo, '.gitignore'), '*.ignored\n');
    await git(targetRepo, ['add', '.gitignore']);
    await git(targetRepo, ['commit', '-m', 'ignore scratch files']);
    const itemId = WorkItemIdSchema.parse('wi-example-sandbi');
    const scripts = happyPathScripts();
    scripts.architect = completedStep(ARCHITECTURE_PLAN, { 'nested/leaked.ignored': 'must be detected\n' });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-sandbox-ignored',
      executors: makeStubRegistry(scripts, 'loop-sandbox-ignored-exec'),
      config: makeConfig({ oneAttemptPerRung: true }),
    });

    try {
      await runItem(deps);
      const events = await log.readAll();
      expect(events.some((event) => event.type === 'StageFailed' && event.data.stage === 'architecture' && event.data.reason === 'sandbox-violation')).toBe(true);
      expect(events.some((event) => event.type === 'DiffCaptured' && event.data.untracked.includes('nested/leaked.ignored'))).toBe(true);
    } finally {
      await log.close();
    }
  });

  it('a read-only stage that writes a new file yields StageFailed{sandbox-violation}', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-sandb1');
    const scripts = happyPathScripts();
    scripts.architect = completedStep(ARCHITECTURE_PLAN, { 'leaked.txt': 'should not be here\n' });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-sandbox',
      executors: makeStubRegistry(scripts, 'loop-sandbox-exec'),
      config: makeConfig(),
    });

    // A sandbox violation is a stage failure like any other: it is recorded and the item
    // retries the stage (bounded by maxAttemptsPerStage) rather than parking outright. This
    // asserts the mechanism item 39 owns — that the violation is recorded correctly — not the
    // overall run outcome, which depends on whether a later attempt still shows the same diff.
    await runItem(deps);
    const events = await log.readAll();
    const failure = events.find(
      (e) => e.type === 'StageFailed' && e.data.reason === 'sandbox-violation',
    );
    expect(failure).toBeDefined();
    if (failure?.type === 'StageFailed') {
      expect(failure.data.stage).toBe('architecture');
    }
    expect(events.some((event) => event.type === 'FailureCauseOpened' && event.data.kind === 'sandbox' && event.data.initial_level === 'planner')).toBe(true);
    expect(events.some((event) => event.type === 'FailureAttempted' && event.data.level === 'planner')).toBe(true);

    await log.close();
  });

  it('routes validation failure through an agent-output cause instead of legacy attempt parking', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-agout1');
    const scripts = happyPathScripts();
    scripts.architect = {
      steps: [{ status: 'completed', telemetry: telemetry(), finalMessage: 'not valid JSON' }],
    };
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-agentout',
      executors: makeStubRegistry(scripts, 'loop-agentout-exec'),
      config: makeConfig({ oneAttemptPerRung: true }),
    });

    await runItem(deps);
    const events = await log.readAll();
    const failure = events.find((event) => event.type === 'StageFailed' && event.data.reason === 'validation-failed');
    expect(failure).toBeDefined();
    expect(events.some((event) => event.type === 'FailureCauseOpened' && event.data.kind === 'agent-output' && event.data.initial_level === 'reviewer')).toBe(true);
    expect(events.some((event) => event.type === 'FailureAttempted' && event.data.level === 'reviewer')).toBe(true);
    await log.close();
  });

  it('a read-only stage that REWRITES an existing untracked file is detected', async () => {
    // Regression: the check compared `diffSha256` (tracked files only) plus the untracked
    // NAME list, so rewriting an existing untracked file changed neither and went undetected.
    // Untracked is exactly what the Test Author creates, so a read-only Reviewer could have
    // rewritten a frozen test invisibly. `untrackedSha256` covers untracked BYTES.
    const itemId = WorkItemIdSchema.parse('wi-example-sandb2');
    const scripts = happyPathScripts();
    // testAuthor legitimately creates test/a.test.ts (untracked). The reviewer is read-only
    // and rewrites that same path — no new file, no tracked change.
    scripts.reviewer = completedStep(REVIEW_VERDICT, { 'test/a.test.ts': 'REWRITTEN\n' });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-sandbox2',
      executors: makeStubRegistry(scripts, 'loop-sandbox2-exec'),
      // This regression only needs the first Reviewer invocation.  One attempt per
      // escalation rung avoids spending the test timeout replaying unrelated recovery
      // paths after that durable sandbox failure when the suite is running concurrently.
      config: makeConfig({ oneAttemptPerRung: true }),
      retainWorkspace: true,
    });

    try {
      await runItem(deps);
      const events = await log.readAll();
      const failure = events.find(
        (e) => e.type === 'StageFailed' && e.data.reason === 'sandbox-violation' && e.data.stage === 'review',
      );
      expect(failure).toBeDefined();
      const prepared = events.find((e) => e.type === 'WorkspacePrepared');
      expect(prepared).toBeDefined();
      if (prepared?.type === 'WorkspacePrepared') {
        expect(await readFile(join(prepared.data.workdir, 'test/a.test.ts'), 'utf8')).toBe('test body A\n');
      }
    } finally {
      await log.close();
    }
  });

  it('a violating attempt does not leave its write as the baseline for the retry', async () => {
    // Regression: `DiffCaptured` was appended before the violation check and the write was
    // never reverted, so attempt 2 compared against the polluted baseline, saw no delta, and
    // proceeded — the control was bypassable in exactly one retry. Every attempt at the
    // violating stage must now fail, because the write is reverted each time.
    const itemId = WorkItemIdSchema.parse('wi-example-sandb3');
    const scripts = happyPathScripts();
    scripts.architect = completedStep(ARCHITECTURE_PLAN, { 'leaked.txt': 'should not be here\n' });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-sandbox3',
      executors: makeStubRegistry(scripts, 'loop-sandbox3-exec'),
      config: makeConfig(),
    });

    await runItem(deps);
    const events = await log.readAll();
    const violations = events.filter(
      (e) => e.type === 'StageFailed' && e.data.reason === 'sandbox-violation' && e.data.stage === 'architecture',
    );
    // Every attempt the stage was granted violated; none was silently let through.
    const architectureAttempts = events.filter(
      (e) => e.type === 'StageEntered' && e.data.stage === 'architecture',
    );
    expect(violations.length).toBe(architectureAttempts.length);
    expect(violations.length).toBeGreaterThan(0);

    await log.close();
  });
});

describe('runItem: the Reviewer receives a real diff', () => {
  it("the reviewer's assembled pack carries a diff section containing the Coder's changes", async () => {
    // Regression: `buildRawPackMaterials` returned `diff: null` unconditionally, so the
    // reviewer's pack never carried a diff section — while its prompt told the model "you
    // read the diff the Coder produced". `unrequested-scope` detection ran on no input.
    const itemId = WorkItemIdSchema.parse('wi-example-revdif');
    const scripts = happyPathScripts();
    // The Coder writes a file whose content we can look for in the reviewer's prompt.
    scripts.coder = completedStep(IMPLEMENTATION, { 'README.md': 'CODER-WROTE-THIS\n' });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-revdiff',
      executors: makeStubRegistry(scripts, 'loop-revdiff-exec'),
      config: makeConfig(),
    });

    await runItem(deps);
    const events = await log.readAll();

    const reviewInvoked = events.find(
      (e) => e.type === 'ExecutorInvoked' && e.data.stage === 'review',
    );
    expect(reviewInvoked).toBeDefined();
    if (reviewInvoked?.type !== 'ExecutorInvoked') {
      await log.close();
      return;
    }
    // The prompt is recoverable from the log (criterion 6); read it and prove the diff is in it.
    const promptPath = reviewInvoked.data.prompt_path;
    expect(promptPath).not.toBeNull();
    const prompt = await readFile(promptPath as string, 'utf8');
    expect(prompt).toContain('CODER-WROTE-THIS');

    await log.close();
  });
});

describe('runItem: worktree lock reclaim', () => {
  it('a pre-existing worktreeLock at loop entry is reclaimed and the run proceeds', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-reclm1');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-reclaim',
      executors: makeStubRegistry(happyPathScripts(), 'loop-reclaim-exec'),
      config: makeConfig(),
    });

    // Drive it to the point the workspace exists, then simulate a stale lock left by a
    // process that died mid-invocation: append the acquire without its release.
    await log.append({
      type: 'StageEntered',
      data: { stage: 'intake', attempt: 1 },
      actor: { kind: 'supervisor', id: null },
      causationId: log.lastEventId,
    });
    await log.append({
      type: 'StageCompleted',
      data: { stage: 'intake', attempt: 1, artifact: null },
      actor: { kind: 'supervisor', id: null },
      causationId: log.lastEventId,
    });
    await log.append({
      type: 'StageEntered',
      data: { stage: 'analysis', attempt: 1 },
      actor: { kind: 'supervisor', id: null },
      causationId: log.lastEventId,
    });
    await log.append({
      type: 'WorkspacePrepared',
      data: {
        mode: 'worktree',
        target_repo: targetRepo,
        workdir: join(deps.workspacesDir, 'workspace'),
        base_ref: 'HEAD',
        base_commit: (await git(targetRepo, ['rev-parse', 'HEAD'])).trim(),
      },
      actor: { kind: 'supervisor', id: null },
      causationId: log.lastEventId,
    });
    // Actually create the worktree on disk so the real workspace provider can use it later.
    await git(targetRepo, [
      'worktree',
      'add',
      '--detach',
      join(deps.workspacesDir, 'workspace'),
      (await git(targetRepo, ['rev-parse', 'HEAD'])).trim(),
    ]);
    await log.append({
      type: 'WorktreeLockAcquired',
      data: {
        workdir: join(deps.workspacesDir, 'workspace'),
        holder: ExecutorInstanceIdSchema.parse('stub-analyst'),
        stage: 'analysis',
        intent: 'read-only',
      },
      actor: { kind: 'supervisor', id: null },
      causationId: log.lastEventId,
    });

    const result = await runItem(deps);

    expect(result.outcome).toBe('completed');
    const events = await log.readAll();
    const reclaimed = events.find(
      (e) => e.type === 'WorktreeLockReleased' && e.data.reclaimed === true,
    );
    expect(reclaimed).toBeDefined();

    await log.close();
  });
});

class QuotaExecutor implements Executor, RawRunSource {
  readonly id = ExecutorInstanceIdSchema.parse('stub-analyst');
  readonly type = 'stub' as const;
  readonly account = ACCOUNT;
  readonly capabilities = { nativeStructuredOutput: false, resumableSessions: false, sandboxModes: ['read-only', 'workspace-write'] as const };
  lastRun: RawRunRecord | null = null;

  constructor(private readonly clock: ReturnType<typeof fixedClock>) {}

  async run(): Promise<ExecutorResult> {
    const now = this.clock.now();
    this.lastRun = {
      commandLine: [],
      exitCode: 1,
      signal: null,
      killed: 'none',
      startedAt: now,
      finishedAt: now,
      observedTurns: null,
      failureKind: 'quota',
      stderrTail: 'quota exceeded',
      sessionId: null,
      transcriptPath: null,
      rawResult: null,
      finalMessage: null,
      quota: null,
    };
    return {
      status: 'quota_exhausted',
      telemetry: { turns: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, wallSeconds: 1 },
    };
  }
}

class CausalOutcomeCoder implements Executor, RawRunSource {
  readonly id = ExecutorInstanceIdSchema.parse('stub-coder');
  readonly type = 'stub' as const;
  readonly account = ACCOUNT;
  readonly capabilities = { nativeStructuredOutput: false, resumableSessions: false, sandboxModes: ['read-only', 'workspace-write'] as const };
  lastRun: RawRunRecord | null = null;
  private readonly delegate: StubExecutor;
  private callCount = 0;

  constructor(
    private readonly outcome: 'quota' | 'auth' | 'abort',
    private readonly abortController: AbortController,
  ) {
    this.delegate = new StubExecutor({
      id: this.id,
      account: this.account,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng(`causal-${outcome}`)),
      script: {
        steps: [
          { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(IMPLEMENTATION) },
          { status: outcome === 'quota' ? 'quota_exhausted' : 'crashed', telemetry: telemetry() },
        ],
      },
    });
  }

  async run(input: ExecutorInput): Promise<ExecutorResult> {
    this.callCount += 1;
    const result = await this.delegate.run(input);
    const raw = this.delegate.lastRun;
    if (raw === null) throw new Error('stub did not provide a raw run record');
    if (this.callCount === 2) {
      if (this.outcome === 'abort') this.abortController.abort();
      this.lastRun = { ...raw, failureKind: this.outcome === 'quota' ? 'quota' : this.outcome === 'auth' ? 'auth' : null };
    } else {
      this.lastRun = raw;
    }
    return result;
  }
}

function registryWithCausalOutcome(
  outcome: 'quota' | 'auth' | 'abort',
  abortController: AbortController,
): ExecutorRegistry {
  const registry = makeStubRegistry(happyPathScripts(), `causal-${outcome}`);
  const coder = new CausalOutcomeCoder(outcome, abortController);
  const overridden: ExecutorHandle = { role: 'coder', executor: coder, sandboxIntent: 'workspace-write', resolved: RESOLVED };
  return {
    forRole(role: Role): ExecutorHandle {
      return role === 'coder' ? overridden : registry.forRole(role);
    },
    accountForRole: registry.accountForRole,
    handles: registry.handles,
  };
}

function registryWithQuotaExecutor(): ExecutorRegistry {
  const registry = makeStubRegistry(happyPathScripts(), 'loop-quota-exec');
  const quota = new QuotaExecutor(fixedClock(START));
  const overridden: ExecutorHandle = { role: 'analyst', executor: quota, sandboxIntent: 'read-only', resolved: RESOLVED };
  return {
    forRole(role: Role): ExecutorHandle {
      return role === 'analyst' ? overridden : registry.forRole(role);
    },
    accountForRole: registry.accountForRole,
    handles: registry.handles,
  };
}

describe('runItem: provider-quota failureKind', () => {
  it('appends BudgetExhausted{provider-quota} then WorkItemParked, with no StageFailed for the stage, and attempts unburned', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-quota1');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-quota',
      executors: registryWithQuotaExecutor(),
      config: makeConfig(),
    });

    const result = await runItem(deps);

    expect(result.outcome).toBe('parked');
    expect(result.finalState.park?.reason).toBe('provider-quota');
    expect(result.finalState.park?.account).toBe(ACCOUNT);

    const events = await log.readAll();
    const budgetExhaustedIndex = events.findIndex(
      (e) => e.type === 'BudgetExhausted' && e.data.limit_kind === 'provider-quota',
    );
    const parkedIndex = events.findIndex((e) => e.type === 'WorkItemParked');
    expect(budgetExhaustedIndex).toBeGreaterThanOrEqual(0);
    expect(parkedIndex).toBeGreaterThan(budgetExhaustedIndex);

    const analysisFailures = events.filter(
      (e) => e.type === 'StageFailed' && e.data.stage === 'analysis',
    );
    expect(analysisFailures).toHaveLength(0);

    // `analysis` is entered once (attempt 1), the sole `StageEntered` for the stage, which is
    // where the quota wall is actually discovered. `quotaAborts` absorbs exactly that entry, so
    // `effectiveAttempts` lands back at 0 — proving the quota abort burned nothing at all.
    expect(result.finalState.attempts.analysis).toBe(1);
    expect(result.finalState.quotaAborts.analysis).toBe(1);
    expect(result.finalState.attempts.analysis - result.finalState.quotaAborts.analysis).toBe(0);

    await log.close();
  });
});

describe('runItem: unavailable causal remediation', () => {
  it.each([
    ['quota', 'parked'],
    ['auth', 'parked'],
    ['abort', 'aborted'],
  ] as const)('does not burn the active cause when the handler returns %s', async (outcome, expectedOutcome) => {
    const itemId = WorkItemIdSchema.parse(`wi-causal-${outcome === 'auth' ? 'authxx' : `${outcome}1`}`);
    const abortController = new AbortController();
    const { deps, log } = await makeDeps({
      itemId,
      seed: `causal-${outcome}`,
      executors: registryWithCausalOutcome(outcome, abortController),
      config: makeConfig({ failBuildOracle: true }),
    });
    const result = await runItem({ ...deps, signal: abortController.signal });
    const events = await log.readAll();
    const cause = events.find((event) => event.type === 'FailureCauseOpened' && event.data.kind === 'oracle');

    expect(cause).toBeDefined();
    expect(result.outcome).toBe(expectedOutcome);
    expect(events.filter((event) => event.type === 'FailureAttempted')).toHaveLength(0);
    if (cause?.type === 'FailureCauseOpened') {
      expect(result.finalState.causes[cause.event_id]?.attempts.oracle).toBe(0);
    }
    if (outcome === 'auth') expect(result.finalState.park?.reason).toBe('executor-unavailable');
    await log.close();
  });
});

describe('runItem: account budget exhaustion', () => {
  // An account-scoped LEDGER overrun is a budget exhaustion, not a provider window. Guard 7
  // of nextStage used to report every account exhaustion as 'provider-quota' regardless of
  // limitKind, which told the operator to wait for a window that was never the problem and
  // inverted §17.3's park-and-resume vs. escalate distinction — a declared spend/time cap
  // does not clear on its own. The account is still named, because the operator needs to know
  // WHICH pool hit its cap.
  it('an account whose wall-time ledger exceeds its declared limit parks with reason "budget-exhausted", naming the account', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-wall01');
    const script: StubScript = {
      steps: [
        {
          status: 'completed',
          telemetry: { turns: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, wallSeconds: 9999 },
          finalMessage: JSON.stringify(REQUIREMENT_SET),
        },
      ],
    };
    const scripts = happyPathScripts();
    scripts.analyst = script;
    const config = MienguConfigSchema.parse({
      target: { repo: targetRepo },
      accounts: { 'stub-account': { maxWallSecondsPerItem: 10 } },
      executors: {
        'stub-analyst': { type: 'stub', account: 'stub-account' },
        'stub-architect': { type: 'stub', account: 'stub-account' },
        'stub-planner': { type: 'stub', account: 'stub-account' },
        'stub-testauthor': { type: 'stub', account: 'stub-account' },
        'stub-coder': { type: 'stub', account: 'stub-account' },
        'stub-reviewer': { type: 'stub', account: 'stub-account' },
      },
      tiers: {
        'stub-analyst': 1,
        'stub-architect': 1,
        'stub-planner': 1,
        'stub-testauthor': 1,
        'stub-coder': 1,
        'stub-reviewer': 1,
      },
      roles: {
        analyst: { executor: 'stub-analyst', maxTurns: 8, contextBudgetTokens: 40000 },
        architect: { executor: 'stub-architect', maxTurns: 8, contextBudgetTokens: 40000 },
        planner: { executor: 'stub-planner', maxTurns: 8, contextBudgetTokens: 40000 },
        testAuthor: { executor: 'stub-testauthor', maxTurns: 8, contextBudgetTokens: 40000 },
        coder: { executor: 'stub-coder', maxTurns: 8, contextBudgetTokens: 40000 },
        reviewer: { executor: 'stub-reviewer', maxTurns: 8, contextBudgetTokens: 40000 },
      },
    });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-wall',
      executors: makeStubRegistry(scripts, 'loop-wall-exec'),
      config,
    });

    const result = await runItem(deps);

    expect(result.outcome).toBe('parked');
    expect(result.finalState.status).toBe('parked');
    expect(result.finalState.park?.reason).toBe('budget-exhausted');
    expect(result.finalState.park?.account).toBe(ACCOUNT);
    expect(result.finalState.park?.detail).toContain('limitKind=wall');

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toContain('BudgetExhausted');
    expect(events.at(-1)?.type).toBe('WorkspaceDiscarded');
    expect(events.some((e) => e.type === 'WorkItemParked')).toBe(true);

    await log.close();
  });
});

describe('runItem: resume after a workspace was prepared and discarded', () => {
  it('re-prepares a fresh workspace on resume instead of reusing the discarded one, and completes', async () => {
    const itemId = WorkItemIdSchema.parse('wi-resume-fresh1');
    const script: StubScript = {
      steps: [
        {
          status: 'completed',
          telemetry: { turns: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, wallSeconds: 9999 },
          finalMessage: JSON.stringify(REQUIREMENT_SET),
        },
      ],
    };
    const scripts = happyPathScripts();
    scripts.analyst = script;
    const baseConfig = makeConfig();
    const lowLimitConfig = MienguConfigSchema.parse({
      ...baseConfig,
      accounts: { 'stub-account': { maxWallSecondsPerItem: 10 } },
    });

    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-resume',
      executors: makeStubRegistry(scripts, 'loop-resume-exec'),
      config: lowLimitConfig,
    });

    const first = await runItem(deps);
    expect(first.outcome).toBe('parked');
    expect(first.finalState.park?.reason).toBe('budget-exhausted');

    const eventsAfterPark = await log.readAll();
    expect(eventsAfterPark.filter((e) => e.type === 'WorkspacePrepared')).toHaveLength(1);
    expect(eventsAfterPark.at(-1)?.type).toBe('WorkspaceDiscarded');

    // Resuming raises the account's wall-time cap, exactly as an operator clearing a
    // budget-exhausted park would; the ledger itself (already over the OLD cap) never resets.
    await log.append({
      type: 'WorkItemResumed',
      data: { previous_reason: 'budget-exhausted', detail: 'operator raised the account limit', account: ACCOUNT },
      actor: { kind: 'human', id: null },
      causationId: log.lastEventId,
    });
    const highLimitConfig = MienguConfigSchema.parse({
      ...baseConfig,
      accounts: { 'stub-account': { maxWallSecondsPerItem: 1_000_000 } },
    });
    const resumedDeps: RunItemDeps = { ...deps, config: highLimitConfig, policy: policyFromConfig(highLimitConfig) };

    const second = await runItem(resumedDeps);
    expect(second.outcome).toBe('completed');

    const finalEvents = await log.readAll();
    expect(finalEvents.filter((e) => e.type === 'WorkspacePrepared')).toHaveLength(2);

    await log.close();
  });
});

describe('runItem: determinism', () => {
  it('two identical runs with the same fixedClock/fixedRng produce byte-identical events.jsonl', async () => {
    async function runOnce(itemId: ReturnType<typeof WorkItemIdSchema.parse>): Promise<Buffer> {
      const { deps, log } = await makeDeps({
        itemId,
        seed: 'loop-determinism',
        executors: makeStubRegistry(happyPathScripts(), 'loop-determinism-exec'),
        config: makeConfig(),
      });
      await runItem(deps);
      await log.close();
      return readFile(itemPaths(storeDir, itemId).eventsFile);
    }

    const itemId = WorkItemIdSchema.parse('wi-example-detrm1');
    const first = await runOnce(itemId);
    // Keep storeDir and itemId identical across both runs — every path embedded in an event
    // (workdir, target_repo, ...) is a literal string, so a genuine byte-for-byte comparison
    // requires those strings to be identical, not merely the logical event content. Remove the
    // item directory (including its discarded worktree) so the second run starts from the same
    // on-disk state the first run did.
    await rm(itemPaths(storeDir, itemId).itemDir, { recursive: true, force: true });
    const second = await runOnce(itemId);

    expect(second.equals(first)).toBe(true);
  });
});

describe('runItem: blast-radius classification (Phase 5)', () => {
  it('a blocking blast-radius trigger raises exactly one checkpoint whose causation_id is the invocation\'s DiffCaptured event id, and the item parks', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-blast1');
    const scripts = happyPathScripts();
    scripts.coder = completedStep(IMPLEMENTATION, { 'src/sensitive-file.ts': 'touches a sensitive surface\n' });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-blast-blocking',
      executors: makeStubRegistry(scripts, 'loop-blast-blocking-exec'),
      config: makeConfig({ checkpoints: { blastRadius: { sensitivePaths: ['src/sensitive-file.ts'] } } }),
    });

    const result = await runItem(deps);
    const events = await log.readAll();

    expect(result.outcome).toBe('parked');
    expect(result.finalState.park?.reason).toBe('awaiting-human');

    const raised = events.filter((e) => e.type === 'CheckpointRaised' && e.data.kind === 'blast-radius');
    expect(raised).toHaveLength(1);
    const checkpointEvent = raised[0];
    expect(checkpointEvent?.data).toMatchObject({ blocking: true });

    const diffCaptured = events.filter((e) => e.type === 'DiffCaptured');
    // The coder stage's own DiffCaptured is the one carrying the new sensitive path.
    const coderDiff = diffCaptured.find((e) => e.data.untracked.includes('src/sensitive-file.ts'));
    expect(coderDiff).toBeDefined();
    expect(checkpointEvent?.causation_id).toBe(coderDiff?.event_id ?? null);

    await log.close();
  });

  it('a stage failure never classifies: no blast-radius checkpoint appears', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-blast2');
    const scripts = happyPathScripts();
    scripts.architect = completedStep(ARCHITECTURE_PLAN, { 'leaked.txt': 'should not be here\n' });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-blast-failure',
      executors: makeStubRegistry(scripts, 'loop-blast-failure-exec'),
      config: makeConfig({
        oneAttemptPerRung: true,
        checkpoints: { blastRadius: { sensitivePaths: ['leaked.txt'] } },
      }),
    });

    await runItem(deps);
    const events = await log.readAll();
    expect(events.some((e) => e.type === 'StageFailed' && e.data.reason === 'sandbox-violation')).toBe(true);
    expect(events.some((e) => e.type === 'CheckpointRaised' && e.data.kind === 'blast-radius')).toBe(false);

    await log.close();
  });

  it('a non-blocking trigger auto-approves after its declared SLA, never a CheckpointDecided, and a later cumulative diff raises no second checkpoint', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-blast3');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-blast-sla',
      executors: makeStubRegistry(happyPathScripts(), 'loop-blast-sla-exec'),
      config: makeConfig({
        checkpoints: {
          reversible: { slaSeconds: 1, default: 'accept' },
          blastRadius: { maxFilesTouched: 1 },
        },
      }),
    });

    const result = await runItem(deps);
    const events = await log.readAll();

    expect(result.outcome).toBe('completed');
    const raised = events.filter((e) => e.type === 'CheckpointRaised' && e.data.kind === 'blast-radius');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.data).toMatchObject({ blocking: false });

    const autoApproved = events.filter((e) => e.type === 'AutoApproved');
    expect(autoApproved).toHaveLength(1);
    expect(autoApproved[0]?.data).toMatchObject({ checkpoint: raised[0]?.data.checkpoint, after: '1s', no_human_response: true });

    // The audit trail never implies a human looked at something they did not.
    expect(events.some((e) => e.type === 'CheckpointDecided')).toBe(false);

    // The sweep runs before nextStage, so the AutoApproved is durable before whatever
    // StageEntered the loop dispatches next.
    const raisedIndex = events.findIndex((e) => e === raised[0]);
    const autoApprovedIndex = events.findIndex((e) => e === autoApproved[0]);
    const nextStageEnteredIndex = events.findIndex((e, i) => i > autoApprovedIndex && e.type === 'StageEntered');
    expect(autoApprovedIndex).toBeGreaterThan(raisedIndex);
    expect(nextStageEnteredIndex).toBeGreaterThan(autoApprovedIndex);

    await log.close();
  });

  it('a blocking checkpoint never auto-approves however far the clock is advanced', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-blast4');
    const scripts = happyPathScripts();
    scripts.coder = completedStep(IMPLEMENTATION, { 'src/sensitive-file.ts': 'touches a sensitive surface\n' });
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-blast-noauto',
      executors: makeStubRegistry(scripts, 'loop-blast-noauto-exec'),
      config: makeConfig({ checkpoints: { blastRadius: { sensitivePaths: ['src/sensitive-file.ts'] } } }),
    });

    const first = await runItem(deps);
    expect(first.outcome).toBe('parked');

    // Advance the clock far beyond any plausible SLA, then let the loop run again: an
    // irreversible/blocking checkpoint carries no SLA (binding decision 7), so it is never a
    // `slaCandidates` member and can never auto-approve, however far the clock moves.
    for (let i = 0; i < 100; i += 1) {
      deps.clock.now();
    }
    const second = await runItem(deps);
    expect(second.outcome).toBe('parked');

    const events = await log.readAll();
    expect(events.some((e) => e.type === 'AutoApproved')).toBe(false);

    await log.close();
  });
});

describe('MAX_LOOP_ITERATIONS', () => {
  it('is exported and equals 1000', () => {
    expect(MAX_LOOP_ITERATIONS).toBe(1000);
  });
});
