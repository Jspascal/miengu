import { describe, it, expect } from 'vitest';
import { fixedClock, IsoTimestampSchema } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { AccountIdSchema, ExecutorInstanceIdSchema } from '../../src/core/ids.js';
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

const ACCOUNT_CC = AccountIdSchema.parse('claude-personal');
const ACCOUNT_CX = AccountIdSchema.parse('codex-personal');
const EXECUTOR_CC = ExecutorInstanceIdSchema.parse('cc-sonnet');

function mkEvent(seq: number, type: EventType, data: unknown): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 2,
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
 * CheckpointDecided/AutoApproved each have a distinct open checkpoint to resolve, plus one
 * extra BudgetConsumed on a second account so the two-accumulator fold is exercised. */
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
  push('WorktreeLockAcquired', {
    workdir: '/tmp/wd',
    holder: 'cc-sonnet',
    stage: 'intake',
    intent: 'workspace-write',
  });
  push('ExecutorInvoked', {
    executor_id: 'cc-sonnet',
    executor_type: 'claude-code',
    account: 'claude-personal',
    role: null,
    stage: 'intake',
    workdir: '/tmp/wd',
    sandbox_intent: 'workspace-write',
    native_structured_output: false,
    output_schema_sha256: null,
    prompt_sha256: 'a'.repeat(64),
    prompt_bytes: 10,
    prompt_path: null,
    prompt_template_sha256: null,
    validation_attempt: 1,
    context_pack_id: null,
    context_pack_estimated_tokens: null,
    session_id: null,
    resolved: { model: 'sonnet', effort: 'medium', max_turns: 10, context_budget_tokens: 1000 },
    budget: { max_turns: 10, max_wall_seconds: 60 },
    command_line: ['claude'],
    session_id: 'sess-claude',
  });
  push('ExecutorReturned', {
    executor_id: 'cc-sonnet',
    executor_type: 'claude-code',
    account: 'claude-personal',
    stage: 'intake',
    status: 'completed',
    telemetry: {
      turns: 1,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_creation_tokens: 20,
      wall_seconds: 2.5,
    },
    quota: null,
    raw: {
      exit_code: 0,
      signal: null,
      killed: 'none',
      observed_turns: 1,
      failure_kind: null,
      stderr_tail: '',
      transcript_path: null,
      final_message_bytes: 42,
      command_line: ['claude'],
      session_id: 'sess-claude',
    },
  });
  push('WorktreeLockReleased', {
    workdir: '/tmp/wd',
    holder: 'cc-sonnet',
    stage: 'intake',
    reclaimed: false,
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
  push('BudgetConsumed', {
    scope: 'task',
    account: 'claude-personal',
    wall_seconds: 2.5,
    turns: 1,
    usd: null,
  });
  push('BudgetConsumed', {
    scope: 'task',
    account: 'codex-personal',
    wall_seconds: 1,
    turns: 1,
    usd: null,
  });
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
  push('ArtifactValidationFailed', {
    stage: 'implementation',
    role: 'coder',
    executor_id: 'cc-sonnet',
    attempt: 1,
    validation_attempt: 1,
    kind: 'schema',
    artifact_kind: 'implementation',
    errors: ['missing field: diff_ref'],
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
  push('TestsFrozen', {
    suite_id: 'suite-example-1',
    content_hash: 'd'.repeat(64),
    files: [{ path: 'test/x.test.ts', sha256: 'e'.repeat(64), bytes: 20 }],
    frozen_copy_dir: '/tmp/frozen',
  });
  push('TestsTampered', {
    task_id: 'task-example-1',
    suite_id: 'suite-example-1',
    expected_hash: 'a'.repeat(64),
    observed_hash: 'b'.repeat(64),
    paths: ['test/x.test.ts'],
    restored: true,
  });
  push('ItemArtifactRecorded', {
    role: 'analyst',
    stage: 'analysis',
    artifact_kind: 'requirement-set',
    sha256: 'a'.repeat(64),
    summary: 'covers all requirements',
  });
  push('DriftDetected', { claim: 'claim-example-1', expected: 'x', observed: 'y', area: 'auth' });
  push('BudgetExhausted', {
    scope: 'task',
    account: 'claude-personal',
    limit_kind: 'turns',
    declared_limit: 10,
    observed: 11,
    detail: 'over budget',
    resets_at: null,
  });
  push('WorkItemParked', {
    reason: 'budget-exhausted',
    detail: 'ledger over',
    resumable: true,
    account: 'claude-personal',
    resets_at: null,
  });
  push('WorkItemResumed', {
    previous_reason: 'budget-exhausted',
    detail: 'operator resumed',
    account: 'claude-personal',
  });
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
    expect(s.quotaAborts).toEqual({
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
    expect(s.budget).toEqual({ accounts: {}, item: EMPTY_LEDGER, itemExhausted: null });
    expect(s.worktreeLock).toBeNull();
    expect(s.frozenTests).toBeNull();
    expect(s.validationFailures).toEqual([]);
    expect(s.itemArtifacts).toEqual([]);
    expect(s.seq).toBe(1);
    expect(s.lastEventId).toBe(events[0]?.event_id);
    expect(s.createdAt).toBe(events[0]?.ts);
    expect(s.updatedAt).toBe(events[0]?.ts);
    expect(s.runs).toEqual([]);
    expect(s.checkpoints).toEqual({});
  });

  let state = applyEvent(null, events[0] as MienguEvent);
  let idx = 1;
  function apply(label: string, assertions: () => void): void {
    it(label, () => {
      state = applyEvent(state, events[idx] as MienguEvent);
      idx += 1;
      assertions();
    });
  }

  apply('RunStarted appends an open run record', () => {
    expect(state.runs).toEqual([
      { runId: RUN_ID, startedAt: state.updatedAt, finishedAt: null, outcome: null },
    ]);
    expect(state.seq).toBe(2);
  });

  apply('StageEntered increments the attempt counter and sets stageEnteredAt', () => {
    expect(state.stage).toBe('intake');
    expect(state.attempts.intake).toBe(1);
    expect(state.stageEnteredAt).toBe(state.updatedAt);
  });

  apply('WorkspacePrepared sets the workspace', () => {
    expect(state.workspace).toEqual({
      mode: 'worktree',
      targetRepo: '/tmp/repo',
      workdir: '/tmp/wd',
      baseRef: 'HEAD',
      baseCommit: 'a'.repeat(40),
      discarded: false,
    });
  });

  apply('WorktreeLockAcquired sets worktreeLock', () => {
    expect(state.worktreeLock).toEqual({
      holder: EXECUTOR_CC,
      workdir: '/tmp/wd',
      stage: 'intake',
      intent: 'workspace-write',
      since: state.updatedAt,
    });
  });

  it('ExecutorInvoked changes only the envelope fields', () => {
    const before = state;
    const event = events[idx] as MienguEvent;
    idx += 1;
    state = applyEvent(state, event);
    expect(state).toEqual({
      ...before,
      seq: event.seq,
      lastEventId: event.event_id,
      updatedAt: event.ts,
    });
  });

  apply('ExecutorReturned sets lastExecutor with camelCase, widened telemetry', () => {
    expect(state.lastExecutor).toEqual({
      executorId: EXECUTOR_CC,
      executorType: 'claude-code',
      account: ACCOUNT_CC,
      stage: 'intake',
      status: 'completed',
      telemetry: {
        turns: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 20,
        wallSeconds: 2.5,
      },
      at: state.updatedAt,
    });
  });

  apply('WorktreeLockReleased clears worktreeLock', () => {
    expect(state.worktreeLock).toBeNull();
  });

  apply('DiffCaptured sets lastDiff', () => {
    expect(state.lastDiff).toEqual({
      sha256: 'b'.repeat(64),
      filesTouched: ['a.ts'],
      untracked: ['b.ts'],
      insertions: 5,
      deletions: 2,
      committedDuringRun: false,
    });
  });

  apply('BudgetConsumed (claude-personal) folds into both accounts[a] and item', () => {
    const expected = accumulate(EMPTY_LEDGER, { wallSeconds: 2.5, turns: 1, usd: null });
    expect(state.budget.accounts[ACCOUNT_CC]?.consumed).toEqual(expected);
    expect(state.budget.item).toEqual(expected);
  });

  apply('a second BudgetConsumed (codex-personal) accumulates independently and sums into item', () => {
    const deltaCx = { wallSeconds: 1, turns: 1, usd: null };
    expect(state.budget.accounts[ACCOUNT_CX]?.consumed).toEqual(accumulate(EMPTY_LEDGER, deltaCx));
    expect(state.budget.accounts[ACCOUNT_CC]?.consumed).toEqual(
      accumulate(EMPTY_LEDGER, { wallSeconds: 2.5, turns: 1, usd: null }),
    );
    expect(state.budget.item).toEqual(
      accumulate(accumulate(EMPTY_LEDGER, { wallSeconds: 2.5, turns: 1, usd: null }), deltaCx),
    );
  });

  apply('StageCompleted with a non-null artifact records an ArtifactRef', () => {
    expect(state.artifacts.intake).toEqual({
      kind: 'stub',
      sha256: 'c'.repeat(64),
      stage: 'intake',
      eventId: state.lastEventId,
    });
  });

  apply('StageFailed appends a StageFailureRecord', () => {
    expect(state.failures).toEqual([
      {
        stage: 'intake',
        attempt: 1,
        reason: 'validation-failed',
        detail: 'bad output',
        at: state.updatedAt,
        eventId: state.lastEventId,
      },
    ]);
  });

  apply('ArtifactValidationFailed appends a ValidationFailureRecord', () => {
    expect(state.validationFailures).toEqual([
      {
        stage: 'implementation',
        role: 'coder',
        attempt: 1,
        validationAttempt: 1,
        kind: 'schema',
        errors: ['missing field: diff_ref'],
        at: state.updatedAt,
      },
    ]);
  });

  apply('CheckpointRaised (cp-example-1) opens a checkpoint record', () => {
    expect(state.checkpoints['cp-example-1']).toEqual({
      id: 'cp-example-1',
      kind: 'irreversible',
      stage: 'intake',
      blocking: true,
      status: 'open',
      raisedAt: state.updatedAt,
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  apply('a second CheckpointRaised (cp-example-2) opens a second, independent record', () => {
    expect(state.checkpoints['cp-example-2']).toEqual({
      id: 'cp-example-2',
      kind: 'blast-radius',
      stage: 'intake',
      blocking: false,
      status: 'open',
      raisedAt: state.updatedAt,
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  apply('CheckpointDecided resolves the named checkpoint by a human', () => {
    expect(state.checkpoints['cp-example-1']).toMatchObject({
      status: 'accepted',
      resolvedAt: state.updatedAt,
      resolvedBy: 'human',
    });
    expect(state.checkpoints['cp-example-2']?.status).toBe('open');
  });

  apply('AutoApproved resolves the named checkpoint without a human', () => {
    expect(state.checkpoints['cp-example-2']).toMatchObject({
      status: 'auto-approved',
      resolvedAt: state.updatedAt,
      resolvedBy: 'auto',
    });
  });

  apply('AssumptionRecorded appends an AssumptionRecord', () => {
    expect(state.assumptions).toEqual([
      {
        id: 'assumption-example-1',
        question: 'q?',
        chosen: 'a',
        alternatives: ['b'],
        affects: ['REQ-example-1'],
        depth: 0,
        at: state.updatedAt,
      },
    ]);
  });

  apply('TestsFrozen sets frozenTests', () => {
    expect(state.frozenTests).toEqual({
      suiteId: 'suite-example-1',
      contentHash: 'd'.repeat(64),
      files: [{ path: 'test/x.test.ts', sha256: 'e'.repeat(64), bytes: 20 }],
      frozenCopyDir: '/tmp/frozen',
      at: state.updatedAt,
    });
  });

  apply('TestsTampered appends a tampering record with restored', () => {
    expect(state.tampering).toEqual([
      {
        taskId: 'task-example-1',
        suiteId: 'suite-example-1',
        expectedHash: 'a'.repeat(64),
        observedHash: 'b'.repeat(64),
        paths: ['test/x.test.ts'],
        restored: true,
        at: state.updatedAt,
      },
    ]);
  });

  apply('ItemArtifactRecorded appends an ItemArtifactRecord', () => {
    expect(state.itemArtifacts).toEqual([
      {
        role: 'analyst',
        stage: 'analysis',
        artifactKind: 'requirement-set',
        sha256: 'a'.repeat(64),
        summary: 'covers all requirements',
        at: state.updatedAt,
      },
    ]);
  });

  apply('DriftDetected appends a drift record', () => {
    expect(state.drift).toEqual([
      { claim: 'claim-example-1', expected: 'x', observed: 'y', area: 'auth', at: state.updatedAt },
    ]);
  });

  apply('BudgetExhausted (claude-personal) sets accounts[a].exhausted, not itemExhausted', () => {
    expect(state.budget.accounts[ACCOUNT_CC]?.exhausted).toEqual({
      scope: 'task',
      limitKind: 'turns',
      at: state.updatedAt,
      resetsAt: null,
      detail: 'over budget',
    });
    expect(state.budget.itemExhausted).toBeNull();
  });

  apply('WorkItemParked parks the item with account and resetsAt', () => {
    expect(state.status).toBe('parked');
    expect(state.park).toEqual({
      reason: 'budget-exhausted',
      detail: 'ledger over',
      since: state.updatedAt,
      resumable: true,
      account: ACCOUNT_CC,
      resetsAt: null,
    });
  });

  apply('WorkItemResumed reactivates, clears park, and clears exactly that account exhaustion', () => {
    expect(state.status).toBe('active');
    expect(state.park).toBeNull();
    expect(state.budget.accounts[ACCOUNT_CC]?.exhausted).toBeNull();
    // codex-personal was never exhausted; the account fold does not disturb it.
    expect(state.budget.accounts[ACCOUNT_CX]?.exhausted).toBeNull();
  });

  apply('WorkspaceDiscarded marks the workspace discarded', () => {
    expect(state.workspace?.discarded).toBe(true);
  });

  apply('WorkItemCompleted marks the item completed', () => {
    expect(state.status).toBe('completed');
  });

  apply('WorkItemFailed marks the item failed', () => {
    expect(state.status).toBe('failed');
  });

  apply('RunFinished closes out the matching run record', () => {
    expect(state.runs).toEqual([
      { runId: RUN_ID, startedAt: events[1]?.ts, finishedAt: state.updatedAt, outcome: 'completed' },
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

describe('ExecutorReturned{quota_exhausted}', () => {
  it('increments quotaAborts[stage] and NOT attempts[stage]', () => {
    let state = applyEvent(
      null,
      mkEvent(1, 'WorkItemCreated', {
        title: 'x',
        slug: 'x',
        source: { kind: 'prd-file', path: 'p', sha256: 'a'.repeat(64), bytes: 1 },
        config_hash: 'x',
      }),
    );
    state = applyEvent(state, mkEvent(2, 'StageEntered', { stage: 'implementation', attempt: 1 }));
    expect(state.attempts.implementation).toBe(1);
    expect(state.quotaAborts.implementation).toBe(0);

    state = applyEvent(
      state,
      mkEvent(3, 'ExecutorReturned', {
        executor_id: 'cc-sonnet',
        executor_type: 'claude-code',
        account: 'claude-personal',
        stage: 'implementation',
        status: 'quota_exhausted',
        telemetry: {
          turns: 1,
          input_tokens: null,
          output_tokens: null,
          cache_read_tokens: null,
          cache_creation_tokens: null,
          wall_seconds: 1,
        },
        quota: {
          account: 'claude-personal',
          source: 'rate-limit-event',
          status: 'blocked',
          utilization: 1,
          window_kind: 'five_hour',
          resets_at: null,
        },
        raw: {
          exit_code: 0,
          signal: null,
          killed: 'none',
          observed_turns: 1,
          failure_kind: null,
          stderr_tail: '',
          transcript_path: null,
          final_message_bytes: null,
          command_line: ['claude'],
          session_id: 'sess-claude',
        },
      }),
    );
    expect(state.quotaAborts.implementation).toBe(1);
    expect(state.attempts.implementation).toBe(1);
  });
});

describe('WorktreeLockAcquired / WorktreeLockReleased error paths', () => {
  function created(): MienguEvent[] {
    return [
      mkEvent(1, 'WorkItemCreated', {
        title: 'x',
        slug: 'x',
        source: { kind: 'prd-file', path: 'p', sha256: 'a'.repeat(64), bytes: 1 },
        config_hash: 'x',
      }),
    ];
  }

  it('a double WorktreeLockAcquired throws ProjectionError', () => {
    const events = created();
    let state = applyEvent(null, events[0] as MienguEvent);
    state = applyEvent(
      state,
      mkEvent(2, 'WorktreeLockAcquired', {
        workdir: '/tmp/wd',
        holder: 'cc-sonnet',
        stage: 'implementation',
        intent: 'workspace-write',
      }),
    );
    expect(() =>
      applyEvent(
        state,
        mkEvent(3, 'WorktreeLockAcquired', {
          workdir: '/tmp/wd',
          holder: 'cx-high',
          stage: 'implementation',
          intent: 'workspace-write',
        }),
      ),
    ).toThrow(ProjectionError);
  });

  it('a foreign WorktreeLockReleased (not reclaimed) throws ProjectionError', () => {
    const events = created();
    let state = applyEvent(null, events[0] as MienguEvent);
    state = applyEvent(
      state,
      mkEvent(2, 'WorktreeLockAcquired', {
        workdir: '/tmp/wd',
        holder: 'cc-sonnet',
        stage: 'implementation',
        intent: 'workspace-write',
      }),
    );
    expect(() =>
      applyEvent(
        state,
        mkEvent(3, 'WorktreeLockReleased', {
          workdir: '/tmp/wd',
          holder: 'cx-high',
          stage: 'implementation',
          reclaimed: false,
        }),
      ),
    ).toThrow(ProjectionError);
  });

  it('a foreign WorktreeLockReleased with reclaimed:true does NOT throw', () => {
    const events = created();
    let state = applyEvent(null, events[0] as MienguEvent);
    state = applyEvent(
      state,
      mkEvent(2, 'WorktreeLockAcquired', {
        workdir: '/tmp/wd',
        holder: 'cc-sonnet',
        stage: 'implementation',
        intent: 'workspace-write',
      }),
    );
    state = applyEvent(
      state,
      mkEvent(3, 'WorktreeLockReleased', {
        workdir: '/tmp/wd',
        holder: 'cx-high',
        stage: 'implementation',
        reclaimed: true,
      }),
    );
    expect(state.worktreeLock).toBeNull();
  });

  it('a WorktreeLockReleased while unheld throws ProjectionError', () => {
    const events = created();
    const state = applyEvent(null, events[0] as MienguEvent);
    expect(() =>
      applyEvent(
        state,
        mkEvent(2, 'WorktreeLockReleased', {
          workdir: '/tmp/wd',
          holder: 'cc-sonnet',
          stage: 'implementation',
          reclaimed: false,
        }),
      ),
    ).toThrow(ProjectionError);
  });
});

describe('TestsFrozen: a second freeze for a different suite throws', () => {
  it('throws ProjectionError', () => {
    const created = mkEvent(1, 'WorkItemCreated', {
      title: 'x',
      slug: 'x',
      source: { kind: 'prd-file', path: 'p', sha256: 'a'.repeat(64), bytes: 1 },
      config_hash: 'x',
    });
    let state = applyEvent(null, created);
    state = applyEvent(
      state,
      mkEvent(2, 'TestsFrozen', {
        suite_id: 'suite-example-1',
        content_hash: 'a'.repeat(64),
        files: [],
        frozen_copy_dir: '/tmp/frozen',
      }),
    );
    expect(() =>
      applyEvent(
        state,
        mkEvent(3, 'TestsFrozen', {
          suite_id: 'suite-other-1',
          content_hash: 'b'.repeat(64),
          files: [],
          frozen_copy_dir: '/tmp/frozen2',
        }),
      ),
    ).toThrow(ProjectionError);
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
      schema_version: 2,
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
  });
});
