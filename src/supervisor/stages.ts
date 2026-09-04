import { sha256Canonical } from '../core/hash.js';
import type { Stage, StageFailureReason } from '../core/events.js';
import type { WorkItemId } from '../core/ids.js';
import { emptyContextPack } from '../wiki/contextpack.js';
import type { Executor, ExecutorRunResult, ExecutorStatus } from '../executors/executor.js';

export interface StageRunContext {
  readonly executor: Executor;
  readonly itemId: WorkItemId;
  readonly workdir: string;
  readonly budget: { maxTurns: number; maxWallSeconds: number };
  readonly signal: AbortSignal;
}

export type StageOutcome =
  | {
      readonly kind: 'completed';
      readonly artifact: {
        readonly kind: 'stub';
        readonly sha256: string;
        readonly body: { readonly stage: Stage; readonly executorStatus: ExecutorStatus };
      };
      readonly executorResult: ExecutorRunResult;
    }
  | {
      readonly kind: 'failed';
      readonly reason: StageFailureReason;
      readonly detail: string;
      readonly executorResult: ExecutorRunResult;
    };

/**
 * Phase 1's canned, non-agent prompt. Exported so callers that must append
 * `ExecutorInvoked` (which needs the prompt hash) before spawning can build the identical
 * string without duplicating it. Phase 2 replaces this module's caller, not its shape.
 */
export function buildStubPrompt(stage: Stage): string {
  return `miengu stub stage: ${stage}`;
}

function failureReasonFor(status: Exclude<ExecutorStatus, 'completed'>): StageFailureReason {
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

export async function runStubStage(stage: Stage, ctx: StageRunContext): Promise<StageOutcome> {
  const prompt = buildStubPrompt(stage);
  const contextPack = emptyContextPack(ctx.itemId, stage);

  const executorResult = await ctx.executor.run({
    workdir: ctx.workdir,
    prompt,
    contextPack,
    budget: ctx.budget,
    signal: ctx.signal,
  });

  if (executorResult.status === 'completed') {
    const body = { stage, executorStatus: executorResult.status };
    return {
      kind: 'completed',
      artifact: { kind: 'stub', sha256: sha256Canonical(body), body },
      executorResult,
    };
  }

  return {
    kind: 'failed',
    reason: failureReasonFor(executorResult.status),
    detail: `executor reported status "${executorResult.status}"`,
    executorResult,
  };
}
