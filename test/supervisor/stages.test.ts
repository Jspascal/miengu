import { describe, it, expect } from 'vitest';
import { failureReasonFor, runSupervisorStage } from '../../src/supervisor/stages.js';
import type { ExecutorStatus } from '../../src/executors/executor.js';
import type { StageFailureReason } from '../../src/core/events.js';

describe('failureReasonFor', () => {
  const cases: Array<{ status: Exclude<ExecutorStatus, 'completed' | 'quota_exhausted'>; reason: StageFailureReason }> = [
    { status: 'gave_up', reason: 'executor-gave-up' },
    { status: 'budget_turns', reason: 'budget-turns' },
    { status: 'budget_wall', reason: 'budget-wall' },
    { status: 'crashed', reason: 'executor-crashed' },
  ];

  for (const { status, reason } of cases) {
    it(`maps executor status "${status}" to StageFailureReason "${reason}"`, () => {
      expect(failureReasonFor(status)).toBe(reason);
    });
  }

  it('quota_exhausted is not assignable to failureReasonFor\'s parameter (binding decision 17)', () => {
    // @ts-expect-error quota is NEVER a stage failure; it must not be reachable here.
    failureReasonFor('quota_exhausted');
  });
});

describe('runSupervisorStage', () => {
  it('completes "intake" with a null artifact, no derived events, and no executor call', () => {
    const outcome = runSupervisorStage('intake');
    expect(outcome).toEqual({ kind: 'completed', artifact: null, derived: [], executorResult: null });
  });

  it('does not treat integration as a no-op supervisor stage', () => {
    expect(() => runSupervisorStage('integration')).toThrow();
  });

  it('throws for any stage that is not supervisor-only', () => {
    expect(() => runSupervisorStage('analysis')).toThrow();
  });
});
