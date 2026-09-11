import { describe, it, expect } from 'vitest';
import { fixedClock, IsoTimestampSchema } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { AccountIdSchema, ExecutorInstanceIdSchema } from '../../src/core/ids.js';
import { DEFAULT_TIER, MienguEventSchema, StoredEventSchema } from '../../src/core/events.js';
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
const skippedOracleCommands = [
  { kind: 'build', command: null, sha256: null },
  { kind: 'typecheck', command: null, sha256: null },
  { kind: 'lint', command: null, sha256: null },
  { kind: 'test', command: null, sha256: null },
];
const oracleEvidence = { sha256: '0'.repeat(64), path: '/tmp/oracle.out', bytes: 0 };

function mkEvent(seq: number, type: EventType, data: unknown, causationId: MienguEvent['causation_id'] = null): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 4,
    event_id: ids.eventId(),
    seq,
    item_id: ITEM_ID,
    run_id: RUN_ID,
    ts: clock.now(),
    tier: DEFAULT_TIER[type],
    actor: { kind: 'system', id: null },
    causation_id: causationId,
    type,
    data,
  });
}

/** Fixture: one event per EVENT_TYPES member, plus one extra CheckpointRaised so
 * CheckpointDecided/AutoApproved each have a distinct open checkpoint to resolve, plus one
 * extra BudgetConsumed on a second account so the two-accumulator fold is exercised. */
function buildFixture(): MienguEvent[] {
  const events: MienguEvent[] = [];
  function push(type: EventType, data: unknown, causationId: MienguEvent['causation_id'] = null): void {
    events.push(mkEvent(events.length + 1, type, data, causationId));
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
  push('DriftDetected', { claim_item: ITEM_ID, claim: 'claim-example-1', expected: 'x', observed: 'y', area: 'auth' }, events.at(-1)!.event_id);
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
      priorEventIds: [...(before.priorEventIds ?? []), event.event_id],
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

  apply('StageCompleted records only the declared active item artifact kinds', () => {
    expect(state.artifacts).toEqual({
      requirementSet: null,
      architecturePlan: null,
      taskGraph: null,
      testSuiteSpec: null,
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
      { claimItem: ITEM_ID, claim: 'claim-example-1', expected: 'x', observed: 'y', area: 'auth', at: state.updatedAt },
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

  apply('WorkspaceDiscarded clears the workspace', () => {
    expect(state.workspace).toBeNull();
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

describe('applyEvent: Phase 6 brownfield folds', () => {
  const evidenceData = {
    ladder_tier: 'tests-as-spec' as const,
    collector_version: 1,
    target_repo_sha256: 'a'.repeat(64),
    scope: {
      target_commit: 'b'.repeat(40), roots: [], paths: [], dependency_depth: 0,
      max_files: 1, truncated: false, sha256: 'c'.repeat(64),
    },
    coverage: 'complete' as const,
    facts: [],
    omissions: [],
    evidence: { sha256: 'd'.repeat(64), path: 'brownfield/evidence.json', bytes: 1 },
  };
  const proposalData = {
    target_commit: 'b'.repeat(40), scope_sha256: 'c'.repeat(64), subject: null,
    assertion: 'the selected test exists', area: null,
    predicate: { kind: 'path-exists' as const, path: 'test/example.test.ts', expected: true },
  };
  const evaluationData = (proposalEventId: MienguEvent['event_id']) => ({
    proposal_event_id: proposalEventId, target_commit: 'b'.repeat(40), outcome: 'confirmed' as const,
    reason: 'predicate-true' as const, expected: 'true', observed: 'true', duration_ms: 0,
    evidence: { sha256: 'e'.repeat(64), path: 'brownfield/evaluation.json', bytes: 1 },
  });

  it('folds durable brownfield evidence and predicate chain as envelope-only state changes', () => {
    const created = mkEvent(1, 'WorkItemCreated', {
      title: 'brownfield', slug: 'brownfield',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 }, config_hash: 'x',
    });
    const evidence = mkEvent(2, 'BrownfieldEvidenceRecorded', evidenceData);
    const proposal = mkEvent(3, 'BrownfieldPredicateProposed', proposalData, evidence.event_id);
    const evaluation = mkEvent(4, 'BrownfieldPredicateEvaluated', evaluationData(proposal.event_id), proposal.event_id);
    let state = applyEvent(null, created);
    for (const event of [evidence, proposal, evaluation]) {
      const before = state;
      state = applyEvent(state, event);
      expect(state).toEqual({
        ...before,
        seq: event.seq,
        lastEventId: event.event_id,
        priorEventIds: [...(before.priorEventIds ?? []), event.event_id],
        updatedAt: event.ts,
      });
    }
  });

  it('rejects missing or mismatched brownfield causal references', () => {
    const created = mkEvent(1, 'WorkItemCreated', {
      title: 'brownfield', slug: 'brownfield',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 }, config_hash: 'x',
    });
    const state = applyEvent(null, created);
    expect(() => applyEvent(state, mkEvent(2, 'BrownfieldPredicateProposed', proposalData))).toThrow(/existing prior event/);
    const evidence = mkEvent(2, 'BrownfieldEvidenceRecorded', evidenceData);
    const afterEvidence = applyEvent(state, evidence);
    const proposal = mkEvent(3, 'BrownfieldPredicateProposed', proposalData, evidence.event_id);
    const afterProposal = applyEvent(afterEvidence, proposal);
    expect(() => applyEvent(afterProposal, mkEvent(4, 'BrownfieldPredicateEvaluated', evaluationData(proposal.event_id), evidence.event_id))).toThrow(/proposal event/);
    expect(() => applyEvent(afterProposal, mkEvent(4, 'DriftDetected', {
      claim_item: ITEM_ID, claim: 'claim-example-1', expected: 'expected', observed: 'observed', area: null,
    }))).toThrow(/existing prior event/);
  });
});

describe('project: Phase 6 legacy v3 compatibility and brownfield causal integrity', () => {
  const source = { kind: 'prd-file' as const, path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 };
  const created = (): MienguEvent =>
    mkEvent(1, 'WorkItemCreated', { title: 't', slug: 's', source, config_hash: 'x' });
  const evidenceData = {
    ladder_tier: 'tests-as-spec' as const,
    collector_version: 1,
    target_repo_sha256: 'a'.repeat(64),
    scope: {
      target_commit: 'b'.repeat(40), roots: [], paths: [], dependency_depth: 0,
      max_files: 1, truncated: false, sha256: 'c'.repeat(64),
    },
    coverage: 'complete' as const,
    facts: [],
    omissions: [],
    evidence: { sha256: 'd'.repeat(64), path: 'brownfield/evidence.json', bytes: 1 },
  };
  const proposalData = {
    target_commit: 'b'.repeat(40), scope_sha256: 'c'.repeat(64), subject: null,
    assertion: 'the selected test exists', area: null,
    predicate: { kind: 'path-exists' as const, path: 'test/example.test.ts', expected: true },
  };
  const evaluationData = (proposalEventId: MienguEvent['event_id'], targetCommit = 'b'.repeat(40)) => ({
    proposal_event_id: proposalEventId, target_commit: targetCommit, outcome: 'confirmed' as const,
    reason: 'predicate-true' as const, expected: 'true', observed: 'true', duration_ms: 0,
    evidence: { sha256: 'e'.repeat(64), path: 'brownfield/evaluation.json', bytes: 1 },
  });

  it('replays a legacy v3 DriftDetected with no causation after it is upcast to v4', () => {
    const wic = created();
    const v3Drift = {
      schema_version: 3,
      event_id: ids.eventId(),
      seq: 2,
      item_id: ITEM_ID,
      run_id: RUN_ID,
      ts: clock.now(),
      tier: DEFAULT_TIER.DriftDetected,
      actor: { kind: 'system', id: null },
      causation_id: null,
      type: 'DriftDetected',
      data: { claim: 'claim-example-1', expected: 'x', observed: 'y', area: 'auth' },
    };
    const upcast = StoredEventSchema.parse(v3Drift) as MienguEvent;
    expect(upcast.schema_version).toBe(4);

    const state = project([wic, upcast]);
    expect(state.drift).toEqual([
      { claimItem: ITEM_ID, claim: 'claim-example-1', expected: 'x', observed: 'y', area: 'auth', at: state.updatedAt },
    ]);
    // Still appendable: a following v4 event folds onto the upcast prefix without error.
    const consumed = mkEvent(3, 'BudgetConsumed', { scope: 'task', account: 'claude-personal', wall_seconds: 1, turns: 1, usd: null }, upcast.event_id);
    expect(() => project([wic, upcast, consumed])).not.toThrow();
  });

  it('still rejects a fresh v4 DriftDetected with no causal anchor on the append path', () => {
    const state = applyEvent(null, created());
    expect(() =>
      applyEvent(state, mkEvent(2, 'DriftDetected', {
        claim_item: ITEM_ID, claim: 'claim-example-1', expected: 'x', observed: 'y', area: null,
      })),
    ).toThrow(/reference an existing prior event/);
  });

  it('rejects a native v4 DriftDetected with no causal anchor during full replay', () => {
    const wic = created();
    const drift = mkEvent(2, 'DriftDetected', {
      claim_item: ITEM_ID, claim: 'claim-example-1', expected: 'x', observed: 'y', area: null,
    });
    expect(() => project([wic, drift])).toThrow(/reference an existing prior event/);
  });

  it('rejects a DriftDetected whose non-null causation does not resolve, even on replay', () => {
    const wic = created();
    const drift = mkEvent(2, 'DriftDetected', {
      claim_item: ITEM_ID, claim: 'claim-example-1', expected: 'x', observed: 'y', area: null,
    }, ids.eventId());
    expect(() => project([wic, drift])).toThrow(/reference an existing prior event/);
  });

  it('replays a well-formed evidence/proposal/evaluation/drift chain', () => {
    const wic = created();
    const evidence = mkEvent(2, 'BrownfieldEvidenceRecorded', evidenceData);
    const proposal = mkEvent(3, 'BrownfieldPredicateProposed', proposalData, evidence.event_id);
    const evaluation = mkEvent(4, 'BrownfieldPredicateEvaluated', evaluationData(proposal.event_id), proposal.event_id);
    const drift = mkEvent(5, 'DriftDetected', {
      claim_item: ITEM_ID, claim: 'claim-example-1', expected: 'x', observed: 'y', area: null,
    }, evaluation.event_id);
    const state = project([wic, evidence, proposal, evaluation, drift]);
    expect(state.seq).toBe(5);
    expect(state.drift).toEqual([
      { claimItem: ITEM_ID, claim: 'claim-example-1', expected: 'x', observed: 'y', area: null, at: state.updatedAt },
    ]);
  });

  it('rejects a BrownfieldPredicateEvaluated whose target_commit differs from its proposal', () => {
    const wic = created();
    const evidence = mkEvent(2, 'BrownfieldEvidenceRecorded', evidenceData);
    const proposal = mkEvent(3, 'BrownfieldPredicateProposed', proposalData, evidence.event_id);
    const evaluation = mkEvent(4, 'BrownfieldPredicateEvaluated', evaluationData(proposal.event_id, 'f'.repeat(40)), proposal.event_id);
    expect(() => project([wic, evidence, proposal, evaluation])).toThrow(/matching target_commit/);
  });

  it('rejects a BrownfieldPredicateEvaluated that references a non-proposal event', () => {
    const wic = created();
    const evidence = mkEvent(2, 'BrownfieldEvidenceRecorded', evidenceData);
    const evaluation = mkEvent(3, 'BrownfieldPredicateEvaluated', evaluationData(evidence.event_id), evidence.event_id);
    expect(() => project([wic, evidence, evaluation])).toThrow(/BrownfieldPredicateProposed/);
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
      schema_version: 4,
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

describe('applyEvent: Phase 3 tamper rejection', () => {
  function taskRuntime(): {
    state: ReturnType<typeof applyEvent>;
    append: (type: EventType, data: unknown, causationId?: MienguEvent['causation_id']) => MienguEvent;
  } {
    let state = applyEvent(null, mkEvent(1, 'WorkItemCreated', {
      title: 'phase three', slug: 'phase-three',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 },
      config_hash: 'b'.repeat(64),
    }));
    const append = (type: EventType, data: unknown, causationId: MienguEvent['causation_id'] = null): MienguEvent => {
      const event = mkEvent(state.seq + 1, type, data, causationId);
      state = applyEvent(state, event);
      return event;
    };
    const graph = append('StageCompleted', {
      stage: 'planning', attempt: 1,
      artifact: { kind: 'task-graph', sha256: 'c'.repeat(64), body: { tasks: [{ task_id: 'task-example-1' }] } },
    });
    append('TaskGraphActivated', { graph_event_id: graph.event_id, ordered_task_ids: ['task-example-1'] });
    append('TaskStarted', { task_id: 'task-example-1', order_index: 0, graph_event_id: graph.event_id });
    const implementation = append('StageCompleted', {
      stage: 'implementation', attempt: 1,
      artifact: { kind: 'implementation', sha256: 'd'.repeat(64), body: {} },
    });
    const review = append('StageCompleted', {
      stage: 'review', attempt: 1,
      artifact: { kind: 'review-verdict', sha256: 'e'.repeat(64), body: { verdict: 'accept' } },
    });
    void implementation;
    void review;
    return { get state() { return state; }, append };
  }

  function acceptCurrentTask(fixture: ReturnType<typeof taskRuntime>): void {
    const task = fixture.state.tasks!.records['task-example-1']!;
    const sweep = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: task.taskId, cause_id: null, commands: skippedOracleCommands,
    });
    fixture.append('OracleSweepCompleted', {
      sweep_id: sweep.event_id, scope: 'task', task_id: task.taskId,
      outcome: 'passed', failed_kind: null, result_event_ids: [],
    });
    const review = fixture.append('StageCompleted', {
      stage: 'review', attempt: 2,
      artifact: { kind: 'review-verdict', sha256: 'b'.repeat(64), body: { verdict: 'accept' } },
    });
    const checkpoint = fixture.append('WorkspaceCheckpointed', {
      kind: 'task-accepted', task_id: task.taskId, parent_commit: 'a'.repeat(40),
      commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 },
    });
    fixture.append('TaskAccepted', {
      task_id: task.taskId, implementation_event_id: task.implementation!.eventId,
      review_event_id: review.event_id, oracle_sweep_id: sweep.event_id,
      checkpoint_event_id: checkpoint.event_id,
    }, checkpoint.event_id);
  }

  it('rejects a duplicate task activation order', () => {
    const state = applyEvent(null, mkEvent(1, 'WorkItemCreated', {
      title: 'phase three', slug: 'phase-three',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 }, config_hash: 'b'.repeat(64),
    }));
    const graph = mkEvent(2, 'StageCompleted', {
      stage: 'planning', attempt: 1,
      artifact: { kind: 'task-graph', sha256: 'c'.repeat(64), body: { tasks: [{ task_id: 'task-example-1' }] } },
    });
    const planned = applyEvent(state, graph);
    const activation = mkEvent(3, 'TaskGraphActivated', {
      graph_event_id: graph.event_id, ordered_task_ids: ['task-example-1', 'task-example-1'],
    });
    expect(() => applyEvent(planned, activation)).toThrow(ProjectionError);
  });

  it('rejects FailureCauseOpened with a trigger that is not an existing prior event', () => {
    const fixture = taskRuntime();
    expect(() => fixture.append('FailureCauseOpened', {
      trigger_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', parent_cause_id: null,
      kind: 'oracle', task_id: 'task-example-1', initial_level: 'coder',
      affects: { req_ids: [], component_ids: [], task_ids: ['task-example-1'] }, summary: 'tampered',
    })).toThrow(/existing prior event/);
  });

  it('rejects ArtifactsInvalidated without its active cause, active artifact ids, and active task set', () => {
    const fixture = taskRuntime();
    const task = fixture.state.tasks!.records['task-example-1']!;
    const cause = fixture.append('FailureCauseOpened', {
      trigger_event_id: task.implementation!.eventId, parent_cause_id: null, kind: 'oracle',
      task_id: task.taskId, initial_level: 'coder',
      affects: { req_ids: [], component_ids: [], task_ids: [task.taskId] }, summary: 'oracle',
    });
    expect(() => fixture.append('ArtifactsInvalidated', {
      cause_id: cause.event_id, target: 'coder',
      affected_ids: { req_ids: [], component_ids: [], task_ids: ['task-example-2'] },
      artifact_event_ids: [task.implementation!.eventId], reason: 'tampered task set',
    })).toThrow(/valid active task set/);
    expect(() => fixture.append('ArtifactsInvalidated', {
      cause_id: cause.event_id, target: 'coder',
      affected_ids: { req_ids: [], component_ids: [], task_ids: [task.taskId] },
      artifact_event_ids: ['evt-01234567-89ab-cdef-0123-456789abcdef'], reason: 'tampered artifact id',
    })).toThrow(/currently active artifacts/);
    fixture.append('FailureCauseResolved', {
      cause_id: cause.event_id, task_id: task.taskId, resolution: 'done',
    });
    expect(() => fixture.append('ArtifactsInvalidated', {
      cause_id: cause.event_id, target: 'coder',
      affected_ids: { req_ids: [], component_ids: [], task_ids: [task.taskId] },
      artifact_event_ids: [task.implementation!.eventId], reason: 'resolved cause',
    })).toThrow(/currently active matching cause/);
  });

  it('rejects FinalPatchCaptured until all tasks are accepted and the current integration sweep passed', () => {
    const fixture = taskRuntime();
    const data = {
      original_base_commit: 'a'.repeat(40), accepted_head_commit: 'b'.repeat(40),
      patch: { sha256: 'c'.repeat(64), path: '/tmp/final.patch', bytes: 1 },
      files: [], insertions: 0, deletions: 0,
    };
    expect(() => fixture.append('FinalPatchCaptured', data)).toThrow(/all tasks accepted/);
    acceptCurrentTask(fixture);
    expect(() => fixture.append('FinalPatchCaptured', data)).toThrow(/current integration sweep/);
    const sweep = fixture.append('OracleSweepStarted', {
      scope: 'integration', task_id: null, cause_id: null, commands: skippedOracleCommands,
    });
    fixture.append('OracleSweepCompleted', {
      sweep_id: sweep.event_id, scope: 'integration', task_id: null,
      outcome: 'passed', failed_kind: null, result_event_ids: [],
    });
    expect(fixture.append('FinalPatchCaptured', data).type).toBe('FinalPatchCaptured');
  });

  it('requires the persisted task order to be Kahn-topological with ascending task-id ties', () => {
    const state = applyEvent(null, mkEvent(1, 'WorkItemCreated', {
      title: 'phase three', slug: 'phase-three',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 }, config_hash: 'b'.repeat(64),
    }));
    // task-example-3 is deliberately declared before its dependency; task-example-1,
    // task-example-2, and task-example-4 are initially independent.
    const graph = mkEvent(2, 'StageCompleted', {
      stage: 'planning', attempt: 1,
      artifact: { kind: 'task-graph', sha256: 'c'.repeat(64), body: { tasks: [
        { task_id: 'task-example-3', depends_on: ['task-example-2'] },
        { task_id: 'task-example-4', depends_on: [] },
        { task_id: 'task-example-2', depends_on: [] },
        { task_id: 'task-example-1', depends_on: [] },
      ] } },
    });
    const planned = applyEvent(state, graph);
    const declarationOrder = mkEvent(3, 'TaskGraphActivated', {
      graph_event_id: graph.event_id,
      ordered_task_ids: ['task-example-3', 'task-example-4', 'task-example-2', 'task-example-1'],
    });
    expect(() => applyEvent(planned, declarationOrder)).toThrow(/deterministic topological order/);

    const canonical = mkEvent(3, 'TaskGraphActivated', {
      graph_event_id: graph.event_id,
      ordered_task_ids: ['task-example-1', 'task-example-2', 'task-example-3', 'task-example-4'],
    });
    expect(applyEvent(planned, canonical).tasks?.order).toEqual(canonical.data.ordered_task_ids);
  });

  it('rejects a TaskAccepted event tied to a failed sweep', () => {
    const fixture = taskRuntime();
    const sweep = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null, commands: [
        { kind: 'build', command: 'false', sha256: 'f'.repeat(64) },
        { kind: 'typecheck', command: null, sha256: null },
        { kind: 'lint', command: null, sha256: null },
        { kind: 'test', command: null, sha256: null },
      ],
    });
    const result = fixture.append('OracleResultRecorded', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', kind: 'build',
      command: 'false', command_sha256: 'f'.repeat(64), status: 'failed', exit_code: 1,
      signal: null, duration_ms: 1, stdout: oracleEvidence, stderr: oracleEvidence,
    });
    fixture.append('OracleSweepCompleted', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', outcome: 'failed',
      failed_kind: 'build', result_event_ids: [result.event_id],
    });
    const checkpoint = fixture.append('WorkspaceCheckpointed', {
      kind: 'task-accepted', task_id: 'task-example-1', parent_commit: 'a'.repeat(40),
      commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 },
    });
    const task = fixture.state.tasks?.records['task-example-1'];
    expect(task).toBeDefined();
    expect(() => fixture.append('TaskAccepted', {
      task_id: 'task-example-1', implementation_event_id: task!.implementation!.eventId,
      review_event_id: task!.review!.eventId, oracle_sweep_id: sweep.event_id,
      checkpoint_event_id: checkpoint.event_id,
    })).toThrow(ProjectionError);
  });

  it('rejects an in-memory tampered oracle result missing either durable stream reference', () => {
    const fixture = taskRuntime();
    const sweep = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null,
      commands: [
        { kind: 'build', command: 'build', sha256: 'a'.repeat(64) },
        { kind: 'typecheck', command: null, sha256: null },
        { kind: 'lint', command: null, sha256: null },
        { kind: 'test', command: null, sha256: null },
      ],
    });
    const valid = mkEvent(fixture.state.seq + 1, 'OracleResultRecorded', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', kind: 'build',
      command: 'build', command_sha256: 'a'.repeat(64), status: 'passed', exit_code: 0,
      signal: null, duration_ms: 0, stdout: oracleEvidence, stderr: oracleEvidence,
    });
    for (const missing of ['stdout', 'stderr'] as const) {
      const tampered = {
        ...valid,
        data: { ...valid.data, [missing]: null },
      } as unknown as MienguEvent;
      expect(() => applyEvent(fixture.state, tampered)).toThrow(/durable stdout and stderr evidence/);
    }
  });

  it('rejects a historical passing sweep after a newer implementation was recorded', () => {
    const fixture = taskRuntime();
    const passing = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null, commands: skippedOracleCommands,
    });
    fixture.append('OracleSweepCompleted', {
      sweep_id: passing.event_id, scope: 'task', task_id: 'task-example-1', outcome: 'passed',
      failed_kind: null, result_event_ids: [],
    });
    fixture.append('StageCompleted', {
      stage: 'implementation', attempt: 2,
      artifact: { kind: 'implementation', sha256: '1'.repeat(64), body: {} },
    });
    const currentReview = fixture.append('StageCompleted', {
      stage: 'review', attempt: 2,
      artifact: { kind: 'review-verdict', sha256: '2'.repeat(64), body: { verdict: 'accept' } },
    });
    const checkpoint = fixture.append('WorkspaceCheckpointed', {
      kind: 'task-accepted', task_id: 'task-example-1', parent_commit: 'a'.repeat(40),
      commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 },
    });
    const task = fixture.state.tasks!.records['task-example-1']!;
    expect(() => fixture.append('TaskAccepted', {
      task_id: 'task-example-1', implementation_event_id: task.implementation!.eventId,
      review_event_id: currentReview.event_id, oracle_sweep_id: passing.event_id,
      checkpoint_event_id: checkpoint.event_id,
    })).toThrow(ProjectionError);
  });

  it('rejects a passing sweep superseded by a newer sweep for the same implementation', () => {
    const fixture = taskRuntime();
    const passing = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null, commands: skippedOracleCommands,
    });
    fixture.append('OracleSweepCompleted', {
      sweep_id: passing.event_id, scope: 'task', task_id: 'task-example-1', outcome: 'passed',
      failed_kind: null, result_event_ids: [],
    });
    const failing = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null, commands: [
        { kind: 'build', command: 'false', sha256: '3'.repeat(64) },
        { kind: 'typecheck', command: null, sha256: null },
        { kind: 'lint', command: null, sha256: null },
        { kind: 'test', command: null, sha256: null },
      ],
    });
    const result = fixture.append('OracleResultRecorded', {
      sweep_id: failing.event_id, scope: 'task', task_id: 'task-example-1', kind: 'build',
      command: 'false', command_sha256: '3'.repeat(64), status: 'failed', exit_code: 1,
      signal: null, duration_ms: 1, stdout: oracleEvidence, stderr: oracleEvidence,
    });
    fixture.append('OracleSweepCompleted', {
      sweep_id: failing.event_id, scope: 'task', task_id: 'task-example-1', outcome: 'failed',
      failed_kind: 'build', result_event_ids: [result.event_id],
    });
    const checkpoint = fixture.append('WorkspaceCheckpointed', {
      kind: 'task-accepted', task_id: 'task-example-1', parent_commit: 'a'.repeat(40),
      commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 },
    });
    const task = fixture.state.tasks!.records['task-example-1']!;
    expect(() => fixture.append('TaskAccepted', {
      task_id: 'task-example-1', implementation_event_id: task.implementation!.eventId,
      review_event_id: task.review!.eventId, oracle_sweep_id: passing.event_id,
      checkpoint_event_id: checkpoint.event_id,
    })).toThrow(/latest completed passing sweep/);
  });

  it('rejects a task checkpoint created before the current implementation, sweep, and review', () => {
    const fixture = taskRuntime();
    const staleCheckpoint = fixture.append('WorkspaceCheckpointed', {
      kind: 'task-accepted', task_id: 'task-example-1', parent_commit: 'a'.repeat(40),
      commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 },
    });
    const implementation = fixture.append('StageCompleted', {
      stage: 'implementation', attempt: 2,
      artifact: { kind: 'implementation', sha256: '1'.repeat(64), body: {} },
    });
    const sweep = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null, commands: skippedOracleCommands,
    });
    fixture.append('OracleSweepCompleted', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', outcome: 'passed',
      failed_kind: null, result_event_ids: [],
    });
    const review = fixture.append('StageCompleted', {
      stage: 'review', attempt: 2,
      artifact: { kind: 'review-verdict', sha256: '2'.repeat(64), body: { verdict: 'accept' } },
    });
    expect(() => fixture.append('TaskAccepted', {
      task_id: 'task-example-1', implementation_event_id: implementation.event_id,
      review_event_id: review.event_id, oracle_sweep_id: sweep.event_id,
      checkpoint_event_id: staleCheckpoint.event_id,
    }, staleCheckpoint.event_id)).toThrow(/checkpoint causally created after/);
  });

  it('rejects a checkpoint that is temporally fresh but not the TaskAccepted cause', () => {
    const fixture = taskRuntime();
    const implementation = fixture.append('StageCompleted', {
      stage: 'implementation', attempt: 2,
      artifact: { kind: 'implementation', sha256: '1'.repeat(64), body: {} },
    });
    const sweep = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null, commands: skippedOracleCommands,
    });
    fixture.append('OracleSweepCompleted', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', outcome: 'passed',
      failed_kind: null, result_event_ids: [],
    });
    const review = fixture.append('StageCompleted', {
      stage: 'review', attempt: 2,
      artifact: { kind: 'review-verdict', sha256: '2'.repeat(64), body: { verdict: 'accept' } },
    });
    const checkpoint = fixture.append('WorkspaceCheckpointed', {
      kind: 'task-accepted', task_id: 'task-example-1', parent_commit: 'a'.repeat(40),
      commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 },
    });
    expect(() => fixture.append('TaskAccepted', {
      task_id: 'task-example-1', implementation_event_id: implementation.event_id,
      review_event_id: review.event_id, oracle_sweep_id: sweep.event_id,
      checkpoint_event_id: checkpoint.event_id,
    })).toThrow(/checkpoint causally created after/);
  });

  it('rejects TaskAccepted when its referenced ReviewVerdict is not accept', () => {
    const fixture = taskRuntime();
    const task = fixture.state.tasks!.records['task-example-1']!;
    const sweep = fixture.append('OracleSweepStarted', { scope: 'task', task_id: task.taskId, cause_id: null, commands: skippedOracleCommands });
    fixture.append('OracleSweepCompleted', { sweep_id: sweep.event_id, scope: 'task', task_id: task.taskId, outcome: 'passed', failed_kind: null, result_event_ids: [] });
    const review = fixture.append('StageCompleted', { stage: 'review', attempt: 2, artifact: { kind: 'review-verdict', sha256: '3'.repeat(64), body: { verdict: 'revise' } } });
    const checkpoint = fixture.append('WorkspaceCheckpointed', { kind: 'task-accepted', task_id: task.taskId, parent_commit: 'a'.repeat(40), commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 } });
    expect(() => fixture.append('TaskAccepted', {
      task_id: task.taskId, implementation_event_id: task.implementation!.eventId, review_event_id: review.event_id,
      oracle_sweep_id: sweep.event_id, checkpoint_event_id: checkpoint.event_id,
    }, checkpoint.event_id)).toThrow(/accepting ReviewVerdict/);
  });

  it.each(['oracle', 'test', 'review-revision'] as const)('rejects TaskAccepted while an active corrective %s cause remains after a passing sweep', (kind) => {
    const fixture = taskRuntime();
    const task = fixture.state.tasks!.records['task-example-1']!;
    const cause = fixture.append('FailureCauseOpened', {
      trigger_event_id: task.implementation!.eventId, parent_cause_id: null, kind, task_id: task.taskId,
      initial_level: 'coder', affects: { req_ids: [], component_ids: [], task_ids: [task.taskId] }, summary: kind,
    });
    const sweep = fixture.append('OracleSweepStarted', { scope: 'task', task_id: task.taskId, cause_id: cause.event_id, commands: skippedOracleCommands });
    fixture.append('OracleSweepCompleted', { sweep_id: sweep.event_id, scope: 'task', task_id: task.taskId, outcome: 'passed', failed_kind: null, result_event_ids: [] });
    const review = fixture.append('StageCompleted', { stage: 'review', attempt: 2, artifact: { kind: 'review-verdict', sha256: '3'.repeat(64), body: { verdict: 'accept' } } });
    const checkpoint = fixture.append('WorkspaceCheckpointed', { kind: 'task-accepted', task_id: task.taskId, parent_commit: 'a'.repeat(40), commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 } });
    expect(() => fixture.append('TaskAccepted', {
      task_id: task.taskId, implementation_event_id: task.implementation!.eventId, review_event_id: review.event_id,
      oracle_sweep_id: sweep.event_id, checkpoint_event_id: checkpoint.event_id,
    }, checkpoint.event_id)).toThrow(/active failure cause/);
  });

  it('rejects a task-accepted checkpoint without patch evidence', () => {
    const fixture = taskRuntime();
    expect(() => fixture.append('WorkspaceCheckpointed', {
      kind: 'task-accepted', task_id: 'task-example-1', parent_commit: 'a'.repeat(40),
      commit: 'b'.repeat(40), patch: null,
    })).toThrow(/patch evidence/);
  });

  it('rejects a repeat acceptance after the task is already accepted', () => {
    const fixture = taskRuntime();
    const task = fixture.state.tasks!.records['task-example-1']!;
    const sweep = fixture.append('OracleSweepStarted', { scope: 'task', task_id: task.taskId, cause_id: null, commands: skippedOracleCommands });
    fixture.append('OracleSweepCompleted', { sweep_id: sweep.event_id, scope: 'task', task_id: task.taskId, outcome: 'passed', failed_kind: null, result_event_ids: [] });
    const review = fixture.append('StageCompleted', { stage: 'review', attempt: 2, artifact: { kind: 'review-verdict', sha256: '3'.repeat(64), body: { verdict: 'accept' } } });
    const checkpoint = fixture.append('WorkspaceCheckpointed', { kind: 'task-accepted', task_id: task.taskId, parent_commit: 'a'.repeat(40), commit: 'b'.repeat(40), patch: { sha256: 'a'.repeat(64), path: '/tmp/a.patch', bytes: 1 } });
    fixture.append('TaskAccepted', {
      task_id: task.taskId, implementation_event_id: task.implementation!.eventId, review_event_id: review.event_id,
      oracle_sweep_id: sweep.event_id, checkpoint_event_id: checkpoint.event_id,
    }, checkpoint.event_id);
    expect(() => fixture.append('TaskAccepted', {
      task_id: task.taskId, implementation_event_id: task.implementation!.eventId, review_event_id: review.event_id,
      oracle_sweep_id: sweep.event_id, checkpoint_event_id: checkpoint.event_id,
    }, checkpoint.event_id)).toThrow(/already accepted/);
  });

  it('requires complete fixed oracle declarations and an exact passing result prefix', () => {
    const fixture = taskRuntime();
    expect(() => fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null,
      commands: [
        { kind: 'build', command: 'build', sha256: 'a'.repeat(64) },
        { kind: 'lint', command: 'lint', sha256: 'b'.repeat(64) },
      ],
    })).toThrow(/complete fixed/);
    const sweep = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null,
      commands: [
        { kind: 'build', command: 'build', sha256: 'a'.repeat(64) },
        { kind: 'typecheck', command: null, sha256: null },
        { kind: 'lint', command: 'lint', sha256: 'b'.repeat(64) },
        { kind: 'test', command: null, sha256: null },
      ],
    });
    expect(() => fixture.append('OracleResultRecorded', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', kind: 'lint',
      command: 'lint', command_sha256: 'b'.repeat(64), status: 'passed', exit_code: 0,
      signal: null, duration_ms: 0, stdout: oracleEvidence, stderr: oracleEvidence,
    })).toThrow(/next declared oracle command/);
    fixture.append('OracleResultRecorded', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', kind: 'build',
      command: 'build', command_sha256: 'a'.repeat(64), status: 'passed', exit_code: 0,
      signal: null, duration_ms: 0, stdout: oracleEvidence, stderr: oracleEvidence,
    });
    expect(() => fixture.append('OracleSweepCompleted', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', outcome: 'passed',
      failed_kind: null, result_event_ids: fixture.state.oracleSweeps[sweep.event_id]!.resultEventIds,
    })).toThrow(/exact executed oracle prefix/);
    expect(() => fixture.append('OracleResultRecorded', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', kind: 'lint',
      command: 'lint --changed', command_sha256: 'b'.repeat(64), status: 'passed', exit_code: 0,
      signal: null, duration_ms: 0, stdout: oracleEvidence, stderr: oracleEvidence,
    })).toThrow(/next declared oracle command/);
    expect(() => fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null,
      commands: [
        { kind: 'typecheck', command: null, sha256: null },
        { kind: 'build', command: null, sha256: null },
        { kind: 'lint', command: null, sha256: null },
        { kind: 'test', command: null, sha256: null },
      ],
    })).toThrow(/complete fixed/);
  });

  it('rejects an oracle result appended after the first non-passing result', () => {
    const fixture = taskRuntime();
    const sweep = fixture.append('OracleSweepStarted', {
      scope: 'task', task_id: 'task-example-1', cause_id: null,
      commands: [
        { kind: 'build', command: 'build', sha256: 'a'.repeat(64) },
        { kind: 'typecheck', command: 'typecheck', sha256: 'b'.repeat(64) },
        { kind: 'lint', command: null, sha256: null },
        { kind: 'test', command: null, sha256: null },
      ],
    });
    fixture.append('OracleResultRecorded', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', kind: 'build',
      command: 'build', command_sha256: 'a'.repeat(64), status: 'failed', exit_code: 1,
      signal: null, duration_ms: 0, stdout: oracleEvidence, stderr: oracleEvidence,
    });
    expect(() => fixture.append('OracleResultRecorded', {
      sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', kind: 'typecheck',
      command: 'typecheck', command_sha256: 'b'.repeat(64), status: 'passed', exit_code: 0,
      signal: null, duration_ms: 0, stdout: oracleEvidence, stderr: oracleEvidence,
    })).toThrow(/cannot follow a non-passing/);
  });

  it('validates WorkspaceRestored against its preceding invalidation, frozen checkpoint, and retained mapping', () => {
    const fixture = taskRuntime();
    const task = fixture.state.tasks!.records['task-example-1']!;
    const frozen = fixture.append('WorkspaceCheckpointed', {
      kind: 'tests-frozen', task_id: null, parent_commit: 'a'.repeat(40), commit: 'b'.repeat(40), patch: null,
    });
    const cause = fixture.append('FailureCauseOpened', {
      trigger_event_id: task.implementation!.eventId, parent_cause_id: null, kind: 'review-revision', task_id: task.taskId,
      initial_level: 'coder', affects: { req_ids: [], component_ids: [], task_ids: [task.taskId] }, summary: 'review',
    });
    fixture.append('ArtifactsInvalidated', {
      cause_id: cause.event_id, target: 'coder', affected_ids: { req_ids: [], component_ids: [], task_ids: [task.taskId] },
      artifact_event_ids: [task.implementation!.eventId, task.review!.eventId], reason: 'retry',
    });
    expect(() => fixture.append('WorkspaceRestored', {
      cause_id: cause.event_id, target: 'coder', base_checkpoint_event_id: frozen.event_id, base_commit: 'a'.repeat(40),
      retained_task_commits: [], invalidated_task_ids: [],
    })).toThrow(/invalidated task set/);
    expect(fixture.append('WorkspaceRestored', {
      cause_id: cause.event_id, target: 'coder', base_checkpoint_event_id: frozen.event_id, base_commit: 'a'.repeat(40),
      retained_task_commits: [], invalidated_task_ids: [task.taskId],
    }).type).toBe('WorkspaceRestored');
  });

  it.each(['architect', 'analyst'] as const)('clears integration sweep and final patch when %s invalidates artifacts', (target) => {
    const fixture = taskRuntime();
    const testSuite = fixture.append('StageCompleted', {
      stage: 'test-authoring', attempt: 1,
      artifact: { kind: 'test-suite-spec', sha256: 'a'.repeat(64), body: {} },
    });
    fixture.append('TestsFrozen', {
      suite_id: 'suite-example-1', content_hash: 'a'.repeat(64),
      files: [], frozen_copy_dir: '/tmp/frozen',
    });
    const frozenCheckpoint = fixture.append('WorkspaceCheckpointed', {
      kind: 'tests-frozen', task_id: null, parent_commit: 'a'.repeat(40), commit: 'b'.repeat(40), patch: null,
    });
    acceptCurrentTask(fixture);
    const sweep = fixture.append('OracleSweepStarted', { scope: 'integration', task_id: null, cause_id: null, commands: skippedOracleCommands });
    fixture.append('OracleSweepCompleted', { sweep_id: sweep.event_id, scope: 'integration', task_id: null, outcome: 'passed', failed_kind: null, result_event_ids: [] });
    fixture.append('FinalPatchCaptured', { original_base_commit: 'a'.repeat(40), accepted_head_commit: 'b'.repeat(40), patch: { sha256: 'c'.repeat(64), path: '/tmp/final.patch', bytes: 1 }, files: [], insertions: 0, deletions: 0 });
    const cause = fixture.append('FailureCauseOpened', {
      trigger_event_id: sweep.event_id, parent_cause_id: null, kind: target === 'architect' ? 'architecture' : 'requirements', task_id: null,
      initial_level: target, affects: { req_ids: [], component_ids: [], task_ids: [] }, summary: target,
    });
    const state = applyEvent(fixture.state, mkEvent(fixture.state.seq + 1, 'ArtifactsInvalidated', {
      cause_id: cause.event_id, target, affected_ids: { req_ids: [], component_ids: [], task_ids: [] }, artifact_event_ids: [testSuite.event_id], reason: target,
    }));
    expect(state.integration).toEqual({ status: 'pending', sweepId: null, finalPatch: null });
    expect(state.artifacts.testSuiteSpec).toBeNull();
    expect(state.frozenTests).toBeNull();
    expect(state.workspaceCheckpoints[frozenCheckpoint.event_id]).toBeUndefined();
  });
});
