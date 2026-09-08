import { assertNever } from '../core/events.js';
import type { MienguEvent } from '../core/events.js';
import { ProjectionError } from '../errors.js';
import { EMPTY_BUDGET_STATE, foldConsumed, foldExhausted } from '../supervisor/budget.js';
import { deterministicTaskOrder } from '../supervisor/escalation.js';
import { emptyAttempts, emptyQuotaAborts, nextStageInOrder, PROJECTION_VERSION } from './workitem.js';
import type { ArtifactRef, CheckpointStateRecord, WorkItemState, WorktreeLockState } from './workitem.js';
import type { EventId, TaskId } from '../core/ids.js';

function emptyCauseAttempts(): Record<'oracle' | 'test' | 'review' | 'reviewer' | 'planner' | 'architect' | 'analyst', number> {
  return { oracle: 0, test: 0, review: 0, reviewer: 0, planner: 0, architect: 0, analyst: 0 };
}

const ESCALATION_RANK = { coder: 0, reviewer: 1, planner: 2, architect: 3, analyst: 4, human: 5 } as const;
const ORACLE_ORDER = ['build', 'typecheck', 'lint', 'test'] as const;

function buildInitialState(event: Extract<MienguEvent, { type: 'WorkItemCreated' }>): WorkItemState {
  return {
    projectionVersion: PROJECTION_VERSION,
    itemId: event.item_id,
    slug: event.data.slug,
    seq: event.seq,
    lastEventId: event.event_id,
    priorEventIds: [event.event_id],
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
    artifacts: { requirementSet: null, architecturePlan: null, taskGraph: null, testSuiteSpec: null },
    taskGraphTaskIds: null,
    taskGraphDependencies: null,
    tasks: null,
    activeCauseId: null,
    causes: {},
    invalidatedEventIds: [],
    lastInvalidation: null,
    oracleSweeps: {},
    workspaceCheckpoints: {},
    integration: { status: 'pending', sweepId: null, finalPatch: null },
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
    priorEventIds: [
      ...(state.priorEventIds ?? (state.lastEventId === null ? [] : [state.lastEventId])),
      event.event_id,
    ],
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
        stage: 'done',
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
      const stage = ['implementation', 'review', 'integration'].includes(event.data.stage)
        ? base.stage : nextStageInOrder(event.data.stage);
      if (artifact === null) {
        return { ...base, stage };
      }
      const activeKey = event.data.stage === 'analysis' ? 'requirementSet'
        : event.data.stage === 'architecture' ? 'architecturePlan'
          : event.data.stage === 'planning' ? 'taskGraph'
            : event.data.stage === 'test-authoring' ? 'testSuiteSpec' : null;
      if (activeKey === null) {
        if ((event.data.stage === 'implementation' || event.data.stage === 'review') && base.tasks?.currentTaskId !== null && base.tasks !== null) {
          const taskId = base.tasks.currentTaskId;
          const record = base.tasks.records[taskId];
          if (record === undefined) throw new ProjectionError(`active task "${taskId}" is missing`);
          const ref = { kind: artifact.kind, sha256: artifact.sha256, stage: event.data.stage, eventId: event.event_id, seq: event.seq };
          const isReview = event.data.stage === 'review';
          const reviewAccepted = isReview && artifact.body !== null && typeof artifact.body === 'object' &&
            (artifact.body as { verdict?: unknown }).verdict === 'accept';
          return { ...base, stage, tasks: { ...base.tasks, records: { ...base.tasks.records, [taskId]: { ...record, [isReview ? 'review' : 'implementation']: ref, ...(isReview ? { reviewAccepted } : {}) } } } };
        }
        return { ...base, stage };
      }
      const taskGraphTaskIds = event.data.stage === 'planning'
        ? ((artifact.body as { tasks?: readonly { task_id: TaskId }[] }).tasks?.map((task) => task.task_id) ?? null)
        : base.taskGraphTaskIds;
      const taskGraphDependencies = event.data.stage === 'planning'
        ? (() => {
            const tasks = (artifact.body as { tasks?: readonly { task_id: TaskId; depends_on?: readonly TaskId[] }[] }).tasks;
            if (tasks === undefined) return null;
            return Object.fromEntries(tasks.map((task) => [task.task_id, task.depends_on ?? []]));
          })()
        : base.taskGraphDependencies;
      return {
        ...base,
        stage,
        taskGraphTaskIds,
        taskGraphDependencies,
        artifacts: {
          ...base.artifacts,
          [activeKey]: {
            kind: artifact.kind,
            sha256: artifact.sha256,
            stage: event.data.stage,
            eventId: event.event_id,
            seq: event.seq,
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
    case 'TaskGraphActivated': {
      if (base.artifacts.taskGraph?.eventId !== event.data.graph_event_id) throw new ProjectionError('TaskGraphActivated must reference the active task graph');
      if (base.tasks !== null) throw new ProjectionError('task graph is already activated');
      const ordered = event.data.ordered_task_ids;
      if (new Set(ordered).size !== ordered.length) throw new ProjectionError('TaskGraphActivated task order contains duplicate task ids');
      if (base.taskGraphTaskIds === null || ordered.length !== base.taskGraphTaskIds.length || ordered.some((id) => !base.taskGraphTaskIds!.includes(id))) throw new ProjectionError('TaskGraphActivated order does not exactly cover the task graph');
      if (base.taskGraphDependencies === null) throw new ProjectionError('TaskGraphActivated has no retained task dependencies');
      let canonical: readonly TaskId[];
      try {
        canonical = deterministicTaskOrder(base.taskGraphTaskIds.map((task_id) => ({ task_id, depends_on: base.taskGraphDependencies![task_id] ?? [] })));
      } catch (error) {
        throw new ProjectionError(`TaskGraphActivated cannot order its task graph: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (ordered.length !== canonical.length || ordered.some((taskId, index) => taskId !== canonical[index])) throw new ProjectionError('TaskGraphActivated order is not the deterministic topological order');
      const records = Object.fromEntries(event.data.ordered_task_ids.map((taskId, orderIndex) => [taskId, { taskId, orderIndex, status: 'pending' as const, implementation: null, review: null, reviewAccepted: null, acceptedAt: null, checkpoint: null }]));
      return { ...base, tasks: { taskGraphEventId: event.data.graph_event_id, activationEventId: event.event_id, order: event.data.ordered_task_ids, currentTaskId: null, records } };
    }
    case 'TaskStarted': {
      const tasks = base.tasks;
      if (tasks === null || tasks.taskGraphEventId !== event.data.graph_event_id) throw new ProjectionError('TaskStarted references an inactive task graph');
      if (tasks.currentTaskId !== null) throw new ProjectionError('cannot start a task while another task is active');
      const expected = tasks.order[event.data.order_index];
      if (expected !== event.data.task_id) throw new ProjectionError('TaskStarted is not in deterministic task order');
      if (tasks.order.slice(0, event.data.order_index).some((id) => tasks.records[id]?.status !== 'accepted')) throw new ProjectionError('TaskStarted has unresolved dependencies');
      const record = tasks.records[event.data.task_id];
      if (record === undefined || record.status !== 'pending') throw new ProjectionError('TaskStarted must select a pending task');
      return { ...base, tasks: { ...tasks, currentTaskId: event.data.task_id, records: { ...tasks.records, [event.data.task_id]: { ...record, status: 'active' } } } };
    }
    case 'TaskAccepted': {
      const tasks = base.tasks; const taskId = event.data.task_id;
      const record = tasks?.records[taskId];
      if (record?.status === 'accepted') throw new ProjectionError('TaskAccepted cannot accept an already accepted task');
      if (tasks === null || record === undefined || tasks.currentTaskId !== taskId || record.status !== 'active') throw new ProjectionError('TaskAccepted requires the current active task');
      if (record.implementation?.eventId !== event.data.implementation_event_id || record.review?.eventId !== event.data.review_event_id) throw new ProjectionError('TaskAccepted references inactive task artifacts');
      if (record.reviewAccepted !== true) throw new ProjectionError('TaskAccepted requires an accepting ReviewVerdict');
      if (base.activeCauseId !== null) throw new ProjectionError('TaskAccepted cannot bypass an active failure cause');
      const sweep = base.oracleSweeps[event.data.oracle_sweep_id]; const checkpoint = base.workspaceCheckpoints[event.data.checkpoint_event_id];
      const latestForImplementation = Object.values(base.oracleSweeps)
        .filter((candidate) => candidate.scope === 'task' && candidate.taskId === taskId && candidate.implementationEventId === record.implementation?.eventId)
        .at(-1);
      if (sweep === undefined || sweep !== latestForImplementation || sweep.scope !== 'task' || sweep.taskId !== taskId || sweep.implementationEventId !== record.implementation.eventId || sweep.outcome !== 'passed' || checkpoint === undefined || checkpoint.kind !== 'task-accepted' || checkpoint.taskId !== taskId || checkpoint.patch === null) throw new ProjectionError('TaskAccepted requires its current implementation\'s latest completed passing sweep and accepted checkpoint with patch evidence');
      const implementationSeq = record.implementation.seq;
      const reviewSeq = record.review.seq;
      const sweepCompletedSeq = sweep.completedSeq;
      const checkpointSeq = checkpoint.seq;
      if (
        implementationSeq === undefined || reviewSeq === undefined || sweepCompletedSeq === undefined || checkpointSeq === undefined ||
        sweepCompletedSeq <= implementationSeq || reviewSeq <= sweepCompletedSeq || checkpointSeq <= reviewSeq ||
        event.causation_id !== checkpoint.eventId
      ) throw new ProjectionError('TaskAccepted requires a checkpoint causally created after its implementation, passing sweep, and review');
      return { ...base, tasks: { ...tasks, currentTaskId: null, records: { ...tasks.records, [taskId]: { ...record, status: 'accepted', acceptedAt: event.ts, checkpoint } } } };
    }
    case 'FailureCauseOpened': {
      if (base.activeCauseId !== null) throw new ProjectionError('only one failure cause may be active');
      if (!(state.priorEventIds ?? (state.lastEventId === null ? [] : [state.lastEventId])).includes(event.data.trigger_event_id)) {
        throw new ProjectionError('FailureCauseOpened trigger_event_id must reference an existing prior event');
      }
      if (event.data.parent_cause_id !== null && base.causes[event.data.parent_cause_id] === undefined) throw new ProjectionError('FailureCauseOpened parent cause is unknown');
      const cause = { causeId: event.event_id, triggerEventId: event.data.trigger_event_id, parentCauseId: event.data.parent_cause_id, kind: event.data.kind, taskId: event.data.task_id, status: event.data.initial_level === 'human' ? 'human' as const : 'active' as const, level: event.data.initial_level, affects: { reqIds: event.data.affects.req_ids, componentIds: event.data.affects.component_ids, taskIds: event.data.affects.task_ids }, attempts: emptyCauseAttempts(), exhausted: [], openedAt: event.ts, resolvedAt: null };
      return { ...base, activeCauseId: event.event_id, causes: { ...base.causes, [event.event_id]: cause } };
    }
    case 'FailureAttempted': {
      const cause = base.causes[event.data.cause_id];
      if (cause === undefined || base.activeCauseId !== event.data.cause_id || cause.status !== 'active') throw new ProjectionError('FailureAttempted requires active cause');
      if (cause.level !== event.data.level || cause.taskId !== event.data.task_id || event.data.attempt !== cause.attempts[event.data.bucket] + 1) throw new ProjectionError('FailureAttempted is not contiguous for its cause');
      return { ...base, causes: { ...base.causes, [cause.causeId]: { ...cause, attempts: { ...cause.attempts, [event.data.bucket]: event.data.attempt } } } };
    }
    case 'EscalationAdvanced': {
      const cause = base.causes[event.data.cause_id];
      if (cause === undefined || base.activeCauseId !== cause.causeId || cause.level !== event.data.from_level || cause.taskId !== event.data.task_id || ESCALATION_RANK[event.data.to_level] <= ESCALATION_RANK[event.data.from_level]) throw new ProjectionError('EscalationAdvanced must strictly increase the active cause rank');
      return { ...base, causes: { ...base.causes, [cause.causeId]: { ...cause, level: event.data.to_level, status: event.data.to_level === 'human' ? 'human' : 'active', exhausted: cause.exhausted.includes(event.data.exhausted_bucket) ? cause.exhausted : [...cause.exhausted, event.data.exhausted_bucket] } } };
    }
    case 'FailureCauseResolved': {
      const cause = base.causes[event.data.cause_id];
      if (cause === undefined || base.activeCauseId !== cause.causeId || cause.taskId !== event.data.task_id) throw new ProjectionError('FailureCauseResolved requires the active matching cause');
      return { ...base, activeCauseId: null, causes: { ...base.causes, [cause.causeId]: { ...cause, status: 'resolved', resolvedAt: event.ts } } };
    }
    case 'ArtifactsInvalidated': {
      const cause = base.causes[event.data.cause_id];
      if (cause === undefined || base.activeCauseId !== cause.causeId || cause.status !== 'active' || cause.level !== event.data.target) {
        throw new ProjectionError('ArtifactsInvalidated requires the currently active matching cause');
      }
      const taskIds = event.data.affected_ids.task_ids;
      if (new Set(taskIds).size !== taskIds.length || taskIds.some((taskId) => base.tasks?.records[taskId] === undefined) || (cause.taskId !== null && !taskIds.includes(cause.taskId))) {
        throw new ProjectionError('ArtifactsInvalidated task ids must be a valid active task set containing the cause task');
      }
      const activeTaskArtifactIds: EventId[] = [];
      if (base.tasks !== null) {
        for (const task of Object.values(base.tasks.records)) {
          if (task.implementation !== null) activeTaskArtifactIds.push(task.implementation.eventId);
          if (task.review !== null) activeTaskArtifactIds.push(task.review.eventId);
        }
      }
      const activeArtifactIds = new Set<EventId>([
        ...[
          base.artifacts.requirementSet,
          base.artifacts.architecturePlan,
          base.artifacts.taskGraph,
          base.artifacts.testSuiteSpec,
        ].flatMap((artifact) => artifact === null ? [] : [artifact.eventId]),
        ...activeTaskArtifactIds,
      ]);
      if (new Set(event.data.artifact_event_ids).size !== event.data.artifact_event_ids.length || event.data.artifact_event_ids.some((id) => !activeArtifactIds.has(id))) {
        throw new ProjectionError('ArtifactsInvalidated artifact_event_ids must reference currently active artifacts');
      }
      const ids = new Set(event.data.artifact_event_ids);
      const clear = (ref: ArtifactRef | null): ArtifactRef | null => ref !== null && ids.has(ref.eventId) ? null : ref;
      let tasks = base.tasks;
      if (tasks !== null) {
        const records = { ...tasks.records };
        for (const taskId of event.data.affected_ids.task_ids) {
          const record = records[taskId];
          if (record !== undefined) records[taskId] = { ...record, status: 'pending', implementation: null, review: null, reviewAccepted: null, acceptedAt: null, checkpoint: null };
        }
        tasks = { ...tasks, currentTaskId: event.data.affected_ids.task_ids.includes(tasks.currentTaskId as never) ? null : tasks.currentTaskId, records };
      }
      const taskGraphInvalidated = base.artifacts.taskGraph !== null && ids.has(base.artifacts.taskGraph.eventId);
      const invalidatesTests = event.data.target === 'architect' || event.data.target === 'analyst';
      const workspaceCheckpoints = invalidatesTests
        ? Object.fromEntries(Object.entries(base.workspaceCheckpoints).filter(([, checkpoint]) => checkpoint.kind !== 'tests-frozen'))
        : base.workspaceCheckpoints;
      return { ...base, artifacts: { requirementSet: clear(base.artifacts.requirementSet), architecturePlan: clear(base.artifacts.architecturePlan), taskGraph: clear(base.artifacts.taskGraph), testSuiteSpec: clear(base.artifacts.testSuiteSpec) }, taskGraphTaskIds: taskGraphInvalidated ? null : base.taskGraphTaskIds, taskGraphDependencies: taskGraphInvalidated ? null : base.taskGraphDependencies, tasks: taskGraphInvalidated ? null : tasks, frozenTests: invalidatesTests ? null : base.frozenTests, workspaceCheckpoints, invalidatedEventIds: [...base.invalidatedEventIds, ...event.data.artifact_event_ids], lastInvalidation: { causeId: event.data.cause_id, target: event.data.target, taskIds: event.data.affected_ids.task_ids }, integration: invalidatesTests ? { status: 'pending', sweepId: null, finalPatch: null } : base.integration };
    }
    case 'OracleSweepStarted': {
      if (base.oracleSweeps[event.event_id] !== undefined) throw new ProjectionError('duplicate oracle sweep id');
      if ((event.data.scope === 'task') !== (event.data.task_id !== null)) throw new ProjectionError('task oracle sweeps require exactly one task id');
      if (event.data.scope === 'integration' && event.data.task_id !== null) throw new ProjectionError('integration oracle sweeps cannot name a task');
      if (event.data.cause_id !== null && base.causes[event.data.cause_id] === undefined) throw new ProjectionError('OracleSweepStarted references unknown cause');
      const implementationEventId = event.data.scope === 'task'
        ? base.tasks?.records[event.data.task_id as TaskId]?.implementation?.eventId ?? null
        : null;
      if (event.data.scope === 'task' && implementationEventId === null) throw new ProjectionError('task oracle sweep requires the active task implementation');
      if (event.data.commands.length !== ORACLE_ORDER.length || event.data.commands.some((command, index) => command.kind !== ORACLE_ORDER[index])) {
        throw new ProjectionError('OracleSweepStarted must declare the complete fixed build -> typecheck -> lint -> test order');
      }
      if (event.data.commands.some((command) =>
        (command.command === null) !== (command.sha256 === null),
      )) {
        throw new ProjectionError('OracleSweepStarted command hashes must exactly represent configured or skipped commands');
      }
      return { ...base, oracleSweeps: { ...base.oracleSweeps, [event.event_id]: { sweepId: event.event_id, scope: event.data.scope, taskId: event.data.task_id, commands: event.data.commands, implementationEventId, causeId: event.data.cause_id, resultEventIds: [], results: [], outcome: 'running', failedKind: null } }, integration: event.data.scope === 'integration' ? { ...base.integration, status: 'running', sweepId: event.event_id } : base.integration };
    }
    case 'OracleResultRecorded': {
      const sweep = base.oracleSweeps[event.data.sweep_id];
      if (sweep === undefined || sweep.outcome !== 'running' || sweep.scope !== event.data.scope || sweep.taskId !== event.data.task_id || sweep.resultEventIds.includes(event.event_id) || sweep.results.some((result) => result.kind === event.data.kind)) throw new ProjectionError('OracleResultRecorded references an incompatible or completed sweep');
      // Keep this runtime guard even though the v3 parser rejects nulls: projections may be
      // invoked on a value already parsed by an older boundary or deliberately tampered in
      // memory, and evidence is part of the event's durable meaning.
      if (event.data.stdout === null || event.data.stderr === null) throw new ProjectionError('OracleResultRecorded requires durable stdout and stderr evidence');
      if (sweep.results.some((result) => result.status !== 'passed')) throw new ProjectionError('OracleResultRecorded cannot follow a non-passing oracle result');
      const declaration = sweep.commands.filter((command) => command.command !== null)[sweep.results.length];
      if (declaration === undefined || declaration.kind !== event.data.kind || declaration.command !== event.data.command || declaration.sha256 !== event.data.command_sha256) throw new ProjectionError('OracleResultRecorded must match the next declared oracle command exactly');
      const result = { eventId: event.event_id, kind: event.data.kind, status: event.data.status, command: event.data.command, commandSha256: event.data.command_sha256, exitCode: event.data.exit_code, signal: event.data.signal, durationMs: event.data.duration_ms, stdout: event.data.stdout, stderr: event.data.stderr };
      return { ...base, oracleSweeps: { ...base.oracleSweeps, [sweep.sweepId]: { ...sweep, resultEventIds: [...sweep.resultEventIds, event.event_id], results: [...sweep.results, result] } } };
    }
    case 'OracleSweepCompleted': {
      const sweep = base.oracleSweeps[event.data.sweep_id];
      const idsMatch = sweep !== undefined && event.data.result_event_ids.length === sweep.resultEventIds.length && event.data.result_event_ids.every((id, i) => sweep.resultEventIds[i] === id);
      if (sweep === undefined || sweep.outcome !== 'running' || sweep.scope !== event.data.scope || sweep.taskId !== event.data.task_id || !idsMatch) throw new ProjectionError('OracleSweepCompleted has invalid result refs');
      const failed = event.data.failed_kind === null ? null : sweep.results.find((result) => result.kind === event.data.failed_kind);
      const declaredResultCount = sweep.commands.filter((command) => command.command !== null).length;
      const firstNonPass = sweep.results.find((result) => result.status !== 'passed');
      const last = sweep.results.at(-1);
      if (
        (event.data.outcome === 'passed' && (event.data.failed_kind !== null || sweep.results.length !== declaredResultCount || firstNonPass !== undefined)) ||
        (event.data.outcome === 'failed' && (firstNonPass === undefined || firstNonPass.status === 'aborted' || firstNonPass !== last || failed !== firstNonPass)) ||
        (event.data.outcome === 'aborted' && (event.data.failed_kind !== null || (firstNonPass !== undefined && (firstNonPass.status !== 'aborted' || firstNonPass !== last))))
      ) throw new ProjectionError('OracleSweepCompleted outcome is inconsistent with the exact executed oracle prefix');
      const outcome = event.data.outcome;
      return { ...base, oracleSweeps: { ...base.oracleSweeps, [sweep.sweepId]: { ...sweep, outcome, failedKind: event.data.failed_kind, completedSeq: event.seq } }, integration: sweep.scope === 'integration' ? { ...base.integration, status: outcome === 'passed' ? 'passed' : 'failed' } : base.integration };
    }
    case 'WorkspaceCheckpointed': {
      if (event.data.kind === 'task-accepted' && (event.data.task_id === null || event.data.patch === null)) throw new ProjectionError('task-accepted checkpoints require a task id and patch evidence');
      const checkpoint = { eventId: event.event_id, kind: event.data.kind, taskId: event.data.task_id, parentCommit: event.data.parent_commit, commit: event.data.commit, patch: event.data.patch, seq: event.seq };
      return { ...base, workspaceCheckpoints: { ...base.workspaceCheckpoints, [event.event_id]: checkpoint } };
    }
    case 'WorkspaceRestored': {
      const cause = base.causes[event.data.cause_id];
      if (cause === undefined || base.activeCauseId !== cause.causeId || cause.level !== event.data.target || base.lastInvalidation?.causeId !== cause.causeId || base.lastInvalidation.target !== event.data.target) throw new ProjectionError('WorkspaceRestored requires the active matching invalidation cause');
      const frozen = base.workspaceCheckpoints[event.data.base_checkpoint_event_id];
      if (frozen === undefined || frozen.kind !== 'tests-frozen' || frozen.taskId !== null || frozen.parentCommit !== event.data.base_commit) throw new ProjectionError('WorkspaceRestored base checkpoint or commit is invalid');
      const invalidated = new Set(event.data.invalidated_task_ids);
      if (invalidated.size !== event.data.invalidated_task_ids.length || event.data.invalidated_task_ids.length !== base.lastInvalidation.taskIds.length || event.data.invalidated_task_ids.some((taskId, index) => taskId !== base.lastInvalidation!.taskIds[index])) throw new ProjectionError('WorkspaceRestored invalidated task set does not match the invalidation');
      const records = base.tasks?.records ?? {};
      if (base.tasks !== null) {
        for (const taskId of invalidated) {
          const record = records[taskId];
          if (record === undefined || record.status !== 'pending' || record.implementation !== null || record.review !== null || record.checkpoint !== null) throw new ProjectionError('WorkspaceRestored invalidated task set does not match invalidated records');
        }
      }
      const retained = new Map(event.data.retained_task_commits.map((entry) => [entry.task_id, entry.commit]));
      if (retained.size !== event.data.retained_task_commits.length || [...retained.values()].some((commit) => commit.length === 0)) throw new ProjectionError('WorkspaceRestored retained task commits are invalid');
      const acceptedCheckpoints = Object.values(base.workspaceCheckpoints).filter((checkpoint) => checkpoint.kind === 'task-accepted');
      if (acceptedCheckpoints.some((checkpoint) => checkpoint.taskId === null || checkpoint.patch === null)) throw new ProjectionError('WorkspaceRestored cannot use an accepted checkpoint without patch evidence');
      const expectedRetained = [...new Set(acceptedCheckpoints.filter((checkpoint) => !invalidated.has(checkpoint.taskId!)).map((checkpoint) => checkpoint.taskId!))].sort();
      const restoredRetained = [...retained.keys()].sort();
      if (expectedRetained.length !== restoredRetained.length || expectedRetained.some((taskId, index) => taskId !== restoredRetained[index])) throw new ProjectionError('WorkspaceRestored retained task mappings do not match accepted checkpoints');
      return base;
    }
    case 'FinalPatchCaptured': {
      const tasks = base.tasks;
      const sweep = base.integration.sweepId === null ? undefined : base.oracleSweeps[base.integration.sweepId];
      if (tasks === null || tasks.currentTaskId !== null || Object.values(tasks.records).some((task) => task.status !== 'accepted')) {
        throw new ProjectionError('FinalPatchCaptured requires all tasks accepted');
      }
      if (base.integration.status !== 'passed' || sweep?.scope !== 'integration' || sweep.outcome !== 'passed') {
        throw new ProjectionError('FinalPatchCaptured requires the current integration sweep to be completed and passed');
      }
      return { ...base, integration: { ...base.integration, finalPatch: event.data.patch } };
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
