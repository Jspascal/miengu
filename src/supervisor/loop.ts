import { assertNever } from '../core/events.js';
import type { Actor, RunOutcome, Stage } from '../core/events.js';
import { sha256Hex } from '../core/hash.js';
import type { Clock } from '../core/clock.js';
import type { IdMinter } from '../core/idgen.js';
import { StoreError } from '../errors.js';
import type { EventLog, AppendInput } from '../core/log.js';
import type { SnapshotStore } from '../core/snapshot.js';
import type { Logger } from '../logging.js';
import type { MienguConfig } from '../config/schema.js';
import type { Executor, RawRunSource } from '../executors/executor.js';
import type { PreparedWorkspace, WorkspaceProvider } from '../executors/isolation.js';
import { applyEvent, project } from '../state/projector.js';
import { stateHash } from '../state/stateHash.js';
import { nextStageInOrder } from '../state/workitem.js';
import type { WorkItemState } from '../state/workitem.js';
import { checkLimits, fromTelemetry } from './budget.js';
import type { BudgetLimits } from './budget.js';
import { nextStage } from './nextStage.js';
import type { StagePolicy } from './nextStage.js';
import { buildStubPrompt, runStubStage } from './stages.js';

export const MAX_LOOP_ITERATIONS = 1000;

const SUPERVISOR_ACTOR: Actor = { kind: 'supervisor', id: null };

export interface RunItemDeps {
  readonly log: EventLog;
  readonly snapshots: SnapshotStore<WorkItemState>;
  readonly config: MienguConfig;
  readonly policy: StagePolicy;
  readonly executor: Executor & Partial<RawRunSource>;
  readonly workspace: WorkspaceProvider;
  // Not part of the illustrative field list in the work order, but mechanically required:
  // WorkspaceProvider.prepare() needs an absolute directory to place the workspace under and
  // an absolute path to the target repo, and RunItemDeps otherwise carries no absolute paths
  // (only the un-resolved, config-file-relative `config.target.repo`). The caller that loaded
  // the config already resolved both (see `LoadedConfig`); it passes them straight through.
  readonly targetRepo: string;
  readonly workspacesDir: string;
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

function extractUsd(rawResult: unknown): number | null {
  if (rawResult === null || typeof rawResult !== 'object') {
    return null;
  }
  const value = (rawResult as Record<string, unknown>)['total_cost_usd'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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

async function appendAndFold(
  deps: RunItemDeps,
  state: WorkItemState,
  input: Omit<AppendInput, 'causationId'>,
): Promise<WorkItemState> {
  const event = await deps.log.append({ ...input, causationId: deps.log.lastEventId });
  const next = applyEvent(state, event);
  await maybeSnapshot(deps, next, false);
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

/**
 * Executes one `run` decision to completion: `StageEntered` -> ensure workspace -> `ExecutorInvoked`
 * (before spawning) -> `runStubStage` -> `ExecutorReturned` -> capture -> `DiffCaptured` ->
 * `BudgetConsumed` -> `checkLimits` (-> `BudgetExhausted` on violation, and on a quota
 * `failureKind`) -> `StageCompleted` or `StageFailed` -> on success, advance the stage via
 * `nextStageInOrder`, recorded by the next `StageEntered`. Appends only; the caller re-reads and
 * re-projects on the next outer-loop iteration, so no state is threaded back out.
 */
async function performRunAttempt(
  deps: RunItemDeps,
  initialState: WorkItemState,
  decision: { readonly stage: Stage; readonly attempt: number },
  budgetLimits: BudgetLimits,
): Promise<void> {
  let state = await appendAndFold(deps, initialState, {
    type: 'StageEntered',
    data: { stage: decision.stage, attempt: decision.attempt },
    actor: SUPERVISOR_ACTOR,
  });

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

  const prompt = buildStubPrompt(decision.stage);
  const taskBudget = {
    maxTurns: deps.config.budget.maxTurnsPerTask,
    maxWallSeconds: deps.config.budget.maxWallSecondsPerTask,
  };

  state = await appendAndFold(deps, state, {
    type: 'ExecutorInvoked',
    data: {
      executor_id: deps.executor.id,
      stage: decision.stage,
      workdir: workspaceInfo.workdir,
      prompt_sha256: sha256Hex(prompt),
      prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
      context_pack_id: null,
      session_id: null,
      budget: { max_turns: taskBudget.maxTurns, max_wall_seconds: taskBudget.maxWallSeconds },
      command_line: [],
    },
    actor: SUPERVISOR_ACTOR,
  });

  const outcome = await runStubStage(decision.stage, {
    executor: deps.executor,
    itemId: deps.log.itemId,
    workdir: workspaceInfo.workdir,
    budget: taskBudget,
    signal: deps.signal,
  });
  const executorResult = outcome.executorResult;
  const rawRun = deps.executor.lastRun ?? null;

  state = await appendAndFold(deps, state, {
    type: 'ExecutorReturned',
    data: {
      executor_id: deps.executor.id,
      stage: decision.stage,
      status: executorResult.status,
      telemetry: {
        turns: executorResult.telemetry.turns,
        input_tokens: executorResult.telemetry.inputTokens,
        output_tokens: executorResult.telemetry.outputTokens,
        wall_seconds: executorResult.telemetry.wallSeconds,
      },
      raw: {
        exit_code: rawRun?.exitCode ?? null,
        signal: rawRun?.signal ?? null,
        killed: rawRun?.killed ?? 'none',
        observed_turns: rawRun?.observedTurns ?? null,
        failure_kind: rawRun?.failureKind ?? null,
        stderr_tail: rawRun?.stderrTail ?? '',
        transcript_path: rawRun?.transcriptPath ?? null,
      },
    },
    actor: { kind: 'executor', id: deps.executor.id },
  });

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

  const usd = extractUsd(rawRun?.rawResult ?? null);
  const delta = fromTelemetry(executorResult.telemetry, usd);
  state = await appendAndFold(deps, state, {
    type: 'BudgetConsumed',
    data: { scope: 'task', wall_seconds: delta.wallSeconds, turns: delta.turns, usd: delta.usd },
    actor: SUPERVISOR_ACTOR,
  });

  const verdict = checkLimits(state.budget.consumed, budgetLimits);
  if (!verdict.ok) {
    state = await appendAndFold(deps, state, {
      type: 'BudgetExhausted',
      data: {
        scope: 'task',
        limit_kind: verdict.limitKind,
        declared_limit: verdict.declaredLimit,
        observed: verdict.observed,
        detail: `budget limit "${verdict.limitKind}" exceeded: observed ${String(verdict.observed)} > declared ${String(verdict.declaredLimit)}`,
      },
      actor: SUPERVISOR_ACTOR,
    });
  }
  if (rawRun?.failureKind === 'quota') {
    state = await appendAndFold(deps, state, {
      type: 'BudgetExhausted',
      data: {
        scope: 'task',
        limit_kind: 'provider-quota',
        declared_limit: null,
        observed: null,
        detail: 'provider quota signature detected in the executor result',
      },
      actor: SUPERVISOR_ACTOR,
    });
  }

  if (outcome.kind === 'failed') {
    await appendAndFold(deps, state, {
      type: 'StageFailed',
      data: {
        stage: decision.stage,
        attempt: decision.attempt,
        reason: outcome.reason,
        detail: outcome.detail,
      },
      actor: SUPERVISOR_ACTOR,
    });
    return;
  }

  if (capture.committedDuringRun) {
    await appendAndFold(deps, state, {
      type: 'StageFailed',
      data: {
        stage: decision.stage,
        attempt: decision.attempt,
        reason: 'executor-committed',
        detail: 'the executor committed inside the workspace during the run',
      },
      actor: SUPERVISOR_ACTOR,
    });
    return;
  }

  state = await appendAndFold(deps, state, {
    type: 'StageCompleted',
    data: { stage: decision.stage, attempt: decision.attempt, artifact: outcome.artifact },
    actor: SUPERVISOR_ACTOR,
  });

  await appendAndFold(deps, state, {
    type: 'StageEntered',
    data: { stage: nextStageInOrder(decision.stage), attempt: 1 },
    actor: SUPERVISOR_ACTOR,
  });
}

export async function runItem(deps: RunItemDeps): Promise<RunItemResult> {
  const budgetLimits: BudgetLimits = {
    maxTurns: deps.config.budget.maxTurnsPerTask,
    maxWallSeconds: deps.config.budget.maxWallSecondsPerTask,
    maxUsd: deps.config.budget.maxUsdPerRun,
  };

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
        const next =
          state.status === 'parked'
            ? state
            : await appendAndFold(deps, state, {
                type: 'WorkItemParked',
                data: { reason: decision.reason, detail: decision.detail, resumable: true },
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
            data: { reason: 'awaiting-human', detail: `blocked on checkpoint ${decision.checkpoint}`, resumable: true },
            actor: SUPERVISOR_ACTOR,
          });
        }
        return finalize(deps, next, 'parked');
      }
      case 'run': {
        await performRunAttempt(deps, state, decision, budgetLimits);
        continue;
      }
      default:
        return assertNever(decision);
    }
  }
}
