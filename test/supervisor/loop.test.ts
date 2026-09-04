import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EventLog, itemPaths } from '../../src/core/log.js';
import { RunIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { createSnapshotStore } from '../../src/core/snapshot.js';
import { WorkItemStateSchema } from '../../src/state/workitem.js';
import type { WorkItemState } from '../../src/state/workitem.js';
import { stateHash } from '../../src/state/stateHash.js';
import { MienguConfigSchema } from '../../src/config/schema.js';
import { StubExecutor } from '../../src/executors/stub.js';
import type { StubScript } from '../../src/executors/stub.js';
import { createWorkspaceProvider } from '../../src/executors/isolation.js';
import type {
  Executor,
  ExecutorRunResult,
  RawRunRecord,
  RawRunSource,
} from '../../src/executors/executor.js';
import { runItem, MAX_LOOP_ITERATIONS } from '../../src/supervisor/loop.js';
import type { RunItemDeps } from '../../src/supervisor/loop.js';
import type { StagePolicy } from '../../src/supervisor/nextStage.js';

const execFileAsync = promisify(execFile);
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

const POLICY: StagePolicy = {
  limits: { kOracle: 3, kTest: 3, kReview: 2, maxAttemptsPerStage: 3 },
};

const STAGE_SEQUENCE = [
  'intake',
  'analysis',
  'architecture',
  'planning',
  'test-authoring',
  'implementation',
  'review',
  'integration',
] as const;

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

function makeConfig(overrides: { maxWallSecondsPerTask?: number; snapshotEvery?: number } = {}) {
  return MienguConfigSchema.parse({
    target: { repo: targetRepo },
    executor: { id: 'stub' },
    budget: {
      maxWallSecondsPerTask: overrides.maxWallSecondsPerTask ?? 1800,
    },
    store: { snapshotEvery: overrides.snapshotEvery ?? 200 },
  });
}

async function makeDeps(o: {
  itemId: ReturnType<typeof WorkItemIdSchema.parse>;
  seed: string;
  executor: Executor & Partial<RawRunSource>;
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
    policy: POLICY,
    executor: o.executor,
    workspace: createWorkspaceProvider('worktree'),
    targetRepo,
    workspacesDir: paths.workspacesDir,
    clock,
    ids,
    logger: silentLogger,
    signal: new AbortController().signal,
    retainWorkspace: false,
  };
  return { deps, log };
}

function expectedHappyPathTypes(): string[] {
  const types: string[] = ['WorkItemCreated'];
  STAGE_SEQUENCE.forEach((_stage, idx) => {
    types.push('StageEntered');
    if (idx === 0) {
      types.push('WorkspacePrepared');
    }
    types.push('ExecutorInvoked', 'ExecutorReturned', 'DiffCaptured', 'BudgetConsumed');
    types.push('StageCompleted', 'StageEntered');
  });
  types.push('WorkItemCompleted', 'WorkspaceDiscarded');
  return types;
}

describe('runItem: happy path with StubExecutor', () => {
  it('reaches stage:"done", status:"completed" with the exact expected event-type sequence', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-happy1');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-happy',
      executor: new StubExecutor({ clock: fixedClock(START), ids: createIdMinter(fixedRng('loop-happy-exec')) }),
      config: makeConfig(),
    });

    const result = await runItem(deps);

    expect(result.outcome).toBe('completed');
    expect(result.finalState.status).toBe('completed');
    expect(result.finalState.stage).toBe('done');

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual(expectedHappyPathTypes());
    expect(events.map((e) => e.seq)).toEqual(events.map((_e, i) => i + 1));

    await log.close();
  });
});

describe('runItem: budget_wall parks the item', () => {
  it('parks with budget-exhausted after a scripted budget_wall status', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-wall01');
    const script: StubScript = {
      steps: [
        {
          status: 'budget_wall',
          telemetry: { turns: 1, inputTokens: null, outputTokens: null, wallSeconds: 9999 },
        },
      ],
    };
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-wall',
      executor: new StubExecutor({
        script,
        clock: fixedClock(START),
        ids: createIdMinter(fixedRng('loop-wall-exec')),
      }),
      config: makeConfig({ maxWallSecondsPerTask: 10 }),
    });

    const result = await runItem(deps);

    expect(result.outcome).toBe('parked');
    expect(result.finalState.status).toBe('parked');
    expect(result.finalState.park?.reason).toBe('budget-exhausted');

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toContain('BudgetExhausted');
    expect(events.map((e) => e.type)).toContain('StageFailed');
    expect(events.at(-1)?.type).toBe('WorkspaceDiscarded');
    expect(events.some((e) => e.type === 'WorkItemParked')).toBe(true);

    await log.close();
  });
});

class QuotaExecutor implements Executor, RawRunSource {
  readonly id = 'quota-fake';
  lastRun: RawRunRecord | null = null;

  constructor(private readonly clock: ReturnType<typeof fixedClock>) {}

  async run(): Promise<ExecutorRunResult> {
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
    };
    return {
      status: 'crashed',
      telemetry: { turns: null, inputTokens: null, outputTokens: null, wallSeconds: 1 },
    };
  }
}

describe('runItem: provider-quota failureKind', () => {
  it('appends BudgetExhausted{provider-quota} then WorkItemParked', async () => {
    const itemId = WorkItemIdSchema.parse('wi-example-quota1');
    const { deps, log } = await makeDeps({
      itemId,
      seed: 'loop-quota',
      executor: new QuotaExecutor(fixedClock(START)),
      config: makeConfig(),
    });

    const result = await runItem(deps);

    expect(result.outcome).toBe('parked');

    const events = await log.readAll();
    const budgetExhaustedIndex = events.findIndex(
      (e) => e.type === 'BudgetExhausted' && e.data.limit_kind === 'provider-quota',
    );
    const parkedIndex = events.findIndex((e) => e.type === 'WorkItemParked');
    expect(budgetExhaustedIndex).toBeGreaterThanOrEqual(0);
    expect(parkedIndex).toBeGreaterThan(budgetExhaustedIndex);

    await log.close();
  });
});

describe('runItem: determinism', () => {
  it('two identical runs with the same fixedClock/fixedRng produce byte-identical events.jsonl', async () => {
    async function runOnce(itemId: ReturnType<typeof WorkItemIdSchema.parse>): Promise<Buffer> {
      const { deps, log } = await makeDeps({
        itemId,
        seed: 'loop-determinism',
        executor: new StubExecutor({
          clock: fixedClock(START),
          ids: createIdMinter(fixedRng('loop-determinism-exec')),
        }),
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
