import { describe, expect, it } from 'vitest';
import { formatProgressEvent } from '../../src/cli/progress.js';
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
});
