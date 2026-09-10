import type { CheckpointId } from '../core/ids.js';
import type { AccountId } from '../core/ids.js';
import type { ParkReason, Stage } from '../core/events.js';
import type { EscalationLevel, FailureAttemptBucket } from '../core/events.js';
import { STAGE_ORDER, roleForStage } from '../state/workitem.js';
import type { WorkItemState } from '../state/workitem.js';
import { bucketLimit, nextEscalationLevel } from './escalation.js';

// The determinism-zone lint rule for this file restricts every `../config/*` import
// declaration, including `import type`, because the base ESLint rule cannot see TypeScript's
// `importKind`. An inline `import(...)` type reference is a `TSImportType`, not an
// `ImportDeclaration`, so it satisfies both the contract ("import the config type only, never
// the module") and the existing lint restriction without weakening either.
type MienguConfig = import('../config/schema.js').MienguConfig;

export interface AttemptLimits {
  readonly kOracle: number;
  readonly kTest: number;
  readonly kReview: number;
  readonly maxAttemptsPerStage: number;
}

export interface StagePolicy {
  readonly limits: AttemptLimits;
  readonly stageAccounts: Readonly<Record<Stage, AccountId | null>>;
}

export type SupervisorAction =
  | 'activate-task-graph'
  | 'checkpoint-tests'
  | 'start-task'
  | 'task-oracle'
  | 'review-task'
  | 'accept-task'
  | 'invalidate-artifacts'
  | 'advance-escalation'
  | 'integration-oracle'
  | 'capture-final-patch';

export type StageDecision =
  | {
      readonly kind: 'run';
      readonly stage: Stage;
      readonly attempt: number;
      readonly needsHuman: false;
      /** Present only for the Phase 3 supervisor path; Group F materializes it durably. */
      readonly action?: SupervisorAction;
      readonly taskId?: string | null;
      readonly causeId?: string | null;
      readonly level?: EscalationLevel;
      readonly bucket?: FailureAttemptBucket;
    }
  | {
      readonly kind: 'checkpoint';
      readonly stage: Stage;
      readonly checkpoint: CheckpointId;
      readonly needsHuman: true;
    }
  | {
      readonly kind: 'park';
      readonly reason: ParkReason;
      readonly detail: string;
      readonly account: AccountId | null;
    }
  | { readonly kind: 'done'; readonly outcome: 'completed' | 'failed' };

/**
 * `'review' -> kReview`; `'implementation' -> min(kOracle, kTest)`; everything else
 * -> `maxAttemptsPerStage`. (Phase 3 refines by failure cause; Phase 1 has no causes.)
 */
export function limitForStage(stage: Stage, policy: StagePolicy): number {
  if (stage === 'review') {
    return policy.limits.kReview;
  }
  if (stage === 'implementation') {
    return Math.min(policy.limits.kOracle, policy.limits.kTest);
  }
  return policy.limits.maxAttemptsPerStage;
}

/**
 * `max(0, attempts[stage] - quotaAborts[stage])`. The escalation-relevant attempt count
 * (binding decision 19): a quota wall discovered mid-stage burned a `StageEntered` but must
 * not count toward the stage's attempt limit.
 */
export function effectiveAttempts(state: WorkItemState, stage: Stage): number {
  return Math.max(0, state.attempts[stage] - state.quotaAborts[stage]);
}

function action(
  state: WorkItemState,
  kind: SupervisorAction,
  values: {
    readonly taskId?: string | null;
    readonly causeId?: string | null;
    readonly level?: EscalationLevel;
    readonly bucket?: FailureAttemptBucket;
    readonly stage?: Stage;
  } = {},
): StageDecision {
  return {
    kind: 'run',
    stage: values.stage ?? state.stage,
    attempt: 0,
    needsHuman: false,
    action: kind,
    ...values,
  };
}

function completedTaskSweep(
  state: WorkItemState,
  taskId: string,
  implementationEventId: string,
): 'passed' | 'failed' | null {
  const sweeps = Object.values(state.oracleSweeps)
    // Object insertion order is projection/event order. Event IDs are random and must never
    // be used to infer recency.
    .filter((sweep) => sweep.scope === 'task' && sweep.taskId === taskId && sweep.implementationEventId === implementationEventId && sweep.outcome !== 'running');
  const latest = sweeps.at(-1);
  if (latest === undefined || latest.outcome === 'aborted' || latest.outcome === 'running') return null;
  return latest.outcome;
}

function handlerStageForLevel(level: EscalationLevel): Stage | null {
  switch (level) {
    case 'coder': return 'implementation';
    case 'reviewer': return 'review';
    case 'planner': return 'planning';
    case 'architect': return 'architecture';
    case 'analyst': return 'analysis';
    case 'human': return null;
  }
}

function v3Decision(state: WorkItemState, policy: StagePolicy): StageDecision | null {
  const activeCauseId = state.activeCauseId ?? null;
  const activeCause = activeCauseId === null ? null : (state.causes ?? {})[activeCauseId] ?? null;
  // Escalation remains authoritative while an upstream handler has invalidated the graph.
  // Checking `tasks === null` first stranded Architect/Analyst causes in the legacy stage
  // limit guard instead of letting the finite ladder reach human.
  if (activeCause !== null) {
    if (activeCause.status === 'human' || activeCause.level === 'human') {
      return { kind: 'park', reason: 'awaiting-human', detail: `failure cause ${activeCause.causeId} reached human escalation`, account: null };
    }
    const bucket: FailureAttemptBucket =
      activeCause.level === 'coder'
        ? activeCause.kind === 'oracle' ? 'oracle' : activeCause.kind === 'test' ? 'test' : 'review'
        : activeCause.level;
    const used = activeCause.attempts[bucket];
    // A StageFailed can enter the Phase 3 ladder before its originating stage has exhausted
    // its configured retry budget. Once the ladder reaches that same handler again, do not
    // grant a surplus invocation: advance the active cause instead of falling back to a
    // legacy park. This retains causal routing while preserving the Phase 1/2 stage bound.
    const triggerFailure = state.failures.find((failure) => failure.eventId === activeCause.triggerEventId);
    const handlerStage = handlerStageForLevel(activeCause.level);
    if (
      triggerFailure !== undefined &&
      handlerStage === triggerFailure.stage &&
      effectiveAttempts(state, triggerFailure.stage) >= limitForStage(triggerFailure.stage, policy)
    ) {
      const next = nextEscalationLevel(activeCause.level);
      return next === null
        ? { kind: 'park', reason: 'awaiting-human', detail: `failure cause ${activeCause.causeId} reached human escalation`, account: null }
        : action(state, 'advance-escalation', { taskId: activeCause.taskId, causeId: activeCause.causeId, level: next, bucket });
    }
    if (activeCause.level === 'coder' && activeCause.taskId !== null && state.tasks !== null) {
      const task = state.tasks.records[activeCause.taskId];
      const latest = Object.values(state.oracleSweeps)
        .filter((sweep) => sweep.scope === 'task' && sweep.taskId === activeCause.taskId && sweep.implementationEventId === task?.implementation?.eventId)
        .at(-1);
      if (used > 0 && (latest === undefined || latest.causeId !== activeCause.causeId || latest.outcome === 'running')) {
        return action(state, 'task-oracle', { taskId: activeCause.taskId, causeId: activeCause.causeId });
      }
      if (latest?.causeId === activeCause.causeId && latest.outcome === 'passed') {
        // A non-accepting review is durable remediation failure, not an instruction to keep
        // retrying accept-task.  The completed Coder attempt already consumed this cause's
        // bucket; retry its invalidation or advance the finite ladder.
        if (task?.review !== null && task?.reviewAccepted !== true) {
          return used >= bucketLimit(bucket, policy.limits)
            ? action(state, 'advance-escalation', { taskId: activeCause.taskId, causeId: activeCause.causeId, level: nextEscalationLevel(activeCause.level)!, bucket })
            : action(state, 'invalidate-artifacts', { taskId: activeCause.taskId, causeId: activeCause.causeId, level: activeCause.level, bucket });
        }
        return task?.review === null
          ? action(state, 'review-task', { taskId: activeCause.taskId })
          : action(state, 'accept-task', { taskId: activeCause.taskId });
      }
    }
    if (used >= bucketLimit(bucket, policy.limits)) {
      const next = nextEscalationLevel(activeCause.level);
      return next === null
        ? { kind: 'park', reason: 'awaiting-human', detail: `failure cause ${activeCause.causeId} reached human escalation`, account: null }
        : action(state, 'advance-escalation', { taskId: activeCause.taskId, causeId: activeCause.causeId, level: next, bucket });
    }
    return action(state, 'invalidate-artifacts', { taskId: activeCause.taskId, causeId: activeCause.causeId, level: activeCause.level, bucket });
  }
  // A completed test-authoring artifact activates the v3 task runtime. Keeping the old path
  // when no task graph exists preserves replay of Phase 1/2 snapshots and table rows.
  if (state.tasks === null || state.tasks === undefined) {
    if (state.artifacts.taskGraph !== null && state.artifacts.taskGraph !== undefined) {
      return action(state, 'activate-task-graph');
    }
    // An accepted upstream remediation invalidates the graph and then re-enters its normal
    // stage sequence. Those regenerated stages must not inherit the old global stage quota;
    // their finite bound is the causal ladder that led here.
    if (((state.frozenTests !== null && state.frozenTests !== undefined) || (state.lastInvalidation ?? null) !== null) && state.stage !== 'done') {
      return {
        kind: 'run',
        stage: state.stage,
        attempt: effectiveAttempts(state, state.stage) + 1,
        needsHuman: false,
      };
    }
    return null;
  }
  if (state.frozenTests === null || state.frozenTests === undefined) {
    return (state.lastInvalidation ?? null) === null
      ? null
      : {
          kind: 'run',
          stage: state.stage,
          attempt: effectiveAttempts(state, state.stage) + 1,
          needsHuman: false,
        };
  }
  if (!Object.values(state.workspaceCheckpoints ?? {}).some((checkpoint) => checkpoint.kind === 'tests-frozen')) {
    return action(state, 'checkpoint-tests');
  }

  const currentTaskId = state.tasks.currentTaskId;
  if (currentTaskId === null) {
    const pending = state.tasks.order.find((id) => state.tasks?.records[id]?.status === 'pending');
    if (pending !== undefined) return action(state, 'start-task', { taskId: pending });
    if (state.integration.status === 'pending' || state.integration.status === 'failed') return action(state, 'integration-oracle');
    if (state.integration.status === 'passed' && state.integration.finalPatch === null) return action(state, 'capture-final-patch');
    return state.integration.finalPatch === null
      ? action(state, 'integration-oracle')
      : { kind: 'done', outcome: 'completed' };
  }

  const task = state.tasks.records[currentTaskId];
  if (task === undefined) return null;
  if (task.implementation === null) {
    return { kind: 'run', stage: 'implementation', attempt: effectiveAttempts(state, 'implementation') + 1, needsHuman: false };
  }
  const sweep = completedTaskSweep(state, currentTaskId, task.implementation.eventId);
  if (sweep === null || sweep === 'failed') return action(state, 'task-oracle', { taskId: currentTaskId, causeId: null });
  if (task.review === null) {
    return action(state, 'review-task', { taskId: currentTaskId });
  }
  return action(state, 'accept-task', { taskId: currentTaskId });
}

/**
 * Decision precedence — this exact order is the contract and is table-tested. Pure, total,
 * synchronous. Never throws for any `WorkItemState` value.
 */
export function nextStage(state: WorkItemState, policy: StagePolicy): StageDecision {
  // 1. status === 'completed' -> done('completed')
  if (state.status === 'completed') {
    return { kind: 'done', outcome: 'completed' };
  }

  // 2. status === 'failed' -> done('failed')
  if (state.status === 'failed') {
    return { kind: 'done', outcome: 'failed' };
  }

  // 3. status === 'parked' -> park(park.reason, park.detail, park.account)
  if (state.status === 'parked') {
    // Defensive fallback only: the projector never sets status:'parked' without a park
    // record, but nextStage must never throw for any WorkItemState value.
    const reason = state.park?.reason ?? 'attempts-exhausted';
    const detail = state.park?.detail ?? '';
    const account = state.park?.account ?? null;
    return { kind: 'park', reason, detail, account };
  }

  // 4. budget.itemExhausted !== null -> park(reason, detail, null) where reason is
  //    'provider-quota' if limitKind === 'provider-quota', else 'budget-exhausted'.
  //    detail is byte-identical to Phase 1.
  if (state.budget.itemExhausted !== null) {
    const reason: ParkReason =
      state.budget.itemExhausted.limitKind === 'provider-quota'
        ? 'provider-quota'
        : 'budget-exhausted';
    return {
      kind: 'park',
      reason,
      detail: `budget exhausted: scope=${state.budget.itemExhausted.scope} limitKind=${state.budget.itemExhausted.limitKind}`,
      account: null,
    };
  }

  // 5. stage === 'done' -> done('completed')
  if (state.stage === 'done') {
    return { kind: 'done', outcome: 'completed' };
  }

  // 6. any blocking checkpoint with status === 'open' -> checkpoint(stage, id) (lowest id).
  // WORK_ORDER_PHASE5.md binding decision 17: ids compare as strings, so once an item passes
  // nine checkpoints the "lowest id" is lexicographic, not numeric — `cp-x-10` sorts before
  // `cp-x-9`. This is cosmetic: the guard only chooses which blocking checkpoint to name in
  // the park decision, and every blocking checkpoint must be resolved, regardless of which one
  // is named, before the item can advance. Left as-is and pinned by
  // `test/golden/nextStage.phase5.table.json` so it is not "fixed" silently later. Also kind-
  // agnostic: an `assumption-gate` or `escalation` checkpoint blocks exactly as `irreversible`
  // does, because `blocking` — not `kind` — is what this guard reads.
  let lowestOpenBlocking: CheckpointId | null = null;
  for (const record of Object.values(state.checkpoints)) {
    if (!record.blocking || record.status !== 'open') {
      continue;
    }
    if (lowestOpenBlocking === null || record.id < lowestOpenBlocking) {
      lowestOpenBlocking = record.id;
    }
  }
  if (lowestOpenBlocking !== null) {
    return {
      kind: 'checkpoint',
      stage: state.stage,
      checkpoint: lowestOpenBlocking,
      needsHuman: true,
    };
  }

  // 7. a = policy.stageAccounts[stage]; a !== null; budget.accounts[a].exhausted !== null
  //    -> park(reason, detail, a). Branches on limitKind exactly as guard 4 does: an
  //    account-scoped ledger overrun ('turns' | 'wall' | 'usd') is a BUDGET exhaustion, not a
  //    provider window. Reporting it as 'provider-quota' told the operator to wait for a
  //    window that was never the problem, and inverted §17.3's park-and-resume vs. escalate
  //    distinction — a spend cap does not clear on its own.
  // WORK_ORDER_PHASE5.md binding decision 14: the drain's run-scoped `blockedAccounts` gate is
  // re-checked immediately before each backlog entry runs, keyed by this same
  // `policy.stageAccounts[state.stage]` value, so the two can never disagree about which
  // account a stage needs.
  const account = policy.stageAccounts[state.stage];
  if (account !== null) {
    const accountExhaustion = state.budget.accounts[account]?.exhausted ?? null;
    if (accountExhaustion !== null) {
      if (accountExhaustion.limitKind !== 'provider-quota') {
        return {
          kind: 'park',
          reason: 'budget-exhausted',
          detail: `budget exhausted: scope=${accountExhaustion.scope} limitKind=${accountExhaustion.limitKind} account=${account}`,
          account,
        };
      }
      const detail =
        accountExhaustion.resetsAt !== null
          ? `waiting on ${account} window, resets at ${accountExhaustion.resetsAt}`
          : `waiting on ${account} window`;
      return { kind: 'park', reason: 'provider-quota', detail, account };
    }
  }

  const v3 = v3Decision(state, policy);
  if (v3 !== null) return v3;

  // 8. effectiveAttempts(state, stage) >= limitForStage(stage, policy)
  //    -> park('attempts-exhausted', detail, null). detail byte-identical to Phase 1.
  const limit = limitForStage(state.stage, policy);
  const attempts = effectiveAttempts(state, state.stage);
  if (attempts >= limit) {
    return {
      kind: 'park',
      reason: 'attempts-exhausted',
      detail: `stage "${state.stage}" reached its attempt limit (${String(limit)})`,
      account: null,
    };
  }

  // 9. otherwise -> run(stage, effectiveAttempts(state, stage) + 1)
  return { kind: 'run', stage: state.stage, attempt: attempts + 1, needsHuman: false };
}

export function makeNextStage(policy: StagePolicy): (state: WorkItemState) => StageDecision {
  return (state: WorkItemState): StageDecision => nextStage(state, policy);
}

export function policyFromConfig(c: MienguConfig): StagePolicy {
  const stageAccounts = {} as Record<Stage, AccountId | null>;
  for (const stage of STAGE_ORDER) {
    const role = roleForStage(stage);
    if (role === null) {
      stageAccounts[stage] = null;
      continue;
    }
    const instance = c.roles[role].executor;
    // validateConfig's V2 already guarantees `instance` resolves in `c.executors` before
    // this ever runs; the index signature is only `| undefined` because `executors` is a
    // `z.record`, not because the reference can actually be missing here.
    const resolved = c.executors[instance];
    stageAccounts[stage] = resolved === undefined ? null : resolved.account;
  }
  return { limits: c.limits, stageAccounts };
}
