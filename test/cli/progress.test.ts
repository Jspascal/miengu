import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressReporter, formatProgressEvent } from '../../src/cli/progress.js';
import type { MienguEvent } from '../../src/core/events.js';

function event(type: MienguEvent['type'], data: unknown): MienguEvent {
  return {
    schema_version: 4,
    event_id: 'evt-00000000-0000-0000-0000-000000000001',
    seq: 1,
    item_id: 'wi-example-abc123',
    run_id: 'run-00000000-0000-0000-0000-000000000001',
    ts: '2024-01-01T00:00:00.000Z',
    tier: 'T0',
    actor: { kind: 'supervisor', id: null },
    causation_id: null,
    type,
    data,
  } as MienguEvent;
}

describe('formatProgressEvent', () => {
  afterEach(() => vi.useRealTimers());
  it('reports stage and executor progress', () => {
    expect(formatProgressEvent(event('StageEntered', { stage: 'analysis', attempt: 2 })))
      .toBe('[wi-example-abc123] -> analysis (attempt 2)');
    expect(formatProgressEvent(event('ExecutorInvoked', {
      executor_id: 'claude-primary', stage: 'analysis', role: 'analyst',
    }))).toBe('[wi-example-abc123] running analyst with claude-primary');
  });

  it('surfaces validation and stage failure details immediately', () => {
    expect(formatProgressEvent(event('ArtifactValidationFailed', {
      stage: 'analysis', validation_attempt: 1, errors: ['missing requirement IDs', 'bad schema'],
    }))).toBe('[wi-example-abc123] ! analysis output invalid (attempt 1): missing requirement IDs; bad schema');
    expect(formatProgressEvent(event('StageFailed', {
      stage: 'analysis', attempt: 1, reason: 'executor-crashed', detail: 'process exited 1',
    }))).toBe('[wi-example-abc123] x analysis failed (executor-crashed): process exited 1');
  });

  it('reports terminal and parked outcomes with actionable detail', () => {
    expect(formatProgressEvent(event('WorkItemParked', {
      reason: 'attempts-exhausted', detail: 'analysis failed twice', resumable: true,
    }))).toBe('[wi-example-abc123] paused (attempts-exhausted): analysis failed twice [resumable]');
    expect(formatProgressEvent(event('WorkItemFailed', {
      reason: 'loop-guard', detail: 'iteration limit reached',
    }))).toBe('[wi-example-abc123] failed (loop-guard): iteration limit reached');
  });

  it('stays quiet for bookkeeping events', () => {
    expect(formatProgressEvent(event('BudgetConsumed', {
      scope: 'item', account: 'primary', wall_seconds: 1, turns: 1, usd: null,
    }))).toBeNull();
  });

  it('describes FailureAttempted as remediation accounting, not a future retry', () => {
    expect(formatProgressEvent(event('FailureAttempted', {
      level: 'planner', handler_stage: 'planning', attempt: 1, limit: 3,
    }))).toBe('[wi-example-abc123] planner remediation attempt recorded (1/3)');
  });

  it('groups a checkpoint flood into one actionable line', () => {
    const lines: string[] = [];
    const report = createProgressReporter((line) => lines.push(line));
    report(event('CheckpointRaised', {
      checkpoint: 'cp-example-1', blocking: true, summary: 'first enormous decision',
    }));
    report(event('CheckpointRaised', {
      checkpoint: 'cp-example-2', blocking: true, summary: 'second enormous decision',
    }));
    report(event('StageCompleted', { stage: 'architecture', attempt: 1, artifact: null }));

    expect(lines).toEqual([
      'miengu: [wi-example-abc123] 2 blocking checkpoints raised (cp-example-1 ... cp-example-2); run `miengu report` for details',
      'miengu: [wi-example-abc123] ok architecture',
    ]);
  });

  it('reports a heartbeat while an executor is silent and stops it on return', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const report = createProgressReporter((line) => lines.push(line), 30_000);
    report(event('ExecutorInvoked', {
      executor_id: 'cx-terra', stage: 'analysis', role: 'analyst',
    }));
    vi.advanceTimersByTime(60_000);
    report(event('ExecutorReturned', { executor_id: 'cx-terra', status: 'completed' }));
    vi.advanceTimersByTime(60_000);

    expect(lines).toEqual([
      'miengu: [wi-example-abc123] running analyst with cx-terra',
      'miengu: [wi-example-abc123] still running analyst with cx-terra (30s elapsed)',
      'miengu: [wi-example-abc123] still running analyst with cx-terra (60s elapsed)',
    ]);
  });
});
