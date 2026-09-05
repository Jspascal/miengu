import { assertNever } from '../core/events.js';
import type { MienguEvent } from '../core/events.js';
import { ProjectionError } from '../errors.js';
import { EMPTY_BUDGET_STATE, foldConsumed, foldExhausted } from '../supervisor/budget.js';
import { emptyAttempts, emptyQuotaAborts, nextStageInOrder, PROJECTION_VERSION } from './workitem.js';
import type { CheckpointStateRecord, WorkItemState, WorktreeLockState } from './workitem.js';

function buildInitialState(event: Extract<MienguEvent, { type: 'WorkItemCreated' }>): WorkItemState {
  return {
    projectionVersion: PROJECTION_VERSION,
    itemId: event.item_id,
    slug: event.data.slug,
    seq: event.seq,
    lastEventId: event.event_id,
    createdAt: event.ts,
    updatedAt: event.ts,
    title: event.data.title,
    source: event.data.source,
    configHash: event.data.config_hash,
    status: 'active',
    stage: 'intake',
    stageEnteredAt: null,
    attempts: emptyAttempts(),
    failures: [],
    park: null,
    budget: EMPTY_BUDGET_STATE,
    quotaAborts: emptyQuotaAborts(),
    worktreeLock: null,
    frozenTests: null,
    validationFailures: [],
    itemArtifacts: [],
    workspace: null,
    lastExecutor: null,
    lastDiff: null,
    artifacts: {},
    checkpoints: {},
    assumptions: [],
    drift: [],
    tampering: [],
    runs: [],
  };
}

/**
 * `applyEvent(null, e)` requires `e.type === 'WorkItemCreated'` and `e.seq === 1`, else
 * `ProjectionError`. `applyEvent(s, e)` requires `e.seq === s.seq + 1` and
 * `e.item_id === s.itemId`, else `ProjectionError`. Never mutates `state`; always returns a
 * new object.
 */
export function applyEvent(state: WorkItemState | null, event: MienguEvent): WorkItemState {
  if (state === null) {
    if (event.type !== 'WorkItemCreated') {
      throw new ProjectionError(
        `the first event applied to a null state must be WorkItemCreated, got "${event.type}"`,
      );
    }
    if (event.seq !== 1) {
      throw new ProjectionError(
        `the first event applied to a null state must have seq 1, got ${String(event.seq)}`,
      );
    }
    return buildInitialState(event);
  }

  if (event.seq !== state.seq + 1) {
    throw new ProjectionError(
      `event seq ${String(event.seq)} is not contiguous with state seq ${String(state.seq)}`,
    );
  }
  if (event.item_id !== state.itemId) {
    throw new ProjectionError(
      `event item_id "${event.item_id}" does not match state itemId "${state.itemId}"`,
    );
  }

  const base: WorkItemState = {
    ...state,
    seq: event.seq,
    lastEventId: event.event_id,
    updatedAt: event.ts,
  };

  switch (event.type) {
    case 'WorkItemCreated': {
      return base;
    }
    case 'WorkItemParked': {
      return {
        ...base,
        status: 'parked',
        park: {
          reason: event.data.reason,
          detail: event.data.detail,
          since: event.ts,
          resumable: event.data.resumable,
          account: event.data.account,
          resetsAt: event.data.resets_at,
        },
      };
    }
    case 'WorkItemResumed': {
      return {
        ...base,
        status: 'active',
        park: null,
        budget: foldExhausted(base.budget, event.data.account, null),
      };
    }
    case 'WorkItemCompleted': {
      return {
        ...base,
        status: 'completed',
      };
    }
    case 'WorkItemFailed': {
      return {
        ...base,
        status: 'failed',
      };
    }
    case 'RunStarted': {
      return {
        ...base,
        runs: [
          ...base.runs,
          { runId: event.run_id, startedAt: event.ts, finishedAt: null, outcome: null },
        ],
      };
    }
    case 'RunFinished': {
      return {
        ...base,
        runs: base.runs.map((run) =>
          run.runId === event.run_id
            ? { ...run, finishedAt: event.ts, outcome: event.data.outcome }
            : run,
        ),
      };
    }
    case 'StageEntered': {
      const stage = event.data.stage;
      return {
        ...base,
        stage,
        stageEnteredAt: event.ts,
        attempts: { ...base.attempts, [stage]: base.attempts[stage] + 1 },
      };
    }
    case 'StageCompleted': {
      const artifact = event.data.artifact;
      const stage = nextStageInOrder(event.data.stage);
      if (artifact === null) {
        return { ...base, stage };
      }
      return {
        ...base,
        stage,
        artifacts: {
          ...base.artifacts,
          [event.data.stage]: {
            kind: artifact.kind,
            sha256: artifact.sha256,
            stage: event.data.stage,
            eventId: event.event_id,
          },
        },
      };
    }
    case 'StageFailed': {
      return {
        ...base,
        failures: [
          ...base.failures,
          {
            stage: event.data.stage,
            attempt: event.data.attempt,
            reason: event.data.reason,
            detail: event.data.detail,
            at: event.ts,
            eventId: event.event_id,
          },
        ],
      };
    }
    case 'ArtifactValidationFailed': {
      return {
        ...base,
        validationFailures: [
          ...base.validationFailures,
          {
            stage: event.data.stage,
            role: event.data.role,
            attempt: event.data.attempt,
            validationAttempt: event.data.validation_attempt,
            kind: event.data.kind,
            errors: event.data.errors,
            at: event.ts,
          },
        ],
      };
    }
    case 'WorkspacePrepared': {
      return {
        ...base,
        workspace: {
          mode: event.data.mode,
          targetRepo: event.data.target_repo,
          workdir: event.data.workdir,
          baseRef: event.data.base_ref,
          baseCommit: event.data.base_commit,
          discarded: false,
        },
      };
    }
    case 'WorkspaceDiscarded': {
      return {
        ...base,
        workspace: base.workspace === null ? null : { ...base.workspace, discarded: true },
      };
    }
    case 'WorktreeLockAcquired': {
      if (base.worktreeLock !== null) {
        throw new ProjectionError(
          `worktree lock at "${event.data.workdir}" already held by "${base.worktreeLock.holder}"; ` +
            `cannot re-acquire for "${event.data.holder}"`,
        );
      }
      const lock: WorktreeLockState = {
        holder: event.data.holder,
        workdir: event.data.workdir,
        stage: event.data.stage,
        intent: event.data.intent,
        since: event.ts,
      };
      return { ...base, worktreeLock: lock };
    }
    case 'WorktreeLockReleased': {
      if (base.worktreeLock === null) {
        throw new ProjectionError(
          `WorktreeLockReleased for "${event.data.workdir}" by "${event.data.holder}" but no lock is held`,
        );
      }
      if (event.data.holder !== base.worktreeLock.holder && !event.data.reclaimed) {
        throw new ProjectionError(
          `WorktreeLockReleased by "${event.data.holder}" does not match the current holder ` +
            `"${base.worktreeLock.holder}" and is not marked reclaimed`,
        );
      }
      return { ...base, worktreeLock: null };
    }
    case 'ExecutorInvoked': {
      return base;
    }
    case 'ExecutorReturned': {
      return {
        ...base,
        lastExecutor: {
          executorId: event.data.executor_id,
          executorType: event.data.executor_type,
          account: event.data.account,
          stage: event.data.stage,
          status: event.data.status,
          telemetry: {
            turns: event.data.telemetry.turns,
            inputTokens: event.data.telemetry.input_tokens,
            outputTokens: event.data.telemetry.output_tokens,
            cacheReadTokens: event.data.telemetry.cache_read_tokens,
            cacheCreationTokens: event.data.telemetry.cache_creation_tokens,
            wallSeconds: event.data.telemetry.wall_seconds,
          },
          at: event.ts,
        },
        quotaAborts:
          event.data.status === 'quota_exhausted'
            ? {
                ...base.quotaAborts,
                [event.data.stage]: base.quotaAborts[event.data.stage] + 1,
              }
            : base.quotaAborts,
      };
    }
    case 'DiffCaptured': {
      return {
        ...base,
        lastDiff: {
          sha256: event.data.diff_sha256,
          filesTouched: event.data.files_touched,
          untracked: event.data.untracked,
          insertions: event.data.insertions,
          deletions: event.data.deletions,
          committedDuringRun: event.data.committed_during_run,
        },
      };
    }
    case 'BudgetConsumed': {
      return {
        ...base,
        budget: foldConsumed(base.budget, event.data.account, {
          wallSeconds: event.data.wall_seconds,
          turns: event.data.turns,
          usd: event.data.usd,
        }),
      };
    }
    case 'BudgetExhausted': {
      return {
        ...base,
        budget: foldExhausted(base.budget, event.data.account, {
          scope: event.data.scope,
          limitKind: event.data.limit_kind,
          at: event.ts,
          resetsAt: event.data.resets_at,
          detail: event.data.detail,
        }),
      };
    }
    case 'CheckpointRaised': {
      const record: CheckpointStateRecord = {
        id: event.data.checkpoint,
        kind: event.data.kind,
        stage: event.data.stage,
        blocking: event.data.blocking,
        status: 'open',
        raisedAt: event.ts,
        resolvedAt: null,
        resolvedBy: null,
      };
      return {
        ...base,
        checkpoints: { ...base.checkpoints, [event.data.checkpoint]: record },
      };
    }
    case 'CheckpointDecided': {
      const existing = base.checkpoints[event.data.checkpoint];
      if (existing === undefined) {
        return base;
      }
      const updated: CheckpointStateRecord = {
        ...existing,
        status: event.data.decision === 'accept' ? 'accepted' : 'rejected',
        resolvedAt: event.ts,
        resolvedBy: 'human',
      };
      return {
        ...base,
        checkpoints: { ...base.checkpoints, [event.data.checkpoint]: updated },
      };
    }
    case 'AutoApproved': {
      const existing = base.checkpoints[event.data.checkpoint];
      if (existing === undefined) {
        return base;
      }
      const updated: CheckpointStateRecord = {
        ...existing,
        status: 'auto-approved',
        resolvedAt: event.ts,
        resolvedBy: 'auto',
      };
      return {
        ...base,
        checkpoints: { ...base.checkpoints, [event.data.checkpoint]: updated },
      };
    }
    case 'AssumptionRecorded': {
      return {
        ...base,
        assumptions: [
          ...base.assumptions,
          {
            id: event.data.id,
            question: event.data.question,
            chosen: event.data.chosen,
            alternatives: event.data.alternatives,
            affects: event.data.affects,
            depth: event.data.depth,
            at: event.ts,
          },
        ],
      };
    }
    case 'TestsFrozen': {
      if (base.frozenTests !== null && base.frozenTests.suiteId !== event.data.suite_id) {
        throw new ProjectionError(
          `tests already frozen for suite "${base.frozenTests.suiteId}"; ` +
            `cannot freeze a different suite "${event.data.suite_id}" for the remainder of the item`,
        );
      }
      return {
        ...base,
        frozenTests: {
          suiteId: event.data.suite_id,
          contentHash: event.data.content_hash,
          files: event.data.files,
          frozenCopyDir: event.data.frozen_copy_dir,
          at: event.ts,
        },
      };
    }
    case 'TestsTampered': {
      return {
        ...base,
        tampering: [
          ...base.tampering,
          {
            taskId: event.data.task_id,
            suiteId: event.data.suite_id,
            expectedHash: event.data.expected_hash,
            observedHash: event.data.observed_hash,
            paths: event.data.paths,
            restored: event.data.restored,
            at: event.ts,
          },
        ],
      };
    }
    case 'ItemArtifactRecorded': {
      return {
        ...base,
        itemArtifacts: [
          ...base.itemArtifacts,
          {
            role: event.data.role,
            stage: event.data.stage,
            artifactKind: event.data.artifact_kind,
            sha256: event.data.sha256,
            summary: event.data.summary,
            at: event.ts,
          },
        ],
      };
    }
    case 'DriftDetected': {
      return {
        ...base,
        drift: [
          ...base.drift,
          {
            claim: event.data.claim,
            expected: event.data.expected,
            observed: event.data.observed,
            area: event.data.area,
            at: event.ts,
          },
        ],
      };
    }
    default:
      return assertNever(event);
  }
}

export function project(events: Iterable<MienguEvent>, from?: WorkItemState): WorkItemState {
  let state: WorkItemState | null = from ?? null;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  if (state === null) {
    throw new ProjectionError('project() called with no events and no starting state');
  }
  return state;
}

export async function projectAsync(
  events: AsyncIterable<MienguEvent>,
  from?: WorkItemState,
): Promise<WorkItemState> {
  let state: WorkItemState | null = from ?? null;
  for await (const event of events) {
    state = applyEvent(state, event);
  }
  if (state === null) {
    throw new ProjectionError('projectAsync() called with no events and no starting state');
  }
  return state;
}
