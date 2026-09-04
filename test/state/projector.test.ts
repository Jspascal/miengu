import { describe, it, expect } from 'vitest';
import { fixedClock, IsoTimestampSchema } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import { ProjectionError } from '../../src/errors.js';
import { accumulate, EMPTY_LEDGER } from '../../src/supervisor/budget.js';
import { applyEvent, project, projectAsync } from '../../src/state/projector.js';
import { WorkItemStateSchema } from '../../src/state/workitem.js';

const clock = fixedClock(IsoTimestampSchema.parse('2024-01-01T00:00:00.000Z'), 1000);
const ids = createIdMinter(fixedRng('projector-fixture'));
const ITEM_ID = 'wi-example-abc123';
const RUN_ID = ids.runId();

function mkEvent(seq: number, type: EventType, data: unknown): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 1,
    event_id: ids.eventId(),
    seq,
    item_id: ITEM_ID,
    run_id: RUN_ID,
    ts: clock.now(),
    tier: DEFAULT_TIER[type],
    actor: { kind: 'system', id: null },
    causation_id: null,
    type,
    data,
  });
}

/** Fixture: one event per EVENT_TYPES member, plus one extra CheckpointRaised so
 * CheckpointDecided/AutoApproved each have a distinct open checkpoint to resolve. */
function buildFixture(): MienguEvent[] {
  const events: MienguEvent[] = [];
  function push(type: EventType, data: unknown): void {
    events.push(mkEvent(events.length + 1, type, data));
  }

  push('WorkItemCreated', {
    title: 'Example item',
    slug: 'example',
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    config_hash: 'deadbeef',
  });
  push('RunStarted', {
    miengu_version: '0.1.0',
    node_version: 'v20.0.0',
    config_hash: 'deadbeef',
    config: {},
  });
  push('StageEntered', { stage: 'intake', attempt: 1 });
  push('WorkspacePrepared', {
    mode: 'worktree',
    target_repo: '/tmp/repo',
    workdir: '/tmp/wd',
    base_ref: 'HEAD',
    base_commit: 'a'.repeat(40),
  });
  push('ExecutorInvoked', {
    executor_id: 'stub',
    stage: 'intake',
    workdir: '/tmp/wd',
    prompt_sha256: 'a'.repeat(64),
    prompt_bytes: 10,
    context_pack_id: null,
    session_id: null,
    budget: { max_turns: 10, max_wall_seconds: 60 },
    command_line: ['stub'],
  });
  push('ExecutorReturned', {
    executor_id: 'stub',
    stage: 'intake',
    status: 'completed',
    telemetry: { turns: 1, input_tokens: 100, output_tokens: 50, wall_seconds: 2.5 },
    raw: {
      exit_code: 0,
      signal: null,
      killed: 'none',
      observed_turns: 1,
      failure_kind: null,
      stderr_tail: '',
      transcript_path: null,
    },
  });
  push('DiffCaptured', {
    workdir: '/tmp/wd',
    diff_sha256: 'b'.repeat(64),
    diff_ref: null,
    files_touched: ['a.ts'],
    untracked: ['b.ts'],
    insertions: 5,
    deletions: 2,
    committed_during_run: false,
  });
  push('BudgetConsumed', { scope: 'task', wall_seconds: 2.5, turns: 1, usd: null });
  push('StageCompleted', {
    stage: 'intake',
    attempt: 1,
    artifact: { kind: 'stub', sha256: 'c'.repeat(64), body: { note: 'ok' } },
  });
  push('StageFailed', {
    stage: 'intake',
    attempt: 1,
    reason: 'validation-failed',
    detail: 'bad output',
  });
  push('CheckpointRaised', {
    checkpoint: 'cp-example-1',
    kind: 'irreversible',
    stage: 'intake',
    summary: 'needs review',
    blocking: true,
    sla_seconds: null,
    default_decision: null,
  });
  push('CheckpointRaised', {
    checkpoint: 'cp-example-2',
    kind: 'blast-radius',
    stage: 'intake',
    summary: 'auto path',
    blocking: false,
    sla_seconds: 3600,
    default_decision: 'accept',
  });
  push('CheckpointDecided', {
    checkpoint: 'cp-example-1',
    decision: 'accept',
    by: 'human',
    reason: 'looks good',
  });
  push('AutoApproved', {
    checkpoint: 'cp-example-2',
    after: 'PT1H',
    no_human_response: true,
  });
  push('AssumptionRecorded', {
    id: 'assumption-example-1',
    question: 'q?',
    chosen: 'a',
    alternatives: ['b'],
    affects: ['REQ-example-1'],
    depth: 0,
  });
  push('TestsTampered', {
    task_id: 'task-example-1',
    suite_id: 'suite-example-1',
    expected_hash: 'a'.repeat(64),
    observed_hash: 'b'.repeat(64),
    paths: ['test/x.test.ts'],
  });
  push('DriftDetected', { claim: 'claim-example-1', expected: 'x', observed: 'y', area: 'auth' });
  push('BudgetExhausted', {
    scope: 'task',
    limit_kind: 'turns',
    declared_limit: 10,
    observed: 11,
    detail: 'over budget',
  });
  push('WorkItemParked', { reason: 'budget-exhausted', detail: 'ledger over', resumable: true });
  push('WorkItemResumed', { previous_reason: 'budget-exhausted', detail: 'operator resumed' });
  push('WorkspaceDiscarded', { workdir: '/tmp/wd', retained: false });
  push('WorkItemCompleted', { stages_completed: ['intake'] });
  push('WorkItemFailed', { reason: 'loop-guard', detail: 'too many iterations' });
  push('RunFinished', { outcome: 'completed', events_appended: events.length + 1 });

  return events;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

describe('applyEvent: one fixture per event type asserts the exact state delta', () => {
  const events = buildFixture();

  it('WorkItemCreated builds the initial state', () => {
    const s = applyEvent(null, events[0] as MienguEvent);
    expect(s.itemId).toBe(ITEM_ID);
    expect(s.slug).toBe('example');
    expect(s.title).toBe('Example item');
    expect(s.configHash).toBe('deadbeef');
    expect(s.status).toBe('active');
    expect(s.stage).toBe('intake');
    expect(s.stageEnteredAt).toBeNull();
    expect(s.attempts).toEqual({
      intake: 0,
      analysis: 0,
      architecture: 0,
      planning: 0,
      'test-authoring': 0,
      implementation: 0,
      review: 0,
      integration: 0,
      done: 0,
    });
    expect(s.seq).toBe(1);
    expect(s.lastEventId).toBe(events[0]?.event_id);
    expect(s.createdAt).toBe(events[0]?.ts);
    expect(s.updatedAt).toBe(events[0]?.ts);
    expect(s.runs).toEqual([]);
    expect(s.checkpoints).toEqual({});
  });

  let state = applyEvent(null, events[0] as MienguEvent);

  it('RunStarted appends an open run record', () => {
    state = applyEvent(state, events[1] as MienguEvent);
    expect(state.runs).toEqual([
      { runId: RUN_ID, startedAt: events[1]?.ts, finishedAt: null, outcome: null },
    ]);
    expect(state.seq).toBe(2);
    expect(state.lastEventId).toBe(events[1]?.event_id);
    expect(state.updatedAt).toBe(events[1]?.ts);
  });

  it('StageEntered increments the attempt counter and sets stageEnteredAt', () => {
    state = applyEvent(state, events[2] as MienguEvent);
    expect(state.stage).toBe('intake');
    expect(state.attempts.intake).toBe(1);
    expect(state.stageEnteredAt).toBe(events[2]?.ts);
  });

  it('WorkspacePrepared sets the workspace', () => {
    state = applyEvent(state, events[3] as MienguEvent);
    expect(state.workspace).toEqual({
      mode: 'worktree',
      targetRepo: '/tmp/repo',
      workdir: '/tmp/wd',
      baseRef: 'HEAD',
      baseCommit: 'a'.repeat(40),
      discarded: false,
    });
  });

  it('ExecutorInvoked changes only the envelope fields', () => {
    const before = state;
    state = applyEvent(state, events[4] as MienguEvent);
    expect(state).toEqual({ ...before, seq: 5, lastEventId: events[4]?.event_id, updatedAt: events[4]?.ts });
  });

  it('ExecutorReturned sets lastExecutor with camelCase telemetry', () => {
    state = applyEvent(state, events[5] as MienguEvent);
    expect(state.lastExecutor).toEqual({
      executorId: 'stub',
      stage: 'intake',
      status: 'completed',
      telemetry: { turns: 1, inputTokens: 100, outputTokens: 50, wallSeconds: 2.5 },
      at: events[5]?.ts,
    });
  });

  it('DiffCaptured sets lastDiff', () => {
    state = applyEvent(state, events[6] as MienguEvent);
    expect(state.lastDiff).toEqual({
      sha256: 'b'.repeat(64),
      filesTouched: ['a.ts'],
      untracked: ['b.ts'],
      insertions: 5,
      deletions: 2,
      committedDuringRun: false,
    });
  });

  it('BudgetConsumed accumulates via the imported accumulate() function', () => {
    state = applyEvent(state, events[7] as MienguEvent);
    const expected = accumulate(EMPTY_LEDGER, { wallSeconds: 2.5, turns: 1, usd: null });
    expect(state.budget.consumed).toEqual(expected);
  });

  it('StageCompleted with a non-null artifact records an ArtifactRef', () => {
    state = applyEvent(state, events[8] as MienguEvent);
    expect(state.artifacts.intake).toEqual({
      kind: 'stub',
      sha256: 'c'.repeat(64),
      stage: 'intake',
      eventId: events[8]?.event_id,
    });
  });

  it('StageFailed appends a StageFailureRecord', () => {
    state = applyEvent(state, events[9] as MienguEvent);
    expect(state.failures).toEqual([
      {
        stage: 'intake',
        attempt: 1,
        reason: 'validation-failed',
        detail: 'bad output',
        at: events[9]?.ts,
        eventId: events[9]?.event_id,
      },
    ]);
  });

  it('CheckpointRaised (cp-example-1) opens a checkpoint record', () => {
    state = applyEvent(state, events[10] as MienguEvent);
    expect(state.checkpoints['cp-example-1']).toEqual({
      id: 'cp-example-1',
      kind: 'irreversible',
      stage: 'intake',
      blocking: true,
      status: 'open',
      raisedAt: events[10]?.ts,
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  it('a second CheckpointRaised (cp-example-2) opens a second, independent record', () => {
    state = applyEvent(state, events[11] as MienguEvent);
    expect(state.checkpoints['cp-example-2']).toEqual({
      id: 'cp-example-2',
      kind: 'blast-radius',
      stage: 'intake',
      blocking: false,
      status: 'open',
      raisedAt: events[11]?.ts,
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  it('CheckpointDecided resolves the named checkpoint by a human', () => {
    state = applyEvent(state, events[12] as MienguEvent);
    expect(state.checkpoints['cp-example-1']).toMatchObject({
      status: 'accepted',
      resolvedAt: events[12]?.ts,
      resolvedBy: 'human',
    });
    expect(state.checkpoints['cp-example-2']?.status).toBe('open');
  });

  it('AutoApproved resolves the named checkpoint without a human', () => {
    state = applyEvent(state, events[13] as MienguEvent);
    expect(state.checkpoints['cp-example-2']).toMatchObject({
      status: 'auto-approved',
      resolvedAt: events[13]?.ts,
      resolvedBy: 'auto',
    });
  });

  it('AssumptionRecorded appends an AssumptionRecord', () => {
    state = applyEvent(state, events[14] as MienguEvent);
    expect(state.assumptions).toEqual([
      {
        id: 'assumption-example-1',
        question: 'q?',
        chosen: 'a',
        alternatives: ['b'],
        affects: ['REQ-example-1'],
        depth: 0,
        at: events[14]?.ts,
      },
    ]);
  });

  it('TestsTampered appends a tampering record', () => {
    state = applyEvent(state, events[15] as MienguEvent);
    expect(state.tampering).toEqual([
      {
        taskId: 'task-example-1',
        suiteId: 'suite-example-1',
        expectedHash: 'a'.repeat(64),
        observedHash: 'b'.repeat(64),
        paths: ['test/x.test.ts'],
        at: events[15]?.ts,
      },
    ]);
  });

  it('DriftDetected appends a drift record', () => {
    state = applyEvent(state, events[16] as MienguEvent);
    expect(state.drift).toEqual([
      { claim: 'claim-example-1', expected: 'x', observed: 'y', area: 'auth', at: events[16]?.ts },
    ]);
  });

  it('BudgetExhausted records the exhaustion', () => {
    state = applyEvent(state, events[17] as MienguEvent);
    expect(state.budget.exhausted).toEqual({
      scope: 'task',
      limitKind: 'turns',
      at: events[17]?.ts,
    });
  });

  it('WorkItemParked parks the item', () => {
    state = applyEvent(state, events[18] as MienguEvent);
    expect(state.status).toBe('parked');
    expect(state.park).toEqual({
      reason: 'budget-exhausted',
      detail: 'ledger over',
      since: events[18]?.ts,
      resumable: true,
    });
  });

  it('WorkItemResumed reactivates and clears park', () => {
    state = applyEvent(state, events[19] as MienguEvent);
    expect(state.status).toBe('active');
    expect(state.park).toBeNull();
  });

  it('WorkspaceDiscarded marks the workspace discarded', () => {
    state = applyEvent(state, events[20] as MienguEvent);
    expect(state.workspace?.discarded).toBe(true);
  });

  it('WorkItemCompleted marks the item completed', () => {
    state = applyEvent(state, events[21] as MienguEvent);
    expect(state.status).toBe('completed');
  });

  it('WorkItemFailed marks the item failed', () => {
    state = applyEvent(state, events[22] as MienguEvent);
    expect(state.status).toBe('failed');
  });

  it('RunFinished closes out the matching run record', () => {
    state = applyEvent(state, events[23] as MienguEvent);
    expect(state.runs).toEqual([
      { runId: RUN_ID, startedAt: events[1]?.ts, finishedAt: events[23]?.ts, outcome: 'completed' },
    ]);
  });

  it('the fully-folded state round-trips through WorkItemStateSchema unchanged', () => {
    expect(WorkItemStateSchema.parse(state)).toEqual(state);
  });

  it('project() folds the whole fixture to the same final state', () => {
    expect(project(events)).toEqual(state);
  });

  it('projectAsync() folds the whole fixture to the same final state', async () => {
    async function* toAsync(items: MienguEvent[]): AsyncIterable<MienguEvent> {
      for (const item of items) {
        yield item;
      }
    }
    await expect(projectAsync(toAsync(events))).resolves.toEqual(state);
  });
});

describe('applyEvent: error paths', () => {
  const events = buildFixture();

  it('throws if the first event applied to a null state is not WorkItemCreated', () => {
    expect(() => applyEvent(null, events[1] as MienguEvent)).toThrow(ProjectionError);
  });

  it('throws if a WorkItemCreated applied to a null state has seq !== 1', () => {
    const badFirst = mkEvent(2, 'WorkItemCreated', {
      title: 'x',
      slug: 'x',
      source: { kind: 'prd-file', path: 'p', sha256: 'a'.repeat(64), bytes: 1 },
      config_hash: 'x',
    });
    expect(() => applyEvent(null, badFirst)).toThrow(ProjectionError);
  });

  it('throws on an out-of-order (non-contiguous) seq', () => {
    const state = applyEvent(null, events[0] as MienguEvent);
    const outOfOrder = mkEvent(10, 'RunStarted', {
      miengu_version: '0.1.0',
      node_version: 'v20.0.0',
      config_hash: 'deadbeef',
      config: {},
    });
    expect(() => applyEvent(state, outOfOrder)).toThrow(ProjectionError);
  });

  it('throws on a mismatched item_id', () => {
    const state = applyEvent(null, events[0] as MienguEvent);
    const wrongItem = MienguEventSchema.parse({
      schema_version: 1,
      event_id: ids.eventId(),
      seq: 2,
      item_id: 'wi-other-abc123',
      run_id: RUN_ID,
      ts: clock.now(),
      tier: 'T1',
      actor: { kind: 'system', id: null },
      causation_id: null,
      type: 'RunStarted',
      data: {
        miengu_version: '0.1.0',
        node_version: 'v20.0.0',
        config_hash: 'deadbeef',
        config: {},
      },
    });
    expect(() => applyEvent(state, wrongItem)).toThrow(ProjectionError);
  });
});

describe('applyEvent: immutability', () => {
  it('never mutates the input state', () => {
    const events = buildFixture();
    const before = project(events.slice(0, 10));
    const frozen = deepFreeze(structuredClone(before));
    const snapshotBeforeApply = structuredClone(frozen);

    const next = applyEvent(frozen, events[10] as MienguEvent);

    expect(frozen).toEqual(snapshotBeforeApply);
    expect(next).not.toBe(frozen);
    expect(next.checkpoints['cp-example-1']).toBeDefined();
  });
});
