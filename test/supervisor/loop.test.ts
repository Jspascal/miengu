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

function makeConfig(overrides: { maxWallSecondsPerInvocation?: number; snapshotEvery?: number } = {}) {
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
    store: { snapshotEvery: overrides.snapshotEvery ?? 200 },
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
    retainWorkspace: false,
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
    // intake: supervisor-only, entered once (attempt 1) since it is the very first stage.
    // `StageCompleted` itself advances `state.stage` to `analysis` (projector); no second,
    // redundant `StageEntered` is appended to record that advance.
    'StageEntered',
    'StageCompleted',
    // every agent stage is entered exactly once (attempt 1): the `StageEntered` that follows
    // is the sole "an attempt is starting" event, appended by `performRunAttempt` itself.
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
    'StageEntered',
    'WorktreeLockAcquired',
    'ExecutorInvoked',
    'ExecutorReturned',
    'TestsFrozen',
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
    // integration: supervisor-only again
    'StageEntered',
    'StageCompleted',
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
    const stageEnteredForIntegration = events.filter(
      (e) => e.type === 'StageEntered' && e.data.stage === 'integration',
    );
    expect(stageEnteredForIntake).toHaveLength(1);
    expect(stageEnteredForIntegration).toHaveLength(1);

    // No ExecutorInvoked/WorktreeLockAcquired/WorkspacePrepared bracket either supervisor stage.
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

describe('runItem: sandbox enforcement', () => {
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
      config: makeConfig(),
    });

    await runItem(deps);
    const events = await log.readAll();
    const failure = events.find(
      (e) => e.type === 'StageFailed' && e.data.reason === 'sandbox-violation' && e.data.stage === 'review',
    );
    expect(failure).toBeDefined();

    await log.close();
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
    expect(violations.length).toBeGreaterThan(1);

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

describe('MAX_LOOP_ITERATIONS', () => {
  it('is exported and equals 1000', () => {
    expect(MAX_LOOP_ITERATIONS).toBe(1000);
  });
});
