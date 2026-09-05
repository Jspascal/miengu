import type { CheckpointId } from '../core/ids.js';
import type { AccountId } from '../core/ids.js';
import type { ParkReason, Stage } from '../core/events.js';
import { STAGE_ORDER, roleForStage } from '../state/workitem.js';
import type { WorkItemState } from '../state/workitem.js';

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

export type StageDecision =
  | { readonly kind: 'run'; readonly stage: Stage; readonly attempt: number; readonly needsHuman: false }
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

  // 6. any blocking checkpoint with status === 'open' -> checkpoint(stage, id) (lowest id)
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
