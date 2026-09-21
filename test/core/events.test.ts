import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  DEFAULT_TIER,
  MienguEventSchema,
  StoredEventSchema,
} from '../../src/core/events.js';
import type { EventType } from '../../src/core/events.js';

type DiscriminatedMember = z.ZodObject<{ type: z.ZodLiteral<EventType> }>;

const BASE_ENVELOPE = {
  schema_version: EVENT_SCHEMA_VERSION,
  event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef',
  seq: 1,
  item_id: 'wi-example-abc123',
  run_id: 'run-01234567-89ab-cdef-0123-456789abcdef',
  ts: '2024-01-01T00:00:00.000Z',
  tier: 'T1',
  actor: { kind: 'system', id: null },
  causation_id: null,
};

const ORACLE_EVIDENCE = { sha256: 'a'.repeat(64), path: '/tmp/oracle.out', bytes: 0 };

const VALID_DATA: Record<EventType, Record<string, unknown>> = {
  HumanAnswerRecorded: { assumption_id: 'assumption-example-1', answer: 'Use the proposed behaviour' },
  WorkItemCreated: {
    title: 'Example item',
    slug: 'example',
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    config_hash: 'deadbeef',
  },
  WorkItemParked: {
    reason: 'budget-exhausted',
    detail: 'x',
    resumable: true,
    account: null,
    resets_at: null,
  },
  WorkItemResumed: { previous_reason: 'budget-exhausted', detail: 'x', account: null },
  WorkItemCompleted: { stages_completed: ['intake'] },
  WorkItemFailed: { reason: 'loop-guard', detail: 'x' },
  RunStarted: {
    miengu_version: '0.1.0',
    node_version: 'v20.0.0',
    config_hash: 'deadbeef',
    config: {},
  },
  RunFinished: { outcome: 'completed', events_appended: 1 },
  StageEntered: { stage: 'intake', attempt: 1 },
  StageCompleted: { stage: 'intake', attempt: 1, artifact: null },
  StageFailed: { stage: 'intake', attempt: 1, reason: 'internal-error', detail: 'x' },
  ArtifactValidationFailed: {
    stage: 'test-authoring',
    role: 'testAuthor',
    executor_id: 'cx-high',
    attempt: 1,
    validation_attempt: 1,
    kind: 'schema',
    artifact_kind: 'test-suite-spec',
    errors: ['cases must include at least one negative test'],
  },
  WorkspacePrepared: {
    mode: 'worktree',
    target_repo: '/tmp/repo',
    workdir: '/tmp/wd',
    base_ref: 'HEAD',
    base_commit: 'a'.repeat(40),
  },
  WorkspaceDiscarded: { workdir: '/tmp/wd', retained: false },
  WorktreeLockAcquired: {
    workdir: '/tmp/wd',
    holder: 'cc-sonnet',
    stage: 'implementation',
    intent: 'workspace-write',
  },
  WorktreeLockReleased: {
    workdir: '/tmp/wd',
    holder: 'cc-sonnet',
    stage: 'implementation',
    reclaimed: false,
  },
  ExecutorInvoked: {
    executor_id: 'stub',
    executor_type: 'stub',
    account: 'claude-personal',
    role: null,
    stage: 'intake',
    workdir: '/tmp/wd',
    sandbox_intent: 'read-only',
    native_structured_output: false,
    output_schema_sha256: null,
    prompt_sha256: 'a'.repeat(64),
    prompt_bytes: 10,
    prompt_path: null,
    prompt_template_sha256: null,
    validation_attempt: 1,
    context_pack_id: null,
    context_pack_estimated_tokens: null,
    resolved: { model: null, effort: null, max_turns: 10, context_budget_tokens: 1000 },
    budget: { max_turns: 10, max_wall_seconds: 60 },
    command_line: ['stub'],
    session_id: 'sess-stub',
  },
  ExecutorReturned: {
    executor_id: 'stub',
    executor_type: 'stub',
    account: 'claude-personal',
    stage: 'intake',
    status: 'completed',
    telemetry: {
      turns: 1,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      wall_seconds: 1,
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
      final_message_bytes: null,
      command_line: ['stub'],
      session_id: 'sess-stub',
    },
  },
  DiffCaptured: {
    workdir: '/tmp/wd',
    diff_sha256: 'a'.repeat(64),
    diff_ref: null,
    files_touched: [],
    untracked: [],
    insertions: 0,
    deletions: 0,
    committed_during_run: false,
  },
  BudgetConsumed: { scope: 'task', account: 'claude-personal', wall_seconds: 1, turns: 1, usd: null },
  BudgetExhausted: {
    scope: 'task',
    account: 'claude-personal',
    limit_kind: 'turns',
    declared_limit: 10,
    observed: 11,
    detail: 'x',
    resets_at: null,
  },
  CheckpointRaised: {
    checkpoint: 'cp-example-1',
    kind: 'irreversible',
    stage: 'intake',
    summary: 'x',
    blocking: true,
    sla_seconds: null,
    default_decision: null,
  },
  CheckpointDecided: {
    checkpoint: 'cp-example-1',
    decision: 'accept',
    by: 'human',
    reason: null,
  },
  AutoApproved: {
    checkpoint: 'cp-example-1',
    after: '2024-01-01T00:00:00.000Z',
    no_human_response: true,
  },
  AssumptionRecorded: {
    id: 'assumption-example-1',
    question: 'q',
    chosen: 'c',
    alternatives: [],
    affects: [],
    depth: 0,
  },
  TestsFrozen: {
    suite_id: 'suite-example-1',
    content_hash: 'a'.repeat(64),
    files: [{ path: 'test/x.test.ts', sha256: 'b'.repeat(64), bytes: 10 }],
    frozen_copy_dir: '/tmp/frozen',
  },
  TestsTampered: {
    task_id: 'task-example-1',
    suite_id: 'suite-example-1',
    expected_hash: 'a'.repeat(64),
    observed_hash: 'b'.repeat(64),
    paths: [],
    restored: true,
  },
  ItemArtifactRecorded: {
    role: 'analyst',
    stage: 'analysis',
    artifact_kind: 'requirement-set',
    sha256: 'a'.repeat(64),
    summary: 'x',
  },
  DriftDetected: { claim_item: 'wi-example-abc123', claim: 'claim-example-1', expected: 'a', observed: 'b', area: null },
  BrownfieldEvidenceRecorded: {
    ladder_tier: 'mechanical-skeleton', collector_version: 1, target_repo_sha256: 'a'.repeat(64),
    scope: { target_commit: 'a'.repeat(40), roots: [], paths: [], dependency_depth: 0, max_files: 1, truncated: false, sha256: 'b'.repeat(64) },
    coverage: 'complete', facts: [{ kind: 'file', path: 'package.json', sha256: 'c'.repeat(64), bytes: 1 }], omissions: [], evidence: ORACLE_EVIDENCE,
  },
  BrownfieldPredicateProposed: {
    target_commit: 'a'.repeat(40), scope_sha256: 'b'.repeat(64), subject: { claim_item: 'wi-example-abc123', claim: 'claim-example-1' }, assertion: 'package exists', area: null,
    predicate: { kind: 'path-exists', path: 'package.json', expected: true },
  },
  BrownfieldPredicateEvaluated: {
    proposal_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', target_commit: 'a'.repeat(40), outcome: 'confirmed', reason: 'predicate-true', expected: 'true', observed: 'true', duration_ms: 0, evidence: ORACLE_EVIDENCE,
  },
  TaskGraphActivated: { graph_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', ordered_task_ids: ['task-example-1'] },
  TaskStarted: { task_id: 'task-example-1', order_index: 0, graph_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef' },
  TaskAccepted: { task_id: 'task-example-1', implementation_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', review_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', oracle_sweep_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', checkpoint_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef' },
  FailureCauseOpened: { trigger_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', parent_cause_id: null, kind: 'oracle', task_id: 'task-example-1', initial_level: 'coder', affects: { req_ids: [], component_ids: [], task_ids: ['task-example-1'] }, summary: 'x' },
  FailureAttempted: { cause_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', task_id: 'task-example-1', level: 'coder', bucket: 'oracle', attempt: 1, limit: 2, handler_stage: 'implementation' },
  EscalationAdvanced: { cause_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', task_id: 'task-example-1', from_level: 'coder', to_level: 'reviewer', exhausted_bucket: 'oracle', attempts_used: 2, reason: 'x' },
  FailureCauseResolved: { cause_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', resolution: 'fixed', task_id: 'task-example-1' },
  ArtifactsInvalidated: { cause_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', target: 'coder', affected_ids: { req_ids: [], component_ids: [], task_ids: ['task-example-1'] }, artifact_event_ids: [], reason: 'x' },
  OracleSweepStarted: { scope: 'task', task_id: 'task-example-1', cause_id: null, commands: [{ kind: 'build', command: 'npm run build', sha256: 'a'.repeat(64) }] },
  OracleResultRecorded: { sweep_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', scope: 'task', task_id: 'task-example-1', kind: 'build', command: 'npm run build', command_sha256: 'a'.repeat(64), status: 'passed', exit_code: 0, signal: null, duration_ms: 1, stdout: ORACLE_EVIDENCE, stderr: ORACLE_EVIDENCE },
  OracleSweepCompleted: { sweep_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', scope: 'task', task_id: 'task-example-1', outcome: 'passed', failed_kind: null, result_event_ids: [] },
  WorkspaceCheckpointed: { kind: 'task-accepted', task_id: 'task-example-1', parent_commit: 'a'.repeat(40), commit: 'b'.repeat(40), patch: null },
  WorkspaceRestored: { cause_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', target: 'coder', base_checkpoint_event_id: 'evt-01234567-89ab-cdef-0123-456789abcdef', base_commit: 'a'.repeat(40), retained_task_commits: [], invalidated_task_ids: ['task-example-1'] },
  FinalPatchCaptured: { original_base_commit: 'a'.repeat(40), accepted_head_commit: 'b'.repeat(40), patch: { sha256: 'c'.repeat(64), path: '/tmp/p.patch', bytes: 1 }, files: [], insertions: 0, deletions: 0 },
};

function buildEvent(type: EventType): Record<string, unknown> {
  return { ...BASE_ENVELOPE, type, data: VALID_DATA[type] };
}

describe('EVENT_SCHEMA_VERSION', () => {
  it('is 4 with v2/v3 accepted only at the stored-event compatibility boundary', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(4);
  });
});

describe('MienguEventSchema closure', () => {
  it('(a) has exactly one schema member per EVENT_TYPES entry, no more, no fewer', () => {
    const memberTypes = MienguEventSchema.options.map((option) => option.shape.type.value);
    expect(new Set(memberTypes)).toEqual(new Set(EVENT_TYPES));
    expect(memberTypes).toHaveLength(EVENT_TYPES.length);
  });

  it("(b) each member's discriminator literal matches its key", () => {
    for (const type of EVENT_TYPES) {
      const schema = MienguEventSchema.optionsMap.get(type) as DiscriminatedMember | undefined;
      expect(schema).toBeDefined();
      expect(schema?.shape.type.value).toBe(type);
    }
  });

  it('(c) DEFAULT_TIER covers exactly EVENT_TYPES', () => {
    expect(new Set(Object.keys(DEFAULT_TIER))).toEqual(new Set(EVENT_TYPES));
  });

  it('(e) EVENT_TYPES is snapshotted so adding a type is a visible, deliberate diff', () => {
    expect(EVENT_TYPES).toMatchSnapshot();
  });
});

describe('(d) one valid + one invalid fixture per event type', () => {
  for (const type of EVENT_TYPES) {
    it(`${type}: valid fixture parses`, () => {
      const result = MienguEventSchema.safeParse(buildEvent(type));
      expect(result.success).toBe(true);
    });

    it(`${type}: an extra key in data is rejected by .strict()`, () => {
      const event = buildEvent(type);
      const dataWithExtra = { ...(event['data'] as Record<string, unknown>), __bogus: true };
      const result = MienguEventSchema.safeParse({ ...event, data: dataWithExtra });
      expect(result.success).toBe(false);
    });
  }
});

describe('OracleResultRecorded durable stream evidence', () => {
  it.each(['stdout', 'stderr'] as const)('rejects a null %s reference for every result status', (stream) => {
    for (const status of ['passed', 'failed', 'timed-out', 'spawn-error', 'aborted'] as const) {
      const event = buildEvent('OracleResultRecorded');
      const data = { ...(event.data as Record<string, unknown>), status, [stream]: null };
      expect(MienguEventSchema.safeParse({ ...event, data }).success).toBe(false);
    }
  });
});

describe('stored event compatibility', () => {
  it('upcasts a frozen v3 drift event to the v4 qualified drift shape', () => {
    const event = buildEvent('DriftDetected');
    const v3Data = { ...(event.data as Record<string, unknown>) };
    delete v3Data.claim_item;
    const parsed = StoredEventSchema.parse({ ...event, schema_version: 3, data: v3Data });
    expect(parsed).toMatchObject({ schema_version: 4, type: 'DriftDetected', data: { claim_item: BASE_ENVELOPE.item_id } });
  });

  it('does not accept a v3 brownfield event', () => {
    const event = buildEvent('BrownfieldEvidenceRecorded');
    expect(StoredEventSchema.safeParse({ ...event, schema_version: 3 }).success).toBe(false);
  });
});

describe('tier assignment', () => {
  it('assigns BrownfieldPredicateProposed T2 and evidence/evaluation T1', () => {
    expect(DEFAULT_TIER.WorkItemCreated).toBe('T0');
    expect(DEFAULT_TIER.CheckpointDecided).toBe('T0');
    expect(DEFAULT_TIER.AssumptionRecorded).toBe('T2');
    expect(DEFAULT_TIER.ItemArtifactRecorded).toBe('T2');
    expect(DEFAULT_TIER.BrownfieldPredicateProposed).toBe('T2');
    expect(DEFAULT_TIER.BrownfieldEvidenceRecorded).toBe('T1');
    expect(DEFAULT_TIER.BrownfieldPredicateEvaluated).toBe('T1');
    expect(DEFAULT_TIER.AutoApproved).toBe('T1');
    for (const type of EVENT_TYPES) {
      if (
        type === 'WorkItemCreated' ||
        type === 'CheckpointDecided' ||
        type === 'HumanAnswerRecorded' ||
        type === 'AssumptionRecorded' ||
        type === 'ItemArtifactRecorded' ||
        type === 'BrownfieldPredicateProposed'
      ) {
        continue;
      }
      expect(DEFAULT_TIER[type]).toBe('T1');
    }
  });
});
