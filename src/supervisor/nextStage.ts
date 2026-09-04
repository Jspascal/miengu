import type { CheckpointId } from '../core/ids.js';
import type { ParkReason, Stage } from '../core/events.js';
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
}

export type StageDecision =
  | { readonly kind: 'run'; readonly stage: Stage; readonly attempt: number; readonly needsHuman: false }
  | {
      readonly kind: 'checkpoint';
      readonly stage: Stage;
      readonly checkpoint: CheckpointId;
      readonly needsHuman: true;
    }
  | { readonly kind: 'park'; readonly reason: ParkReason; readonly detail: string }
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

  // 3. status === 'parked' -> park(state.park.reason, state.park.detail)
  if (state.status === 'parked') {
    // Defensive fallback only: the projector never sets status:'parked' without a park
    // record, but nextStage must never throw for any WorkItemState value.
    const reason = state.park?.reason ?? 'attempts-exhausted';
    const detail = state.park?.detail ?? '';
    return { kind: 'park', reason, detail };
  }

  // 4. budget.exhausted !== null -> park(reason, ...) where reason is 'provider-quota' if
  //    budget.exhausted.limitKind === 'provider-quota', else 'budget-exhausted'
  if (state.budget.exhausted !== null) {
    const reason: ParkReason =
      state.budget.exhausted.limitKind === 'provider-quota' ? 'provider-quota' : 'budget-exhausted';
    return {
      kind: 'park',
      reason,
      detail: `budget exhausted: scope=${state.budget.exhausted.scope} limitKind=${state.budget.exhausted.limitKind}`,
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

  // 7. attempts[stage] >= limitForStage(stage, policy) -> park('attempts-exhausted', ...)
  const limit = limitForStage(state.stage, policy);
  const attempts = state.attempts[state.stage];
  if (attempts >= limit) {
    return {
      kind: 'park',
      reason: 'attempts-exhausted',
      detail: `stage "${state.stage}" reached its attempt limit (${String(limit)})`,
    };
  }

  // 8. otherwise -> run(stage, attempts[stage] + 1)
  return { kind: 'run', stage: state.stage, attempt: attempts + 1, needsHuman: false };
}

export function makeNextStage(policy: StagePolicy): (state: WorkItemState) => StageDecision {
  return (state: WorkItemState): StageDecision => nextStage(state, policy);
}

export function policyFromConfig(c: MienguConfig): StagePolicy {
  return { limits: c.limits };
}
