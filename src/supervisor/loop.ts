import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNever } from '../core/events.js';
import type { Actor, FailureAttemptBucket, RunOutcome, Stage } from '../core/events.js';
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
import type { CheckContext } from '../agents/checks.js';
import type { AppendFn, PackBuildInput, RawPackMaterials } from '../agents/agent.js';
import type { ArchitecturePlan, RequirementSet, TaskGraph, TestSuiteSpec } from '../contracts/index.js';
import type { AccountId, ExecutorInstanceId } from '../core/ids.js';
import type { CauseId, EventId, TaskId } from '../core/ids.js';
import { artifactSectionTier, deriveClaims } from '../wiki/records.js';
import { fileMapBodies, stackFactsBodies, systemSkeletonBodies, wikiIndexBodies } from '../wiki/packmaterials.js';
import { runOracleSweep } from '../oracles/runner.js';
import { checkpointAcceptedTask, checkpointFrozenTests, captureFinalPatch, rebuildWorkspace } from '../integrator/merge.js';
import { bucketLimit, classifyFailure, deterministicTaskOrder, escalationRank, invalidationClosure, nextEscalationLevel } from './escalation.js';
import type { SupervisorAction } from './nextStage.js';
import type { ReviewVerdict } from '../contracts/index.js';

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
  readonly oraclesDir?: string;
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
function getArtifactBody<T>(events: readonly MienguEvent[], eventId: EventId | null): T | null {
  if (eventId === null) return null;
  const event = events.find((candidate) => candidate.event_id === eventId);
  return event?.type === 'StageCompleted' && event.data.artifact !== null ? event.data.artifact.body as T : null;
}

function buildCheckContext(
  events: readonly MienguEvent[],
  state: WorkItemState,
  config: MienguConfig,
  testDirs: readonly string[],
): CheckContext {
  return {
    requirementSet: getArtifactBody<RequirementSet>(events, state.artifacts.requirementSet?.eventId ?? null),
    architecturePlan: getArtifactBody<ArchitecturePlan>(events, state.artifacts.architecturePlan?.eventId ?? null),
    taskGraph: getArtifactBody<TaskGraph>(events, state.artifacts.taskGraph?.eventId ?? null),
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
 *  fetchers are supervisor plumbing, per `agent.ts`'s own note). Wiki index, stack facts,
 *  system skeleton and file map are sourced from this item's own claim set (binding decision
 *  10: item-scoped, never `listItemIds` — a pack material must never read another item's
 *  log). Source files, PRD-external material, diffs and oracle results remain supervisor/CLI
 *  plumbing outside Phase 4's scope; a `null`/empty value simply yields no section of that
 *  kind, never a fabricated one. The diff is the exception: it is captured before the stage
 *  runs and passed in, because the Reviewer cannot do its job without it. */
async function buildRawPackMaterials(o: {
  readonly workdir: string;
  readonly prdPath: string;
  readonly testDirs: readonly string[];
  readonly events: readonly MienguEvent[];
  readonly state: WorkItemState;
  readonly requirementSet: RequirementSet | null;
  readonly testSuiteSpec: TestSuiteSpec | null;
  readonly frozenTests: FrozenTestsState | null;
  readonly task: TaskGraph['tasks'][number] | null;
  readonly assumptions: readonly AssumptionRecord[];
  readonly oracleResults: string | null;
  readonly currentTaskReviewerFindings: string | null;
  readonly escalationContext: RawPackMaterials['escalationContext'];
  /** The working-tree diff as captured BEFORE this stage ran. The Reviewer's pack is built
   *  from it (§15.6 lists the diff first); every other role omits the kind, so passing it
   *  is harmless for them and `assemblePack` drops it. */
  readonly diff: string | null;
}): Promise<RawPackMaterials> {
  const prd = await readTextFileOrNull(o.prdPath);

  const claimSet = deriveClaims(o.events);
  const artifacts = o.state.artifacts;

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
    wikiIndex: wikiIndexBodies(claimSet),
    existingReqIds: o.requirementSet?.requirements.map((r) => r.req_id) ?? [],
    priorOutOfScope: o.requirementSet?.out_of_scope ?? [],
    stackFacts: stackFactsBodies(claimSet),
    systemSkeleton: systemSkeletonBodies(claimSet),
    fileMap: fileMapBodies(claimSet),
    testConventions: `Tests live under: ${o.testDirs.join(', ')}`,
    // The Coder runs inside the prepared worktree and can read files itself; shipping bodies
    // it can already read buys no review minutes and is not a Phase 4 contract (§9).
    sourceFiles: [],
    frozenTestList,
    frozenTestBodies,
    diff: o.diff,
    oracleResults: o.oracleResults,
    currentTaskReviewerFindings: o.currentTaskReviewerFindings,
    escalationContext: o.escalationContext,
    assumptions: o.assumptions.map((a) => ({
      question: a.question,
      chosen: a.chosen,
      affects: a.affects,
    })),
    artifactTiers: {
      requirementSet: artifactSectionTier(claimSet, artifacts.requirementSet?.eventId ?? null, 'T2'),
      architecturePlan: artifactSectionTier(claimSet, artifacts.architecturePlan?.eventId ?? null, 'T2'),
      taskGraph: artifactSectionTier(claimSet, artifacts.taskGraph?.eventId ?? null, 'T2'),
      testSuiteSpec: artifactSectionTier(claimSet, artifacts.testSuiteSpec?.eventId ?? null, 'T2'),
    },
  };
}

/** Produces only task-local oracle evidence.  In particular, an integration sweep or a
 * sibling task's failure must never leak into a Coder/Reviewer prompt. */
function taskOracleEvidence(state: WorkItemState, taskId: TaskId | null): string | null {
  if (taskId === null) return null;
  const sweeps = Object.values(state.oracleSweeps).filter(
    (sweep) => sweep.scope === 'task' && sweep.taskId === taskId,
  );
  const latest = sweeps.at(-1);
  return latest === undefined ? null : JSON.stringify({
    sweep_id: latest.sweepId,
    outcome: latest.outcome,
    failed_kind: latest.failedKind,
    results: latest.results,
  }, null, 2);
}

function taskReviewerFindings(
  events: readonly MienguEvent[], state: WorkItemState, taskId: TaskId | null,
): string | null {
  if (taskId === null) return null;
  const review = state.tasks?.records[taskId]?.review;
  const verdict = getArtifactBody<ReviewVerdict>(events, review?.eventId ?? null);
  return verdict === null ? null : JSON.stringify(verdict.findings, null, 2);
}

function activeEscalationContext(
  state: WorkItemState,
  oracleResults: string | null,
  reviewerFindings: string | null,
): RawPackMaterials['escalationContext'] {
  if (state.activeCauseId === null) return null;
  const cause = state.causes[state.activeCauseId];
  if (cause === undefined || !['analyst', 'architect', 'planner'].includes(cause.level)) return null;
  return {
    category: cause.kind,
    affectedRequirementIds: cause.affects.reqIds,
    summary: `${cause.kind} failure at ${cause.level} escalation`,
    componentIds: cause.affects.componentIds,
    t1OracleSummaries: oracleResults === null ? [] : [oracleResults],
    taskIds: cause.affects.taskIds,
    currentTaskReviewerFindings: reviewerFindings,
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
  const checkContext = buildCheckContext(events, state, deps.config, testDirs);
  const testSuiteSpec = getArtifactBody<TestSuiteSpec>(events, state.artifacts.testSuiteSpec?.eventId ?? null);
  const task = state.tasks?.currentTaskId === null || state.tasks === null || checkContext.taskGraph === null
    ? null
    : checkContext.taskGraph.tasks.find((candidate) => candidate.task_id === state.tasks?.currentTaskId) ?? null;
  const selectedTaskId = task?.task_id ?? null;
  const oracleResults = taskOracleEvidence(state, selectedTaskId);
  const reviewerFindings = taskReviewerFindings(events, state, selectedTaskId);
  const raw = await buildRawPackMaterials({
    workdir: workspaceInfo.workdir,
    prdPath: state.source.path,
    testDirs,
    events,
    state,
    requirementSet: checkContext.requirementSet,
    testSuiteSpec,
    frozenTests: state.frozenTests,
    task,
    assumptions: state.assumptions,
    diff: before.diff.length > 0 ? before.diff : null,
    oracleResults,
    currentTaskReviewerFindings: reviewerFindings,
    escalationContext: activeEscalationContext(state, oracleResults, reviewerFindings),
  });
  const pack: PackBuildInput = {
    itemId: state.itemId,
    checkContext,
    task,
    activeT1OracleFailure: hasCurrentMatchingOracleFailure(state, selectedTaskId),
    activeCauseLevel: state.activeCauseId === null ? null : state.causes[state.activeCauseId]?.level ?? null,
    raw,
  };

  const append: AppendFn = async (input) => {
    const result = await appendEvent(deps, state, input);
    state = result.state;
    const eventId = deps.log.lastEventId;
    if (eventId === null) {
      throw new StoreError('append did not produce an event id');
    }
    return { ts: result.ts, eventId };
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
  const capture = await deps.workspace.capture(workspaceInfo, { beforeHeadCommit: before.headCommit });
  // An executor is never allowed to create a commit.  Restore the exact invocation-start
  // detached HEAD before any later accounting or derived events; `restoreDetached` also
  // removes untracked output created by that invocation.
  if (capture.committedDuringRun) {
    await deps.workspace.restoreDetached(workspaceInfo, before.headCommit);
  }
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
    const restored = await deps.workspace.restore(workspaceInfo, before);
    state = await appendAndFold(deps, state, {
      type: 'StageFailed',
      data: {
        stage: decision.stage,
        attempt: decision.attempt,
        reason: 'sandbox-violation',
        detail: restored.restoredFully
          ? 'a read-only stage modified the workspace; the change was reverted'
          : 'a read-only stage modified the workspace; exact baseline restoration failed',
      },
      actor: SUPERVISOR_ACTOR,
    });
    state = await appendStageFailureCause(deps, state, 'sandbox-violation');
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
    state = await appendStageFailureCause(deps, state, 'executor-committed');
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
    state = await appendStageFailureCause(deps, state, outcome.reason);
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

async function ensureWorkspace(deps: RunItemDeps, state: WorkItemState): Promise<WorkItemState> {
  if (state.workspace !== null) return state;
  const prepared = await deps.workspace.prepare({
    itemId: deps.log.itemId,
    targetRepo: deps.targetRepo,
    baseRef: deps.config.target.baseRef,
    workspacesDir: deps.workspacesDir,
    name: 'workspace',
  });
  return appendAndFold(deps, state, {
    type: 'WorkspacePrepared',
    data: { mode: prepared.mode, target_repo: prepared.targetRepo, workdir: prepared.workdir, base_ref: prepared.baseRef, base_commit: prepared.baseCommit },
    actor: SUPERVISOR_ACTOR,
  });
}

function preparedWorkspace(state: WorkItemState): PreparedWorkspace {
  if (state.workspace === null) throw new StoreError('supervisor action requires a workspace');
  return { mode: state.workspace.mode, targetRepo: state.workspace.targetRepo, workdir: state.workspace.workdir, baseRef: state.workspace.baseRef, baseCommit: state.workspace.baseCommit };
}

function activeArtifactIds(
  state: WorkItemState,
  taskIds: readonly TaskId[],
  kinds: ReturnType<typeof invalidationClosure>['invalidateArtifacts'],
): EventId[] {
  const ids: EventId[] = [];
  if (kinds.includes('requirementSet') && state.artifacts.requirementSet !== null) ids.push(state.artifacts.requirementSet.eventId);
  if (kinds.includes('architecturePlan') && state.artifacts.architecturePlan !== null) ids.push(state.artifacts.architecturePlan.eventId);
  if (kinds.includes('taskGraph') && state.artifacts.taskGraph !== null) ids.push(state.artifacts.taskGraph.eventId);
  if (kinds.includes('testSuiteSpec') && state.artifacts.testSuiteSpec !== null) ids.push(state.artifacts.testSuiteSpec.eventId);
  if (kinds.includes('taskArtifacts')) {
    for (const taskId of taskIds) {
      const task = state.tasks?.records[taskId];
      if (task?.implementation !== null && task?.implementation !== undefined) ids.push(task.implementation.eventId);
      if (task?.review !== null && task?.review !== undefined) ids.push(task.review.eventId);
    }
  }
  return [...new Set(ids)].sort();
}

function handlerStage(level: import('../core/events.js').EscalationLevel): Stage {
  switch (level) {
    case 'coder': return 'implementation';
    case 'reviewer': return 'review';
    case 'planner': return 'planning';
    case 'architect': return 'architecture';
    case 'analyst': return 'analysis';
    case 'human': throw new StoreError('human escalation has no automatic handler');
  }
}

function evidenceRef(patch: { readonly sha256: string; readonly path: string; readonly bytes: number }): { readonly sha256: string; readonly path: string; readonly bytes: number } {
  return { sha256: patch.sha256, path: patch.path, bytes: patch.bytes };
}

/** A remediation attempt is durable only after the handler has produced a countable outcome.
 * Provider quota/authentication and an operator abort are availability outcomes, not causal
 * attempts, so they must leave the cause bucket untouched. */
function remediationAttemptOutcome(
  events: readonly MienguEvent[],
  sinceSeq: number,
  stage: Stage,
  operatorAborted: boolean,
): 'counted' | 'quota' | 'unavailable' | 'aborted' {
  if (operatorAborted) return 'aborted';
  const returned = events
    .filter((event): event is Extract<MienguEvent, { type: 'ExecutorReturned' }> =>
      event.seq > sinceSeq && event.type === 'ExecutorReturned' && event.data.stage === stage,
    )
    .at(-1);
  if (returned === undefined) return 'counted';
  if (returned.data.status === 'quota_exhausted' || returned.data.raw.failure_kind === 'quota') return 'quota';
  if (returned.data.raw.failure_kind === 'auth') return 'unavailable';
  return 'counted';
}

async function appendCause(
  deps: RunItemDeps, state: WorkItemState, kind: Parameters<typeof classifyFailure>[0], taskId: TaskId | null, trigger: EventId,
): Promise<WorkItemState> {
  if (state.activeCauseId !== null) return state;
  const classification = classifyFailure(kind);
  // A regenerated task can expose the same durable failure after an upstream artifact has
  // been accepted.  It is a child campaign, not a reset: start strictly above the resolved
  // parent's handler so the finite ladder never revisits Coder/Reviewer/Planner indefinitely.
  const parent = Object.values(state.causes)
    .filter((cause) => cause.kind === kind && cause.taskId === taskId && cause.status === 'resolved')
    .at(-1);
  const initialLevel = parent === undefined
    ? classification.initialLevel
    : nextEscalationLevel(parent.level) ?? 'human';
  return appendAndFold(deps, state, {
    type: 'FailureCauseOpened',
    data: { trigger_event_id: trigger, parent_cause_id: parent?.causeId ?? null, kind, task_id: taskId, initial_level: initialLevel, affects: { req_ids: [], component_ids: [], task_ids: taskId === null ? [] : [taskId] }, summary: `${kind} failure` },
    actor: SUPERVISOR_ACTOR,
  });
}

function failureKindForStage(reason: import('../core/events.js').StageFailureReason): Parameters<typeof classifyFailure>[0] {
  switch (reason) {
    case 'sandbox-violation':
    case 'executor-committed':
      return 'sandbox';
    case 'validation-failed':
    case 'executor-gave-up':
    case 'budget-turns':
    case 'budget-wall':
    case 'executor-crashed':
    case 'workspace-error':
    case 'internal-error':
      return 'agent-output';
    case 'tests-tampered':
      return 'test';
  }
}

function failureKindForReviewVerdict(verdict: ReviewVerdict | null): Parameters<typeof classifyFailure>[0] {
  if (verdict?.verdict !== 'escalate') return 'review-revision';
  switch (verdict.escalate_to) {
    case 'planner': return 'task-design';
    case 'architect': return 'architecture';
    case 'analyst': return 'requirements';
    case null: return 'review-revision';
  }
}

function activeTaskId(state: WorkItemState): TaskId | null {
  return state.tasks?.currentTaskId ?? null;
}

/** An historical oracle cause remains open until acceptance, but only a failed corrective
 * sweep for that same cause blocks the Reviewer from accepting the current task. */
function hasCurrentMatchingOracleFailure(state: WorkItemState, taskId: TaskId | null): boolean {
  if (taskId === null || state.activeCauseId === null) return false;
  const cause = state.causes[state.activeCauseId];
  if (cause?.kind !== 'oracle' || cause.taskId !== taskId) return false;
  const latest = Object.values(state.oracleSweeps)
    .filter((sweep) => sweep.scope === 'task' && sweep.taskId === taskId && sweep.causeId === cause.causeId)
    .at(-1);
  return latest?.outcome === 'failed';
}

async function appendStageFailureCause(
  deps: RunItemDeps,
  state: WorkItemState,
  reason: import('../core/events.js').StageFailureReason,
): Promise<WorkItemState> {
  if (state.lastEventId === null) return state;
  return appendCause(deps, state, failureKindForStage(reason), activeTaskId(state), state.lastEventId);
}

async function performSupervisorAction(
  deps: RunItemDeps,
  original: WorkItemState,
  action: SupervisorAction,
  taskId: string | null | undefined,
  causeId: string | null | undefined,
  level: import('../core/events.js').EscalationLevel | undefined,
  bucket: import('../core/events.js').FailureAttemptBucket | undefined,
): Promise<void> {
  let state = original;
  const events = await deps.log.readAll();
  const graph = getArtifactBody<TaskGraph>(events, state.artifacts.taskGraph?.eventId ?? null);
  if (action === 'activate-task-graph') {
    if (graph === null || state.artifacts.taskGraph === null) throw new StoreError('cannot activate missing task graph');
    await appendAndFold(deps, state, { type: 'TaskGraphActivated', data: { graph_event_id: state.artifacts.taskGraph.eventId, ordered_task_ids: deterministicTaskOrder(graph.tasks) }, actor: SUPERVISOR_ACTOR });
    return;
  }
  state = await ensureWorkspace(deps, state);
  const workspace = preparedWorkspace(state);
  if (action === 'checkpoint-tests') {
    const checkpoint = await checkpointFrozenTests({ workspace: deps.workspace, prepared: workspace, evidenceDir: deps.oraclesDir ?? join(deps.workspacesDir, '..', 'diffs') });
    await appendAndFold(deps, state, { type: 'WorkspaceCheckpointed', data: { kind: 'tests-frozen', task_id: null, parent_commit: checkpoint.parentCommit, commit: checkpoint.commit, patch: evidenceRef(checkpoint.patch) }, actor: SUPERVISOR_ACTOR });
    return;
  }
  if (action === 'start-task') {
    const id = taskId as TaskId;
    const record = state.tasks?.records[id];
    if (record === undefined || state.tasks === null) throw new StoreError('cannot start missing task');
    await appendAndFold(deps, state, { type: 'TaskStarted', data: { task_id: id, order_index: record.orderIndex, graph_event_id: state.tasks.taskGraphEventId }, actor: SUPERVISOR_ACTOR });
    return;
  }
  if (action === 'task-oracle' || action === 'integration-oracle') {
    const scope = action === 'task-oracle' ? 'task' as const : 'integration' as const;
    const result = await runOracleSweep({ scope, taskId: scope === 'task' ? taskId as TaskId : null, workdir: workspace.workdir, commands: deps.config.oracles, timeoutMs: deps.config.budget.maxWallSecondsPerInvocation * 1000, signal: deps.signal, evidenceDir: deps.oraclesDir ?? join(deps.workspacesDir, '..', 'oracles'), causeId: causeId as CauseId | null ?? null, append: async (input) => {
      const appended = await appendEvent(deps, state, input); state = appended.state;
      if (state.lastEventId === null) throw new StoreError('oracle append did not mint id');
      return { ts: appended.ts, eventId: state.lastEventId };
    } });
    if (result.outcome === 'failed') {
      const latest = state.lastEventId;
      if (latest !== null) await appendCause(deps, state, scope === 'integration' ? 'integration' : 'oracle', scope === 'task' ? taskId as TaskId : null, latest);
    } else if (result.outcome === 'passed' && scope === 'integration' && state.activeCauseId !== null) {
      const cause = state.causes[state.activeCauseId];
      if (cause?.taskId === null) {
        await appendAndFold(deps, state, {
          type: 'FailureCauseResolved',
          data: { cause_id: cause.causeId, resolution: 'integration oracle passed', task_id: null },
          actor: SUPERVISOR_ACTOR,
        });
      }
    }
    return;
  }
  if (action === 'review-task') {
    await performRunAttempt(deps, state, { stage: 'review', attempt: state.attempts.review + 1 });
    const after = project(await deps.log.readAll());
    const record = taskId === undefined || taskId === null ? undefined : after.tasks?.records[taskId as TaskId];
    const verdict = getArtifactBody<ReviewVerdict>(await deps.log.readAll(), record?.review?.eventId ?? null);
    const cause = after.activeCauseId === null ? null : after.causes[after.activeCauseId];
    if (cause !== null && cause !== undefined && verdict?.verdict === 'escalate' && verdict.escalate_to !== null) {
      if (escalationRank(verdict.escalate_to) <= escalationRank(cause.level)) {
        throw new StoreError(`Reviewer escalate_to "${verdict.escalate_to}" must be strictly above active cause level "${cause.level}"`);
      }
      if (cause.level === 'human') {
        throw new StoreError('Reviewer cannot escalate a human-owned cause');
      }
      const currentBucket: FailureAttemptBucket = cause.level === 'coder'
        ? cause.kind === 'oracle' ? 'oracle' : cause.kind === 'test' ? 'test' : 'review'
        : cause.level;
      await appendAndFold(deps, after, {
        type: 'EscalationAdvanced',
        data: {
          cause_id: cause.causeId,
          task_id: cause.taskId,
          from_level: cause.level,
          to_level: verdict.escalate_to,
          exhausted_bucket: currentBucket,
          attempts_used: cause.attempts[currentBucket],
          reason: `reviewer requested escalation to ${verdict.escalate_to}`,
        },
        actor: SUPERVISOR_ACTOR,
      });
    }
    return;
  }
  if (action === 'accept-task') {
    const id = taskId as TaskId;
    const record = state.tasks?.records[id];
    if (record?.implementation === null || record?.implementation === undefined || record.review === null || record.review === undefined) throw new StoreError('cannot accept task without active artifacts');
    const verdict = getArtifactBody<ReviewVerdict>(events, record.review.eventId);
    if (verdict?.verdict !== 'accept') {
      const trigger = record.review.eventId;
      await appendCause(deps, state, failureKindForReviewVerdict(verdict), id, trigger);
      return;
    }
    // A corrective implementation/review/sweep can be durable before the supervisor resolves
    // its matching cause.  Resolution must precede checkpointing and acceptance so replay
    // cannot turn a still-active T1 failure into an accepted task.
    if (state.activeCauseId !== null) {
      const cause = state.causes[state.activeCauseId];
      if (cause?.taskId === id) {
        await appendAndFold(deps, state, {
          type: 'FailureCauseResolved',
          data: { cause_id: cause.causeId, resolution: `corrective ${cause.kind} remediation passed`, task_id: id },
          actor: SUPERVISOR_ACTOR,
        });
        return;
      }
      throw new StoreError('cannot accept a task while another failure cause is active');
    }
    const checkpoint = await checkpointAcceptedTask({ workspace: deps.workspace, prepared: workspace, evidenceDir: deps.oraclesDir ?? join(deps.workspacesDir, '..', 'diffs'), taskId: id, orderIndex: record.orderIndex });
    const next = await appendAndFold(deps, state, { type: 'WorkspaceCheckpointed', data: { kind: 'task-accepted', task_id: id, parent_commit: checkpoint.parentCommit, commit: checkpoint.commit, patch: evidenceRef(checkpoint.patch) }, actor: SUPERVISOR_ACTOR });
    const checkpointId = next.lastEventId;
    if (checkpointId === null) throw new StoreError('missing checkpoint id');
    const sweep = Object.values(next.oracleSweeps)
      .filter((candidate) => candidate.scope === 'task' && candidate.taskId === id && candidate.implementationEventId === record.implementation!.eventId && candidate.outcome === 'passed')
      .at(-1);
    if (sweep === undefined) throw new StoreError('cannot accept task without passing oracle sweep');
    state = await appendAndFold(deps, next, { type: 'TaskAccepted', data: { task_id: id, implementation_event_id: record.implementation.eventId, review_event_id: record.review.eventId, oracle_sweep_id: sweep.sweepId, checkpoint_event_id: checkpointId }, actor: SUPERVISOR_ACTOR });
    return;
  }
  if (action === 'advance-escalation') {
    const cause = causeId === undefined || causeId === null ? null : state.causes[causeId as CauseId];
    if (cause === undefined || cause === null || level === undefined || bucket === undefined) throw new StoreError('missing escalation data');
    await appendAndFold(deps, state, { type: 'EscalationAdvanced', data: { cause_id: cause.causeId, task_id: cause.taskId, from_level: cause.level, to_level: level, exhausted_bucket: bucket, attempts_used: cause.attempts[bucket], reason: `${bucket} attempt budget exhausted` }, actor: SUPERVISOR_ACTOR });
    return;
  }
  if (action === 'invalidate-artifacts') {
    const cause = causeId === undefined || causeId === null ? null : state.causes[causeId as CauseId];
    if (cause === undefined || cause === null || level === undefined) throw new StoreError('missing invalidation data');
    // Remediation scope follows the handler that is being invoked, not the kind that
    // originally opened the cause. An oracle cause escalated to Planner must invalidate the
    // plan/graph boundary, rather than repeatedly applying the Coder closure.
    const target = level === 'coder' ? 'coder'
      : level === 'reviewer' || level === 'human' ? null
        : level;
    if (target !== null && graph !== null) {
      const closure = invalidationClosure(graph, target, cause.taskId);
      // Architect and Analyst invalidate the frozen tests themselves. Preserve the physical
      // restore inputs before the event deliberately clears their projected references, then
      // rebuild from the immutable original base with no obsolete patches reapplied.
      const invalidatesTests = target === 'architect' || target === 'analyst';
      const frozen = Object.values(state.workspaceCheckpoints).find((checkpoint) => checkpoint.kind === 'tests-frozen' && checkpoint.patch !== null);
      const retained = invalidatesTests
        ? []
        : Object.values(state.tasks?.records ?? {}).filter((record) => record.status === 'accepted' && record.checkpoint?.patch !== null);
      if (invalidatesTests) {
        await deps.workspace.restoreDetached(workspace, workspace.baseCommit);
      }
      state = await appendAndFold(deps, state, { type: 'ArtifactsInvalidated', data: { cause_id: cause.causeId, target, affected_ids: { req_ids: closure.reqIds, component_ids: closure.componentIds, task_ids: closure.taskIds }, artifact_event_ids: activeArtifactIds(state, closure.taskIds, closure.invalidateArtifacts), reason: `${level} remediation` }, actor: SUPERVISOR_ACTOR });
      if (!invalidatesTests && frozen !== undefined && frozen.patch !== null) {
        const asPatch = (checkpoint: NonNullable<typeof frozen>) => ({ parentCommit: checkpoint.parentCommit, commit: checkpoint.commit, patch: { ...checkpoint.patch!, files: [], insertions: 0, deletions: 0 } });
        const retainedTasks = retained.map((record) => ({ ...asPatch(record.checkpoint!), taskId: record.taskId, orderIndex: record.orderIndex }));
        const rebuilt = await rebuildWorkspace({ workspace: deps.workspace, prepared: workspace, originalBaseCommit: workspace.baseCommit, frozenTests: asPatch(frozen), retainedTasks, invalidatedTaskIds: closure.taskIds });
        if (rebuilt.kind === 'rebuilt') {
          state = await appendAndFold(deps, state, { type: 'WorkspaceRestored', data: { cause_id: cause.causeId, target, base_checkpoint_event_id: frozen.eventId, base_commit: rebuilt.baseCommit, retained_task_commits: rebuilt.retainedTaskCommits.map((entry) => ({ task_id: entry.taskId, commit: entry.commit })), invalidated_task_ids: closure.taskIds }, actor: SUPERVISOR_ACTOR });
        } else if (cause.level !== 'planner' && cause.level !== 'architect' && cause.level !== 'analyst' && cause.level !== 'human') {
          // A failed deterministic rebuild is a new durable routing fact, not an exception
          // to swallow. Move upward once; the following loop turn dispatches Planner.
          await appendAndFold(deps, state, { type: 'EscalationAdvanced', data: { cause_id: cause.causeId, task_id: cause.taskId, from_level: cause.level, to_level: 'planner', exhausted_bucket: bucket ?? classifyFailure(cause.kind).bucket, attempts_used: cause.attempts[bucket ?? classifyFailure(cause.kind).bucket], reason: rebuilt.detail }, actor: SUPERVISOR_ACTOR });
          return;
        }
      }
    }
    const handler = handlerStage(level);
    const attemptBucket = bucket ?? classifyFailure(cause.kind).bucket;
    const attempt = cause.attempts[attemptBucket] + 1;
    if (handler === 'implementation' && cause.taskId !== null && state.tasks?.currentTaskId === null) {
      const record = state.tasks?.records[cause.taskId];
      if (record !== undefined && record.status === 'pending') {
        state = await appendAndFold(deps, state, { type: 'TaskStarted', data: { task_id: cause.taskId, order_index: record.orderIndex, graph_event_id: state.tasks.taskGraphEventId }, actor: SUPERVISOR_ACTOR });
      }
    }
    const handlerStartSeq = state.seq;
    await performRunAttempt(deps, state, { stage: handler, attempt: state.attempts[handler] + 1 });
    const handlerEvents = await deps.log.readAll();
    state = project(handlerEvents);
    const attemptOutcome = remediationAttemptOutcome(handlerEvents, handlerStartSeq, handler, deps.signal.aborted);
    if (attemptOutcome === 'counted') {
      state = await appendAndFold(deps, state, {
        type: 'FailureAttempted',
        data: {
          cause_id: cause.causeId,
          task_id: cause.taskId,
          level,
          bucket: attemptBucket,
          attempt,
          limit: bucketLimit(attemptBucket, deps.policy.limits),
          handler_stage: handler,
        },
        actor: SUPERVISOR_ACTOR,
      });
    }
    if (attemptOutcome === 'unavailable') {
      await appendAndFold(deps, state, {
        type: 'WorkItemParked',
        data: {
          reason: 'executor-unavailable',
          detail: 'executor authentication is unavailable',
          resumable: true,
          account: null,
          resets_at: null,
        },
        actor: SUPERVISOR_ACTOR,
      });
      return;
    }
    // An upstream artifact is the corrective output itself. Once it is accepted by its
    // normal contract checks, resolve the cause so the regenerated task/integration pipeline
    // can proceed; otherwise the active-cause precedence would repeatedly re-run the same
    // rung until Human despite a successful remediation.
    if (level === 'planner' || level === 'architect' || level === 'analyst') {
      const afterEvents = await deps.log.readAll();
      const after = project(afterEvents);
      const completed = afterEvents.some(
        (event) => event.seq > handlerStartSeq && event.type === 'StageCompleted' && event.data.stage === handler,
      );
      const current = after.activeCauseId === cause.causeId ? after.causes[cause.causeId] : undefined;
      if (completed && current !== undefined) {
        await appendAndFold(deps, after, {
          type: 'FailureCauseResolved',
          data: { cause_id: cause.causeId, resolution: `${level} remediation completed`, task_id: cause.taskId },
          actor: SUPERVISOR_ACTOR,
        });
      }
    }
    return;
  }
  if (action === 'capture-final-patch') {
    const final = await captureFinalPatch({ workspace: deps.workspace, prepared: workspace, originalBaseCommit: workspace.baseCommit, evidenceDir: deps.oraclesDir ?? join(deps.workspacesDir, '..', 'diffs') });
    await appendAndFold(deps, state, { type: 'FinalPatchCaptured', data: { original_base_commit: final.originalBaseCommit, accepted_head_commit: final.acceptedHeadCommit, patch: evidenceRef(final.patch), files: final.patch.files, insertions: final.patch.insertions, deletions: final.patch.deletions }, actor: SUPERVISOR_ACTOR });
    return;
  }
}

export async function runItem(deps: RunItemDeps): Promise<RunItemResult> {
  let iterations = 0;
  for (;;) {
    iterations += 1;
    const state = project(await deps.log.readAll());

    if (deps.signal.aborted) {
      return finalize(deps, state, 'aborted');
    }

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
                  data: {
                    stages_completed: [
                      state.artifacts.requirementSet,
                      state.artifacts.architecturePlan,
                      state.artifacts.taskGraph,
                      state.artifacts.testSuiteSpec,
                    ].flatMap((artifact): Stage[] =>
                      artifact === null ? [] : [artifact.stage],
                    ),
                  },
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
        if (decision.action !== undefined) {
          await performSupervisorAction(deps, state, decision.action, decision.taskId, decision.causeId, decision.level, decision.bucket);
        } else {
          await performRunAttempt(deps, state, decision);
        }
        continue;
      }
      default:
        return assertNever(decision);
    }
  }
}
