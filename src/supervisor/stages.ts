import type { AppendInput } from '../core/log.js';
import type { IsoTimestamp } from '../core/clock.js';
import type { ArtifactKind, ExecutorType, SandboxIntent, Stage, StageFailureReason } from '../core/events.js';
import type { AccountId, Slug, WorkItemId } from '../core/ids.js';
import type { IdMinter } from '../core/idgen.js';
import { roleForStage } from '../state/workitem.js';
import type { FrozenTestsState } from '../state/workitem.js';
import type { Executor, ExecutorResult, ExecutorStatus, RawRunSource } from '../executors/executor.js';
import { AgentError } from '../errors.js';
import { ROLE_MODULES, runAgentStage } from '../agents/agent.js';
import type { AppendFn, PackBuildInput } from '../agents/agent.js';
import type { CheckContext } from '../agents/checks.js';

export interface StageRunContext {
  readonly executor: Executor & Partial<RawRunSource>;
  readonly executorType: ExecutorType;
  readonly account: AccountId;
  readonly itemId: WorkItemId;
  readonly slug: Slug;
  readonly workdir: string;
  readonly budget: { maxTurns: number; maxWallSeconds: number };
  readonly signal: AbortSignal;
  readonly sandboxIntent: SandboxIntent;
  /** The `StageEntered` attempt this invocation belongs to. */
  readonly attempt: number;
  readonly resolved: {
    readonly model: string | null;
    readonly effort: string | null;
    readonly maxTurns: number;
    readonly contextBudgetTokens: number;
  };
  readonly pack: PackBuildInput;
  readonly checkContext: CheckContext;
  readonly ids: IdMinter;
  readonly frozenTestsDir: string;
  readonly frozenTests: FrozenTestsState | null;
  readonly promptsDir: string;
  readonly schemasDir: string;
  readonly messagesDir: string;
  readonly append: AppendFn;
}

/**
 * `StageOutcome` amends §3.22's literal shape by one field: `derived` also appears on
 * `failed`, not only on `completed`. The Coder's tests-tampered path (binding decision 31)
 * has nowhere else to carry the `TestsTampered` event it must record — the literal spec's
 * `failed` variant has none. `AgentOutcome` in `agent.ts` is amended in lockstep; see the
 * comment there. This is the one place item 34's design and §3.22's frozen signature
 * genuinely diverge, and the divergence is confined to this single additive field.
 */
export type StageOutcome =
  | {
      readonly kind: 'completed';
      readonly artifact: { readonly kind: ArtifactKind; readonly sha256: string; readonly body: unknown } | null;
      readonly derived: readonly AppendInput[];
      readonly executorResult: ExecutorResult | null;
    }
  | {
      readonly kind: 'quota';
      readonly account: AccountId;
      readonly resetsAt: IsoTimestamp | null;
      readonly executorResult: ExecutorResult;
    }
  | {
      readonly kind: 'failed';
      readonly reason: StageFailureReason;
      readonly detail: string;
      readonly derived: readonly AppendInput[];
      readonly executorResult: ExecutorResult | null;
    };

/**
 * Narrowed: quota is NOT a stage failure (binding decision 17). `quota_exhausted` is
 * excluded from the parameter type, so a caller cannot even attempt to map it here —
 * the loop must branch on the quota status before ever reaching this function.
 */
export function failureReasonFor(
  status: Exclude<ExecutorStatus, 'completed' | 'quota_exhausted'>,
): StageFailureReason {
  switch (status) {
    case 'gave_up':
      return 'executor-gave-up';
    case 'budget_turns':
      return 'budget-turns';
    case 'budget_wall':
      return 'budget-wall';
    case 'crashed':
      return 'executor-crashed';
  }
}

/**
 * `intake` / `integration`: complete immediately with no executor (binding decision 5).
 * Any other stage is a caller defect — there is no supervisor-only handling for an
 * agent-run stage.
 */
export function runSupervisorStage(stage: Stage): StageOutcome {
  if (stage === 'intake' || stage === 'integration') {
    return { kind: 'completed', artifact: null, derived: [], executorResult: null };
  }
  throw new AgentError(`runSupervisorStage: "${stage}" is not a supervisor-only stage`, { stage });
}

/**
 * The §9.1b loop (item 34's `runAgentStage`), wired in for every agent-run stage. This
 * supersedes the Group E placeholder that called the executor directly with an empty
 * prompt and an empty pack — that placeholder was explicitly flagged as provisional and
 * must not become the shipped implementation.
 */
export async function runRoleStage(stage: Stage, ctx: StageRunContext): Promise<StageOutcome> {
  const role = roleForStage(stage);
  if (role === null) {
    throw new AgentError(`runRoleStage: "${stage}" has no role (supervisor-only stage)`, { stage });
  }
  const module = ROLE_MODULES[role];

  const outcome = await runAgentStage({
    module,
    executor: ctx.executor,
    executorType: ctx.executorType,
    account: ctx.account,
    itemId: ctx.itemId,
    slug: ctx.slug,
    stage,
    attempt: ctx.attempt,
    workdir: ctx.workdir,
    sandboxIntent: ctx.sandboxIntent,
    resolved: ctx.resolved,
    budget: ctx.budget,
    signal: ctx.signal,
    pack: ctx.pack,
    checkContext: ctx.checkContext,
    ids: ctx.ids,
    frozenTestsDir: ctx.frozenTestsDir,
    frozenTests: ctx.frozenTests,
    promptsDir: ctx.promptsDir,
    schemasDir: ctx.schemasDir,
    messagesDir: ctx.messagesDir,
    append: ctx.append,
  });

  switch (outcome.kind) {
    case 'quota':
      return outcome;
    case 'completed':
      return {
        kind: 'completed',
        artifact: outcome.artifact,
        derived: outcome.derived,
        executorResult: outcome.executorResult,
      };
    case 'failed':
      return {
        kind: 'failed',
        reason: outcome.reason,
        detail: outcome.detail,
        derived: outcome.derived,
        executorResult: outcome.executorResult,
      };
  }
}
