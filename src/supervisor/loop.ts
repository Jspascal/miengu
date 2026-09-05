import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNever } from '../core/events.js';
import type { Actor, RunOutcome, Stage } from '../core/events.js';
import type { Clock, IsoTimestamp } from '../core/clock.js';
import type { IdMinter } from '../core/idgen.js';
import { StoreError } from '../errors.js';
import type { MienguEvent } from '../core/events.js';
import type { EventLog, AppendInput } from '../core/log.js';
import type { SnapshotStore } from '../core/snapshot.js';
import type { Logger } from '../logging.js';
import type { MienguConfig } from '../config/schema.js';
import type { ExecutorRegistry } from '../executors/registry.js';
import type { PreparedWorkspace, WorkspaceProvider } from '../executors/isolation.js';
import { applyEvent, project } from '../state/projector.js';
import { stateHash } from '../state/stateHash.js';
import { roleForStage } from '../state/workitem.js';
import type { AssumptionRecord, FrozenTestsState, WorkItemState } from '../state/workitem.js';
import { accountLedger, checkLimits, fromTelemetry } from './budget.js';
import type { BudgetLimits } from './budget.js';
import { nextStage } from './nextStage.js';
import type { StagePolicy } from './nextStage.js';
import { runRoleStage, runSupervisorStage } from './stages.js';
import type { StageRunContext } from './stages.js';
import { dispatchedTask } from '../agents/checks.js';
import type { CheckContext } from '../agents/checks.js';
import type { AppendFn, PackBuildInput, RawPackMaterials } from '../agents/agent.js';
import type { ArchitecturePlan, RequirementSet, TaskGraph, TestSuiteSpec } from '../contracts/index.js';
import type { AccountId, ExecutorInstanceId } from '../core/ids.js';

export const MAX_LOOP_ITERATIONS = 1000;

const SUPERVISOR_ACTOR: Actor = { kind: 'supervisor', id: null };

export interface RunItemDeps {
  readonly log: EventLog;
  readonly snapshots: SnapshotStore<WorkItemState>;
  readonly config: MienguConfig;
  readonly policy: StagePolicy;
  readonly executors: ExecutorRegistry;
  readonly workspace: WorkspaceProvider;
  // Not part of the illustrative field list in the work order, but mechanically required:
  // WorkspaceProvider.prepare() needs an absolute directory to place the workspace under and
  // an absolute path to the target repo, and RunItemDeps otherwise carries no absolute paths
  // (only the un-resolved, config-file-relative `config.target.repo`). The caller that loaded
  // the config already resolved both (see `LoadedConfig`); it passes them straight through.
  readonly targetRepo: string;
  readonly workspacesDir: string;
  readonly promptsDir: string;
  readonly schemasDir: string;
  readonly messagesDir: string;
  readonly frozenTestsDir: string;
  readonly clock: Clock;
  readonly ids: IdMinter;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly retainWorkspace: boolean;
}

export interface RunItemResult {
  readonly outcome: RunOutcome;
  readonly finalState: WorkItemState;
}

const CANDIDATE_TEST_DIRS: readonly string[] = ['test/', 'tests/', 'spec/', '__tests__/'];

async function maybeSnapshot(
  deps: RunItemDeps,
  state: WorkItemState,
  force: boolean,
): Promise<void> {
  const seq = deps.log.lastSeq;
  const eventId = deps.log.lastEventId;
  if (eventId === null) {
    return;
  }
  const due = deps.config.store.snapshotEvery > 0 && seq % deps.config.store.snapshotEvery === 0;
  if (!force && !due) {
    return;
  }
  await deps.snapshots.write({
    projection_version: state.projectionVersion,
    item_id: state.itemId,
    seq,
    event_id: eventId,
    state_hash: stateHash(state),
    state,
  });
}

/** Appends one event, folds it into `state`, and returns both the new state and the real
 *  event timestamp — the shared primitive behind both `appendAndFold` (the loop's own
 *  events) and the `AppendFn` handed to `runRoleStage` (the agent's derived events). */
async function appendEvent(
  deps: RunItemDeps,
  state: WorkItemState,
  input: Omit<AppendInput, 'causationId'>,
): Promise<{ readonly state: WorkItemState; readonly ts: IsoTimestamp }> {
  const event = await deps.log.append({ ...input, causationId: deps.log.lastEventId });
  const next = applyEvent(state, event);
  await maybeSnapshot(deps, next, false);
  return { state: next, ts: event.ts };
}

async function appendAndFold(
  deps: RunItemDeps,
  state: WorkItemState,
  input: Omit<AppendInput, 'causationId'>,
): Promise<WorkItemState> {
  const { state: next } = await appendEvent(deps, state, input);
  return next;
}

async function finalize(
  deps: RunItemDeps,
  state: WorkItemState,
  outcome: RunOutcome,
): Promise<RunItemResult> {
  let finalState = state;
  if (finalState.workspace !== null && !finalState.workspace.discarded) {
    const ws: PreparedWorkspace = {
      mode: finalState.workspace.mode,
      targetRepo: finalState.workspace.targetRepo,
      workdir: finalState.workspace.workdir,
      baseRef: finalState.workspace.baseRef,
      baseCommit: finalState.workspace.baseCommit,
    };
    await deps.workspace.discard(ws, { retain: deps.retainWorkspace });
    finalState = await appendAndFold(deps, finalState, {
      type: 'WorkspaceDiscarded',
      data: { workdir: ws.workdir, retained: deps.retainWorkspace },
      actor: SUPERVISOR_ACTOR,
    });
  }
  await maybeSnapshot(deps, finalState, true);
  return { outcome, finalState };
}

/** An account with no declared limits (config.accounts is keyed by every account that
 *  appears; the lookup is defensive, never a mint). */
function accountLimitsFor(config: MienguConfig, account: AccountId): BudgetLimits {
  const declared = config.accounts[account];
  return {
    maxTurns: declared?.maxTurnsPerItem ?? null,
    maxWallSeconds: declared?.maxWallSecondsPerItem ?? null,
    maxUsd: declared?.maxUsdPerItem ?? null,
  };
}

/** Finds the body of the most recent `StageCompleted` artifact for `stage`, or `null` when
 *  none was ever recorded. Artifact bodies are not carried in `WorkItemState` (only the
 *  `sha256`/`eventId` ref is) — this is the one place that goes back to the log for them. */
function getArtifactBody<T>(events: readonly MienguEvent[], stage: Stage): T | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) {
      continue;
    }
    if (event.type === 'StageCompleted' && event.data.stage === stage && event.data.artifact !== null) {
      return event.data.artifact.body as T;
    }
  }
  return null;
}

function buildCheckContext(
  events: readonly MienguEvent[],
  config: MienguConfig,
  testDirs: readonly string[],
): CheckContext {
  return {
    requirementSet: getArtifactBody<RequirementSet>(events, 'analysis'),
    architecturePlan: getArtifactBody<ArchitecturePlan>(events, 'architecture'),
    taskGraph: getArtifactBody<TaskGraph>(events, 'planning'),
    maxPathsPerTask: config.planner.maxPathsPerTask,
    testDirs,
  };
}

/** Detected conventions: whichever of the common test directory names actually exist in the
 *  workspace, falling back to `['test/']` when none do. */
async function detectTestDirs(workdir: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const dir of CANDIDATE_TEST_DIRS) {
    try {
      await access(join(workdir, dir));
      found.push(dir);
    } catch {
      // not present; not a convention this workspace uses
    }
  }
  return found.length > 0 ? found : ['test/'];
}

async function readTextFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Assembles the raw pack materials this phase can actually fetch (§5's pack-source-kind
 *  fetchers are supervisor plumbing, per `agent.ts`'s own note). Everything it cannot yet
 *  source (wiki index, stack facts, file map, source files, diffs, oracle results, reviewer
 *  findings) is `null`/empty, which simply yields no section of that kind — never a
 *  fabricated one. The diff is the exception: it is captured before the stage runs and
 *  passed in, because the Reviewer cannot do its job without it. */
async function buildRawPackMaterials(o: {
  readonly workdir: string;
  readonly prdPath: string;
  readonly testDirs: readonly string[];
  readonly requirementSet: RequirementSet | null;
  readonly testSuiteSpec: TestSuiteSpec | null;
  readonly frozenTests: FrozenTestsState | null;
  readonly task: TaskGraph['tasks'][number] | null;
  readonly assumptions: readonly AssumptionRecord[];
  /** The working-tree diff as captured BEFORE this stage ran. The Reviewer's pack is built
   *  from it (§15.6 lists the diff first); every other role omits the kind, so passing it
   *  is harmless for them and `assemblePack` drops it. */
  readonly diff: string | null;
}): Promise<RawPackMaterials> {
  const prd = await readTextFileOrNull(o.prdPath);

  const frozenTestList =
    o.testSuiteSpec !== null
      ? o.testSuiteSpec.cases.map((c) => ({ testId: c.test_id, intent: c.intent }))
      : [];

  const frozenTestBodies: { path: string; body: string }[] = [];
  if (o.frozenTests !== null && o.testSuiteSpec !== null && o.task !== null) {
    const task = o.task;
    const relevantPaths = new Set(
      o.testSuiteSpec.cases
        .filter((c) => c.req_ids.some((r) => task.req_ids.includes(r)))
        .map((c) => c.path),
    );
    for (const file of o.frozenTests.files) {
      if (!relevantPaths.has(file.path)) {
        continue;
      }
      const body = await readTextFileOrNull(join(o.workdir, file.path));
      if (body !== null) {
        frozenTestBodies.push({ path: file.path, body });
      }
    }
  }

  return {
    prd,
    wikiIndex: null,
    existingReqIds: o.requirementSet?.requirements.map((r) => r.req_id) ?? [],
    priorOutOfScope: o.requirementSet?.out_of_scope ?? [],
    stackFacts: null,
    systemSkeleton: null,
    fileMap: null,
    testConventions: `Tests live under: ${o.testDirs.join(', ')}`,
    sourceFiles: [],
    frozenTestList,
    frozenTestBodies,
    diff: o.diff,
    oracleResults: null,
    reviewerFindings: null,
    assumptions: o.assumptions.map((a) => ({
      question: a.question,
      chosen: a.chosen,
      affects: a.affects,
    })),
  };
}

async function releaseLock(
  deps: RunItemDeps,
  state: WorkItemState,
  workdir: string,
  holder: ExecutorInstanceId,
  stage: Stage,
): Promise<WorkItemState> {
  return appendAndFold(deps, state, {
    type: 'WorktreeLockReleased',
    data: { workdir, holder, stage, reclaimed: false },
    actor: SUPERVISOR_ACTOR,
  });
}

/**
 * Executes one `run` decision to completion, per §3.23's fifteen normative steps:
 * `StageEntered` -> (supervisor-only stages complete immediately, no workspace/lock/executor)
 * -> ensure workspace -> reclaim a stale lock -> `WorktreeLockAcquired` -> `runRoleStage`
 * (which appends `ExecutorInvoked`/`ExecutorReturned`/`ArtifactValidationFailed` internally)
 * -> capture -> `DiffCaptured` -> sandbox enforcement -> `BudgetConsumed` -> `checkLimits`
 * (-> `BudgetExhausted` on violation, both account- and run-scoped) -> quota exhaustion (no
 * `StageFailed`/`StageCompleted`) -> executor-committed check -> derived events -> `StageCompleted`
 * or `StageFailed` -> on success, the projector advances `state.stage` via `nextStageInOrder`
 * from `StageCompleted` itself -> `WorktreeLockReleased` on every exit path. Appends only; the
 * caller re-reads and re-projects on the next outer-loop iteration.
 */
async function performRunAttempt(
  deps: RunItemDeps,
  initialState: WorkItemState,
  decision: { readonly stage: Stage; readonly attempt: number },
): Promise<void> {
  let state = await appendAndFold(deps, initialState, {
    type: 'StageEntered',
    data: { stage: decision.stage, attempt: decision.attempt },
    actor: SUPERVISOR_ACTOR,
  });

  const role = roleForStage(decision.stage);
  if (role === null) {
    const supervisorOutcome = runSupervisorStage(decision.stage);
    if (supervisorOutcome.kind !== 'completed') {
      throw new StoreError(
        `runSupervisorStage("${decision.stage}") returned a non-completed outcome, which it never should`,
      );
    }
    await appendAndFold(deps, state, {
      type: 'StageCompleted',
      data: { stage: decision.stage, attempt: decision.attempt, artifact: supervisorOutcome.artifact },
      actor: SUPERVISOR_ACTOR,
    });
    return;
  }

  if (state.workspace === null) {
    const prepared = await deps.workspace.prepare({
      itemId: deps.log.itemId,
      targetRepo: deps.targetRepo,
      baseRef: deps.config.target.baseRef,
      workspacesDir: deps.workspacesDir,
      name: 'workspace',
    });
    state = await appendAndFold(deps, state, {
      type: 'WorkspacePrepared',
      data: {
        mode: prepared.mode,
        target_repo: prepared.targetRepo,
        workdir: prepared.workdir,
        base_ref: prepared.baseRef,
        base_commit: prepared.baseCommit,
      },
      actor: SUPERVISOR_ACTOR,
    });
  }
  const workspaceInfo = state.workspace;
  if (workspaceInfo === null) {
    throw new StoreError('workspace preparation did not populate state.workspace');
  }

  if (state.worktreeLock !== null) {
    const staleLock = state.worktreeLock;
    deps.logger.warn(
      { workdir: staleLock.workdir, holder: staleLock.holder, stage: staleLock.stage },
      'reclaiming a worktree lock held at loop entry: the previous run holding it died',
    );
    state = await appendAndFold(deps, state, {
      type: 'WorktreeLockReleased',
      data: { workdir: staleLock.workdir, holder: staleLock.holder, stage: staleLock.stage, reclaimed: true },
      actor: SUPERVISOR_ACTOR,
    });
  }

  const handle = deps.executors.forRole(role);

  state = await appendAndFold(deps, state, {
    type: 'WorktreeLockAcquired',
    data: { workdir: workspaceInfo.workdir, holder: handle.executor.id, stage: decision.stage, intent: handle.sandboxIntent },
    actor: SUPERVISOR_ACTOR,
  });

  // Captured BEFORE the stage runs, and used for two things: it is the Reviewer's diff
  // material, and it is the sandbox baseline. Comparing after-vs-before per invocation is
  // what makes the read-only check honest — comparing against `state.lastDiff` let a
  // violating attempt record its own write as the baseline, so the next attempt saw no
  // delta and proceeded.
  const before = await deps.workspace.capture(workspaceInfo);

  const events = await deps.log.readAll();
  const testDirs = await detectTestDirs(workspaceInfo.workdir);
  const checkContext = buildCheckContext(events, deps.config, testDirs);
  const testSuiteSpec = getArtifactBody<TestSuiteSpec>(events, 'test-authoring');
  const task = checkContext.taskGraph !== null ? dispatchedTask(checkContext.taskGraph) : null;
  const raw = await buildRawPackMaterials({
    workdir: workspaceInfo.workdir,
    prdPath: state.source.path,
    testDirs,
    requirementSet: checkContext.requirementSet,
    testSuiteSpec,
    frozenTests: state.frozenTests,
    task,
    assumptions: state.assumptions,
    diff: before.diff.length > 0 ? before.diff : null,
  });
  const pack: PackBuildInput = { itemId: state.itemId, checkContext, task, raw };

  const append: AppendFn = async (input) => {
    const result = await appendEvent(deps, state, input);
    state = result.state;
    return { ts: result.ts };
  };

  const ctx: StageRunContext = {
    executor: handle.executor,
    executorType: handle.executor.type,
    account: handle.executor.account,
    itemId: state.itemId,
    slug: state.slug,
    workdir: workspaceInfo.workdir,
    budget: { maxTurns: handle.resolved.maxTurns, maxWallSeconds: deps.config.budget.maxWallSecondsPerInvocation },
    signal: deps.signal,
    sandboxIntent: handle.sandboxIntent,
    attempt: decision.attempt,
    resolved: handle.resolved,
    pack,
    checkContext,
    ids: deps.ids,
    frozenTestsDir: deps.frozenTestsDir,
    frozenTests: state.frozenTests,
    promptsDir: deps.promptsDir,
    schemasDir: deps.schemasDir,
    messagesDir: deps.messagesDir,
    append,
  };

  const outcome = await runRoleStage(decision.stage, ctx);

  // The workspace is prepared once and reused for every stage of the item, so `capture()`'s
  // diff/untracked lists are cumulative since the item's base commit, not scoped to this
  // invocation. Nothing in Phase 2 ever commits the workspace, so a file a workspace-write
  // stage (Test Author, Coder) wrote earlier stays "untracked" for the rest of the run — the
  // Reviewer's own read-only capture would otherwise always see it. Sandbox enforcement
  // therefore compares this capture against the one already on record from before this
  // invocation: a read-only stage violates only when it caused a NEW change, not when it
  // merely observes one an earlier stage already made.
  const capture = await deps.workspace.capture(workspaceInfo);
  state = await appendAndFold(deps, state, {
    type: 'DiffCaptured',
    data: {
      workdir: workspaceInfo.workdir,
      diff_sha256: capture.diffSha256,
      diff_ref: null,
      files_touched: capture.filesTouched,
      untracked: capture.untracked,
      insertions: capture.insertions,
      deletions: capture.deletions,
      committed_during_run: capture.committedDuringRun,
    },
    actor: SUPERVISOR_ACTOR,
  });

  // `untrackedSha256` covers untracked file BYTES, not just their names: rewriting an
  // existing untracked file (the category the Test Author creates, including a frozen test)
  // changes neither `diffSha256` nor the untracked name list.
  const changedThisInvocation =
    capture.diffSha256 !== before.diffSha256 ||
    capture.untrackedSha256 !== before.untrackedSha256 ||
    !sameStringSet(capture.untracked, before.untracked);
  const sandboxViolation = handle.sandboxIntent === 'read-only' && changedThisInvocation;
  if (sandboxViolation) {
    // Revert before recording the failure. Leaving the write on disk would make it the
    // baseline for the retry, which would then see no delta and proceed — the control has to
    // undo the violation, not just report it.
    const restored = await deps.workspace.restore(workspaceInfo, {
      keepUntracked: before.untracked,
      expectUntrackedSha256: before.untrackedSha256,
    });
    state = await appendAndFold(deps, state, {
      type: 'StageFailed',
      data: {
        stage: decision.stage,
        attempt: decision.attempt,
        reason: 'sandbox-violation',
        detail: restored.restoredFully
          ? 'a read-only stage modified the workspace; the change was reverted'
          : 'a read-only stage modified the workspace; tracked changes and new files were reverted, but an existing untracked file\'s contents could not be restored from git',
      },
      actor: SUPERVISOR_ACTOR,
    });
    await releaseLock(deps, state, workspaceInfo.workdir, handle.executor.id, decision.stage);
    return;
  }

  if (outcome.executorResult === null) {
    throw new StoreError(
      `runRoleStage("${decision.stage}") returned a null executorResult for a role stage, which it never should`,
    );
  }

  const account = handle.executor.account;
  const usd = extractUsd(handle.executor.lastRun?.rawResult ?? null);
  const delta = fromTelemetry(outcome.executorResult.telemetry, usd);
  state = await appendAndFold(deps, state, {
    type: 'BudgetConsumed',
    data: { scope: 'item', account, wall_seconds: delta.wallSeconds, turns: delta.turns, usd: delta.usd },
    actor: SUPERVISOR_ACTOR,
  });

  const accountVerdict = checkLimits(accountLedger(state.budget, account).consumed, accountLimitsFor(deps.config, account));
  if (!accountVerdict.ok) {
    state = await appendAndFold(deps, state, {
      type: 'BudgetExhausted',
      data: {
        scope: 'item',
        account,
        limit_kind: accountVerdict.limitKind,
        declared_limit: accountVerdict.declaredLimit,
        observed: accountVerdict.observed,
        detail: `budget limit "${accountVerdict.limitKind}" exceeded: observed ${String(accountVerdict.observed)} > declared ${String(accountVerdict.declaredLimit)}`,
        resets_at: null,
      },
      actor: SUPERVISOR_ACTOR,
    });
  }

  const runLimits: BudgetLimits = { maxTurns: null, maxWallSeconds: null, maxUsd: deps.config.budget.maxUsdPerRun };
  const runVerdict = checkLimits(state.budget.item, runLimits);
  if (!runVerdict.ok) {
    state = await appendAndFold(deps, state, {
      type: 'BudgetExhausted',
      data: {
        scope: 'run',
        account: null,
        limit_kind: runVerdict.limitKind,
        declared_limit: runVerdict.declaredLimit,
        observed: runVerdict.observed,
        detail: `budget limit "${runVerdict.limitKind}" exceeded: observed ${String(runVerdict.observed)} > declared ${String(runVerdict.declaredLimit)}`,
        resets_at: null,
      },
      actor: SUPERVISOR_ACTOR,
    });
  }

  if (outcome.kind === 'quota') {
    state = await appendAndFold(deps, state, {
      type: 'BudgetExhausted',
      data: {
        scope: 'item',
        account,
        limit_kind: 'provider-quota',
        declared_limit: null,
        observed: null,
        detail: 'provider quota exhausted for this account',
        resets_at: outcome.resetsAt,
      },
      actor: SUPERVISOR_ACTOR,
    });
    await releaseLock(deps, state, workspaceInfo.workdir, handle.executor.id, decision.stage);
    return;
  }

  if (capture.committedDuringRun) {
    state = await appendAndFold(deps, state, {
      type: 'StageFailed',
      data: {
        stage: decision.stage,
        attempt: decision.attempt,
        reason: 'executor-committed',
        detail: 'the executor committed inside the workspace during the run',
      },
      actor: SUPERVISOR_ACTOR,
    });
    await releaseLock(deps, state, workspaceInfo.workdir, handle.executor.id, decision.stage);
    return;
  }

  for (const derivedInput of outcome.derived) {
    state = await appendAndFold(deps, state, derivedInput);
  }

  if (outcome.kind === 'failed') {
    state = await appendAndFold(deps, state, {
      type: 'StageFailed',
      data: { stage: decision.stage, attempt: decision.attempt, reason: outcome.reason, detail: outcome.detail },
      actor: SUPERVISOR_ACTOR,
    });
    await releaseLock(deps, state, workspaceInfo.workdir, handle.executor.id, decision.stage);
    return;
  }

  state = await appendAndFold(deps, state, {
    type: 'StageCompleted',
    data: { stage: decision.stage, attempt: decision.attempt, artifact: outcome.artifact },
    actor: SUPERVISOR_ACTOR,
  });
  await releaseLock(deps, state, workspaceInfo.workdir, handle.executor.id, decision.stage);
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function extractUsd(rawResult: unknown): number | null {
  if (rawResult === null || typeof rawResult !== 'object') {
    return null;
  }
  const value = (rawResult as Record<string, unknown>)['total_cost_usd'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function runItem(deps: RunItemDeps): Promise<RunItemResult> {
  let iterations = 0;
  for (;;) {
    iterations += 1;
    const state = project(await deps.log.readAll());

    if (iterations > MAX_LOOP_ITERATIONS) {
      const failed = await appendAndFold(deps, state, {
        type: 'WorkItemFailed',
        data: {
          reason: 'loop-guard',
          detail: `exceeded MAX_LOOP_ITERATIONS (${String(MAX_LOOP_ITERATIONS)})`,
        },
        actor: SUPERVISOR_ACTOR,
      });
      return finalize(deps, failed, 'failed');
    }

    const decision = nextStage(state, deps.policy);

    switch (decision.kind) {
      case 'done': {
        if (decision.outcome === 'completed') {
          const next =
            state.status === 'completed'
              ? state
              : await appendAndFold(deps, state, {
                  type: 'WorkItemCompleted',
                  data: { stages_completed: Object.keys(state.artifacts) as Stage[] },
                  actor: SUPERVISOR_ACTOR,
                });
          return finalize(deps, next, 'completed');
        }
        return finalize(deps, state, 'failed');
      }
      case 'park': {
        const resetsAt =
          decision.account !== null
            ? (state.budget.accounts[decision.account]?.exhausted?.resetsAt ?? null)
            : (state.budget.itemExhausted?.resetsAt ?? null);
        const next =
          state.status === 'parked'
            ? state
            : await appendAndFold(deps, state, {
                type: 'WorkItemParked',
                data: {
                  reason: decision.reason,
                  detail: decision.detail,
                  resumable: true,
                  account: decision.account,
                  resets_at: resetsAt,
                },
                actor: SUPERVISOR_ACTOR,
              });
        return finalize(deps, next, 'parked');
      }
      case 'checkpoint': {
        let next = state;
        const existing = next.checkpoints[decision.checkpoint];
        if (existing === undefined || existing.status !== 'open') {
          next = await appendAndFold(deps, next, {
            type: 'CheckpointRaised',
            data: {
              checkpoint: decision.checkpoint,
              kind: 'blast-radius',
              stage: decision.stage,
              summary: `checkpoint ${decision.checkpoint} requires human review`,
              blocking: true,
              sla_seconds: null,
              default_decision: null,
            },
            actor: SUPERVISOR_ACTOR,
          });
        }
        if (next.status !== 'parked') {
          next = await appendAndFold(deps, next, {
            type: 'WorkItemParked',
            data: {
              reason: 'awaiting-human',
              detail: `blocked on checkpoint ${decision.checkpoint}`,
              resumable: true,
              account: null,
              resets_at: null,
            },
            actor: SUPERVISOR_ACTOR,
          });
        }
        return finalize(deps, next, 'parked');
      }
      case 'run': {
        await performRunAttempt(deps, state, decision);
        continue;
      }
      default:
        return assertNever(decision);
    }
  }
}

