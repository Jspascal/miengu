import { z } from 'zod';
import { ProvenanceTierSchema } from './provenance.js';
import type { ProvenanceTier } from './provenance.js';
import {
  EventIdSchema,
  WorkItemIdSchema,
  RunIdSchema,
  SlugSchema,
  CheckpointIdSchema,
  AssumptionIdSchema,
  TaskIdSchema,
  ReqIdSchema,
  ComponentIdSchema,
  SuiteIdSchema,
  ClaimIdSchema,
  AccountIdSchema,
  ExecutorInstanceIdSchema,
} from './ids.js';

// EVENT_SCHEMA_VERSION 2: clean break, no v1 reader exists (binding decision 7). The repo
// has zero commits and no production runs; EventLog.open already hard-refuses any line whose
// schema_version !== EVENT_SCHEMA_VERSION with LogCorruptError, and that refusal is the
// migration story.
//
// Phase 5 (WORK_ORDER_PHASE5.md binding decision 1) stays at 3. A checkpoint's owner and a
// blast-radius checkpoint's fired triggers are both needed by §8, and neither needs a field:
// the owner is an operator declaration already durable in `RunStarted.data.config`
// (`checkpoints.defaultOwner`), resolved by `checkpointOwner` against the in-force config at
// the raise seq; the trigger set is a pure function of `DiffCaptured.files_touched` /
// `.untracked` / `.insertions` / `.deletions` and that same in-force config, reproduced exactly
// by re-running `classifyBlastRadius` over the log. Recording either would append a derived
// fact to the source of truth. Bumping to 4 would also force `EventLog.open`'s
// older-envelope refusal onto every existing v3 log, making every currently parked item
// unresumable — the opposite of this phase's purpose.
export const EVENT_SCHEMA_VERSION = 3;

export const ACTOR_KINDS = ['supervisor', 'executor', 'human', 'oracle', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
export const ActorSchema = z
  .object({
    kind: z.enum(ACTOR_KINDS),
    id: z.string().min(1).nullable(),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;

// Mirrors src/core/clock.ts's IsoTimestampSchema exactly (same validation, same brand
// literal) without importing clock.ts, which the determinism zone forbids for this file.
const EnvelopeTimestampSchema = z.string().datetime({ offset: false }).brand<'IsoTimestamp'>();

/** Common envelope. Every event has exactly these fields plus `type` and `data`. */
export const EnvelopeSchema = z.object({
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  event_id: EventIdSchema,
  seq: z.number().int().positive(),
  item_id: WorkItemIdSchema,
  run_id: RunIdSchema,
  ts: EnvelopeTimestampSchema,
  tier: ProvenanceTierSchema,
  actor: ActorSchema,
  causation_id: EventIdSchema.nullable(),
});

export const ROLES = ['analyst', 'architect', 'planner', 'testAuthor', 'coder', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const EXECUTOR_TYPES = ['claude-code', 'codex', 'stub'] as const; // NOT 'api-sdk' (Phase 3)
export type ExecutorType = (typeof EXECUTOR_TYPES)[number];

export const SANDBOX_INTENTS = ['read-only', 'workspace-write'] as const;
export type SandboxIntent = (typeof SANDBOX_INTENTS)[number];

export const VALIDATION_FAILURE_KINDS = ['parse', 'schema', 'mechanical'] as const;
export type ValidationFailureKind = (typeof VALIDATION_FAILURE_KINDS)[number];

export const QUOTA_SOURCES = [
  'rate-limit-event',
  'api-error-status',
  'stream-regex',
  'stderr-regex',
  'provider-event',
] as const;
export type QuotaSource = (typeof QUOTA_SOURCES)[number];

export const EVENT_TYPES = [
  // A — item lifecycle
  'WorkItemCreated',
  'WorkItemParked',
  'WorkItemResumed',
  'WorkItemCompleted',
  'WorkItemFailed',
  // B — run lifecycle
  'RunStarted',
  'RunFinished',
  // C — stage lifecycle
  'StageEntered',
  'StageCompleted',
  'StageFailed',
  'ArtifactValidationFailed',
  // D — workspace & executor
  'WorkspacePrepared',
  'WorkspaceDiscarded',
  'WorktreeLockAcquired',
  'WorktreeLockReleased',
  'ExecutorInvoked',
  'ExecutorReturned',
  'DiffCaptured',
  // E — budget
  'BudgetConsumed',
  'BudgetExhausted',
  // F — human / checkpoint
  'CheckpointRaised',
  'CheckpointDecided',
  'AutoApproved',
  // G — named by contract elsewhere in the brief
  'AssumptionRecorded',
  'TestsFrozen',
  'TestsTampered',
  'ItemArtifactRecorded',
  'DriftDetected',
  // H — task execution, causal escalation, and integration
  'TaskGraphActivated',
  'TaskStarted',
  'TaskAccepted',
  'FailureCauseOpened',
  'FailureAttempted',
  'EscalationAdvanced',
  'FailureCauseResolved',
  'ArtifactsInvalidated',
  'OracleSweepStarted',
  'OracleResultRecorded',
  'OracleSweepCompleted',
  'WorkspaceCheckpointed',
  'WorkspaceRestored',
  'FinalPatchCaptured',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const STAGES = [
  'intake',
  'analysis',
  'architecture',
  'planning',
  'test-authoring',
  'implementation',
  'review',
  'integration',
  'done',
] as const;
export type Stage = (typeof STAGES)[number];

export const ARTIFACT_KINDS = [
  'stub',
  'requirement-set',
  'architecture-plan',
  'task-graph',
  'test-suite-spec',
  'implementation',
  'review-verdict',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const PARK_REASONS = [
  'budget-exhausted',
  'provider-quota',
  'attempts-exhausted',
  'awaiting-human',
  'operator-abort',
  'executor-unavailable',
] as const;
export type ParkReason = (typeof PARK_REASONS)[number];

export const STAGE_FAILURE_REASONS = [
  'executor-crashed',
  'executor-gave-up',
  'executor-committed',
  'budget-turns',
  'budget-wall',
  'validation-failed',
  'workspace-error',
  'internal-error',
  'sandbox-violation',
  'tests-tampered',
] as const;
export type StageFailureReason = (typeof STAGE_FAILURE_REASONS)[number];

export const RUN_OUTCOMES = ['completed', 'parked', 'failed', 'aborted'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const TARGET_MODES = ['worktree', 'clone'] as const;
export type TargetMode = (typeof TARGET_MODES)[number];

export const EXECUTOR_STATUSES = [
  'completed',
  'gave_up',
  'budget_turns',
  'budget_wall',
  'quota_exhausted',
  'crashed',
] as const;
export type ExecutorStatus = (typeof EXECUTOR_STATUSES)[number];

export const BUDGET_SCOPES = ['task', 'item', 'run'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_LIMIT_KINDS = ['turns', 'wall', 'usd', 'provider-quota'] as const;
export type BudgetLimitKind = (typeof BUDGET_LIMIT_KINDS)[number];

export const CHECKPOINT_KINDS = [
  'irreversible',
  'agent-originated',
  'blast-radius',
  'assumption-gate',
  'escalation',
] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const KILL_MODES = ['none', 'sigterm', 'sigkill'] as const;
export type KillMode = (typeof KILL_MODES)[number];

export const ESCALATION_LEVELS = ['coder', 'reviewer', 'planner', 'architect', 'analyst', 'human'] as const;
export type EscalationLevel = (typeof ESCALATION_LEVELS)[number];
export const FAILURE_KINDS = ['oracle', 'test', 'review-revision', 'task-design', 'architecture', 'requirements', 'agent-output', 'sandbox', 'integration'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];
export const FAILURE_ATTEMPT_BUCKETS = ['oracle', 'test', 'review', 'reviewer', 'planner', 'architect', 'analyst'] as const;
export type FailureAttemptBucket = (typeof FAILURE_ATTEMPT_BUCKETS)[number];
export const ORACLE_KINDS = ['build', 'typecheck', 'lint', 'test'] as const;
export type OracleKind = (typeof ORACLE_KINDS)[number];
export const ORACLE_SCOPES = ['task', 'integration'] as const;
export type OracleScope = (typeof ORACLE_SCOPES)[number];
export const ORACLE_RESULT_STATUSES = ['passed', 'failed', 'timed-out', 'aborted', 'spawn-error'] as const;
export type OracleResultStatus = (typeof ORACLE_RESULT_STATUSES)[number];
export const INVALIDATION_TARGETS = ['coder', 'planner', 'architect', 'analyst'] as const;
export type InvalidationTarget = (typeof INVALIDATION_TARGETS)[number];
export const WORKSPACE_CHECKPOINT_KINDS = ['tests-frozen', 'task-accepted'] as const;
export type WorkspaceCheckpointKind = (typeof WORKSPACE_CHECKPOINT_KINDS)[number];

const FAILURE_KIND_SCHEMA = z
  .union([
    z.literal('quota'),
    z.literal('auth'),
    z.literal('timeout'),
    z.literal('unparseable'),
    z.literal('nonzero-exit'),
  ])
  .nullable();

export const WorkItemCreatedData = z
  .object({
    title: z.string(),
    slug: SlugSchema,
    source: z
      .object({
        kind: z.literal('prd-file'),
        path: z.string(),
        sha256: z.string(),
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
    config_hash: z.string(),
  })
  .strict();

export const WorkItemParkedData = z
  .object({
    reason: z.enum(PARK_REASONS),
    detail: z.string(),
    resumable: z.boolean(),
    account: AccountIdSchema.nullable(),
    resets_at: EnvelopeTimestampSchema.nullable(),
  })
  .strict();

export const WorkItemResumedData = z
  .object({
    previous_reason: z.enum(PARK_REASONS),
    detail: z.string(),
    account: AccountIdSchema.nullable(),
  })
  .strict();

export const WorkItemCompletedData = z
  .object({
    stages_completed: z.array(z.enum(STAGES)),
  })
  .strict();

export const WorkItemFailedData = z
  .object({
    reason: z.union([z.enum(STAGE_FAILURE_REASONS), z.literal('loop-guard')]),
    detail: z.string(),
  })
  .strict();

export const RunStartedData = z
  .object({
    miengu_version: z.string(),
    node_version: z.string(),
    config_hash: z.string(),
    config: z.unknown(),
  })
  .strict();

export const RunFinishedData = z
  .object({
    outcome: z.enum(RUN_OUTCOMES),
    events_appended: z.number().int().nonnegative(),
  })
  .strict();

export const StageEnteredData = z
  .object({
    stage: z.enum(STAGES),
    attempt: z.number().int().min(1),
  })
  .strict();

export const StageCompletedData = z
  .object({
    stage: z.enum(STAGES),
    attempt: z.number().int().min(1),
    artifact: z
      .object({
        kind: z.enum(ARTIFACT_KINDS),
        sha256: z.string(),
        body: z.unknown(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const StageFailedData = z
  .object({
    stage: z.enum(STAGES),
    attempt: z.number().int().min(1),
    reason: z.enum(STAGE_FAILURE_REASONS),
    detail: z.string(),
  })
  .strict();

export const ArtifactValidationFailedData = z
  .object({
    stage: z.enum(STAGES),
    role: z.enum(ROLES),
    executor_id: ExecutorInstanceIdSchema,
    attempt: z.number().int().min(1),
    validation_attempt: z.union([z.literal(1), z.literal(2)]),
    kind: z.enum(VALIDATION_FAILURE_KINDS),
    artifact_kind: z.enum(ARTIFACT_KINDS),
    errors: z.array(z.string()),
  })
  .strict();

export const WorkspacePreparedData = z
  .object({
    mode: z.enum(TARGET_MODES),
    target_repo: z.string(),
    workdir: z.string(),
    base_ref: z.string(),
    base_commit: z.string(),
  })
  .strict();

export const WorkspaceDiscardedData = z
  .object({
    workdir: z.string(),
    retained: z.boolean(),
  })
  .strict();

export const WorktreeLockAcquiredData = z
  .object({
    workdir: z.string(),
    holder: ExecutorInstanceIdSchema,
    stage: z.enum(STAGES),
    intent: z.enum(SANDBOX_INTENTS),
  })
  .strict();

export const WorktreeLockReleasedData = z
  .object({
    workdir: z.string(),
    holder: ExecutorInstanceIdSchema,
    stage: z.enum(STAGES),
    reclaimed: z.boolean(),
  })
  .strict();

export const ExecutorInvokedData = z
  .object({
    executor_id: ExecutorInstanceIdSchema,
    executor_type: z.enum(EXECUTOR_TYPES),
    account: AccountIdSchema,
    role: z.enum(ROLES).nullable(),
    stage: z.enum(STAGES),
    workdir: z.string(),
    sandbox_intent: z.enum(SANDBOX_INTENTS),
    native_structured_output: z.boolean(),
    output_schema_sha256: z.string().nullable(),
    prompt_sha256: z.string(),
    prompt_bytes: z.number().int().nonnegative(),
    prompt_path: z.string().nullable(),
    prompt_template_sha256: z.string().nullable(),
    validation_attempt: z.union([z.literal(1), z.literal(2)]),
    context_pack_id: z.string().nullable(),
    context_pack_estimated_tokens: z.number().int().nonnegative().nullable(),
    session_id: z.string().nullable(),
    resolved: z
      .object({
        model: z.string().nullable(),
        effort: z.string().nullable(),
        max_turns: z.number().int().positive(),
        context_budget_tokens: z.number().int().positive(),
      })
      .strict(),
    budget: z
      .object({
        max_turns: z.number().int().positive(),
        max_wall_seconds: z.number().int().positive(),
      })
      .strict(),
    command_line: z.array(z.string()),
  })
  .strict();

export const ExecutorReturnedData = z
  .object({
    executor_id: ExecutorInstanceIdSchema,
    executor_type: z.enum(EXECUTOR_TYPES),
    account: AccountIdSchema,
    stage: z.enum(STAGES),
    status: z.enum(EXECUTOR_STATUSES),
    telemetry: z
      .object({
        turns: z.number().int().nonnegative().nullable(),
        input_tokens: z.number().int().nonnegative().nullable(),
        output_tokens: z.number().int().nonnegative().nullable(),
        cache_read_tokens: z.number().int().nonnegative().nullable(),
        cache_creation_tokens: z.number().int().nonnegative().nullable(),
        wall_seconds: z.number().nonnegative(),
      })
      .strict(),
    quota: z
      .object({
        account: AccountIdSchema,
        source: z.enum(QUOTA_SOURCES),
        status: z.string().nullable(),
        utilization: z.number().nullable(),
        window_kind: z.string().nullable(),
        resets_at: EnvelopeTimestampSchema.nullable(),
      })
      .strict()
      .nullable(),
    raw: z
      .object({
        exit_code: z.number().int().nullable(),
        signal: z.string().nullable(),
        killed: z.enum(KILL_MODES),
        observed_turns: z.number().int().nonnegative().nullable(),
        failure_kind: FAILURE_KIND_SCHEMA,
        stderr_tail: z.string(),
        transcript_path: z.string().nullable(),
        final_message_bytes: z.number().int().nonnegative().nullable(),
        command_line: z.array(z.string()),
        // The provider's own session handle: `--session-id` for claude-code, and
        // `thread.started.thread_id` for codex — precisely the id `codex exec resume <id>`
        // takes. Both adapters advertise `resumableSessions: true`, so without this the id
        // §17.2's park/resume needs exists nowhere in the log. Recorded here rather than on
        // ExecutorInvoked because codex only reveals it once the run has started.
        session_id: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const DiffCapturedData = z
  .object({
    workdir: z.string(),
    diff_sha256: z.string(),
    diff_ref: z.string().nullable(),
    files_touched: z.array(z.string()),
    untracked: z.array(z.string()),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    committed_during_run: z.boolean(),
  })
  .strict();

export const BudgetConsumedData = z
  .object({
    scope: z.enum(BUDGET_SCOPES),
    account: AccountIdSchema,
    wall_seconds: z.number().nonnegative(),
    turns: z.number().int().nonnegative().nullable(),
    usd: z.number().nonnegative().nullable(),
  })
  .strict();

export const BudgetExhaustedData = z
  .object({
    scope: z.enum(BUDGET_SCOPES),
    account: AccountIdSchema.nullable(),
    limit_kind: z.enum(BUDGET_LIMIT_KINDS),
    declared_limit: z.number().nullable(),
    observed: z.number().nullable(),
    detail: z.string(),
    resets_at: EnvelopeTimestampSchema.nullable(),
  })
  .strict();

export const CheckpointRaisedData = z
  .object({
    checkpoint: CheckpointIdSchema,
    kind: z.enum(CHECKPOINT_KINDS),
    stage: z.enum(STAGES),
    summary: z.string(),
    blocking: z.boolean(),
    sla_seconds: z.number().int().nonnegative().nullable(),
    default_decision: z.union([z.literal('accept'), z.literal('reject')]).nullable(),
  })
  .strict();

export const CheckpointDecidedData = z
  .object({
    checkpoint: CheckpointIdSchema,
    decision: z.union([z.literal('accept'), z.literal('reject')]),
    by: z.literal('human'),
    reason: z.string().nullable(),
  })
  .strict();

export const AutoApprovedData = z
  .object({
    checkpoint: CheckpointIdSchema,
    after: z.string(),
    no_human_response: z.literal(true),
  })
  .strict();

export const AssumptionRecordedData = z
  .object({
    id: AssumptionIdSchema,
    question: z.string(),
    chosen: z.string(),
    alternatives: z.array(z.string()),
    affects: z.array(z.string()),
    depth: z.number().int().nonnegative(),
  })
  .strict();

export const TestsFrozenData = z
  .object({
    suite_id: SuiteIdSchema,
    content_hash: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string(),
          bytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    frozen_copy_dir: z.string(),
  })
  .strict();

export const TestsTamperedData = z
  .object({
    task_id: TaskIdSchema,
    suite_id: SuiteIdSchema,
    expected_hash: z.string(),
    observed_hash: z.string(),
    paths: z.array(z.string()),
    restored: z.boolean(),
  })
  .strict();

export const ItemArtifactRecordedData = z
  .object({
    role: z.enum(ROLES),
    stage: z.enum(STAGES),
    artifact_kind: z.enum(ARTIFACT_KINDS),
    sha256: z.string(),
    summary: z.string(),
  })
  .strict();

export const DriftDetectedData = z
  .object({
    claim: ClaimIdSchema,
    expected: z.string(),
    observed: z.string(),
    area: z.string().nullable(),
  })
  .strict();

export const AffectedScopeSchema = z.object({
  req_ids: z.array(ReqIdSchema),
  component_ids: z.array(ComponentIdSchema),
  task_ids: z.array(TaskIdSchema),
}).strict();
export type AffectedScope = z.infer<typeof AffectedScopeSchema>;

export const EvidenceRefSchema = z.object({
  sha256: z.string(),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

const OracleCommandSchema = z.object({
  kind: z.enum(ORACLE_KINDS), command: z.string().nullable(), sha256: z.string().nullable(),
}).strict();

export const TaskGraphActivatedData = z.object({
  graph_event_id: EventIdSchema,
  ordered_task_ids: z.array(TaskIdSchema),
}).strict();
export const TaskStartedData = z.object({
  task_id: TaskIdSchema,
  order_index: z.number().int().nonnegative(),
  graph_event_id: EventIdSchema,
}).strict();
export const TaskAcceptedData = z.object({
  task_id: TaskIdSchema,
  implementation_event_id: EventIdSchema,
  review_event_id: EventIdSchema,
  oracle_sweep_id: EventIdSchema,
  checkpoint_event_id: EventIdSchema,
}).strict();
export const FailureCauseOpenedData = z.object({
  trigger_event_id: EventIdSchema,
  parent_cause_id: EventIdSchema.nullable(),
  kind: z.enum(FAILURE_KINDS),
  task_id: TaskIdSchema.nullable(),
  initial_level: z.enum(ESCALATION_LEVELS),
  affects: AffectedScopeSchema,
  summary: z.string(),
}).strict();
export const FailureAttemptedData = z.object({
  cause_id: EventIdSchema,
  task_id: TaskIdSchema.nullable(),
  level: z.enum(ESCALATION_LEVELS),
  bucket: z.enum(FAILURE_ATTEMPT_BUCKETS),
  attempt: z.number().int().min(1),
  limit: z.number().int().min(1),
  handler_stage: z.enum(STAGES),
}).strict();
export const EscalationAdvancedData = z.object({
  cause_id: EventIdSchema,
  task_id: TaskIdSchema.nullable(),
  from_level: z.enum(ESCALATION_LEVELS),
  to_level: z.enum(ESCALATION_LEVELS),
  exhausted_bucket: z.enum(FAILURE_ATTEMPT_BUCKETS),
  attempts_used: z.number().int().nonnegative(),
  reason: z.string(),
}).strict();
export const FailureCauseResolvedData = z.object({
  cause_id: EventIdSchema,
  resolution: z.string(),
  task_id: TaskIdSchema.nullable(),
}).strict();
export const ArtifactsInvalidatedData = z.object({
  cause_id: EventIdSchema,
  target: z.enum(INVALIDATION_TARGETS),
  affected_ids: AffectedScopeSchema,
  artifact_event_ids: z.array(EventIdSchema),
  reason: z.string(),
}).strict();
export const OracleSweepStartedData = z.object({
  scope: z.enum(ORACLE_SCOPES),
  task_id: TaskIdSchema.nullable(),
  cause_id: EventIdSchema.nullable(),
  commands: z.array(OracleCommandSchema),
}).strict();
export const OracleResultRecordedData = z.object({
  sweep_id: EventIdSchema,
  scope: z.enum(ORACLE_SCOPES),
  task_id: TaskIdSchema.nullable(),
  kind: z.enum(ORACLE_KINDS),
  command: z.string().nullable(),
  command_sha256: z.string().nullable(),
  status: z.enum(ORACLE_RESULT_STATUSES),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  duration_ms: z.number().int().nonnegative(),
  // Every executed command, including spawn errors and aborts, persists both streams. Empty
  // output is represented by a zero-byte EvidenceRef, never by a missing reference.
  stdout: EvidenceRefSchema,
  stderr: EvidenceRefSchema,
}).strict();
export const OracleSweepCompletedData = z.object({
  sweep_id: EventIdSchema,
  scope: z.enum(ORACLE_SCOPES),
  task_id: TaskIdSchema.nullable(),
  outcome: z.enum(['passed', 'failed', 'aborted']),
  failed_kind: z.enum(ORACLE_KINDS).nullable(),
  result_event_ids: z.array(EventIdSchema),
}).strict();
export const WorkspaceCheckpointedData = z.object({
  kind: z.enum(WORKSPACE_CHECKPOINT_KINDS),
  task_id: TaskIdSchema.nullable(),
  parent_commit: z.string(),
  commit: z.string(),
  patch: EvidenceRefSchema.nullable(),
}).strict();
export const WorkspaceRestoredData = z.object({
  cause_id: EventIdSchema,
  target: z.enum(INVALIDATION_TARGETS),
  base_checkpoint_event_id: EventIdSchema,
  base_commit: z.string(),
  retained_task_commits: z.array(z.object({ task_id: TaskIdSchema, commit: z.string() }).strict()),
  invalidated_task_ids: z.array(TaskIdSchema),
}).strict();
export const FinalPatchCapturedData = z.object({
  original_base_commit: z.string(),
  accepted_head_commit: z.string(),
  patch: EvidenceRefSchema,
  files: z.array(z.string()),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
}).strict();

const MEMBERS = {
  WorkItemCreated: EnvelopeSchema.extend({
    type: z.literal('WorkItemCreated'),
    data: WorkItemCreatedData,
  }),
  WorkItemParked: EnvelopeSchema.extend({
    type: z.literal('WorkItemParked'),
    data: WorkItemParkedData,
  }),
  WorkItemResumed: EnvelopeSchema.extend({
    type: z.literal('WorkItemResumed'),
    data: WorkItemResumedData,
  }),
  WorkItemCompleted: EnvelopeSchema.extend({
    type: z.literal('WorkItemCompleted'),
    data: WorkItemCompletedData,
  }),
  WorkItemFailed: EnvelopeSchema.extend({
    type: z.literal('WorkItemFailed'),
    data: WorkItemFailedData,
  }),
  RunStarted: EnvelopeSchema.extend({
    type: z.literal('RunStarted'),
    data: RunStartedData,
  }),
  RunFinished: EnvelopeSchema.extend({
    type: z.literal('RunFinished'),
    data: RunFinishedData,
  }),
  StageEntered: EnvelopeSchema.extend({
    type: z.literal('StageEntered'),
    data: StageEnteredData,
  }),
  StageCompleted: EnvelopeSchema.extend({
    type: z.literal('StageCompleted'),
    data: StageCompletedData,
  }),
  StageFailed: EnvelopeSchema.extend({
    type: z.literal('StageFailed'),
    data: StageFailedData,
  }),
  ArtifactValidationFailed: EnvelopeSchema.extend({
    type: z.literal('ArtifactValidationFailed'),
    data: ArtifactValidationFailedData,
  }),
  WorkspacePrepared: EnvelopeSchema.extend({
    type: z.literal('WorkspacePrepared'),
    data: WorkspacePreparedData,
  }),
  WorkspaceDiscarded: EnvelopeSchema.extend({
    type: z.literal('WorkspaceDiscarded'),
    data: WorkspaceDiscardedData,
  }),
  WorktreeLockAcquired: EnvelopeSchema.extend({
    type: z.literal('WorktreeLockAcquired'),
    data: WorktreeLockAcquiredData,
  }),
  WorktreeLockReleased: EnvelopeSchema.extend({
    type: z.literal('WorktreeLockReleased'),
    data: WorktreeLockReleasedData,
  }),
  ExecutorInvoked: EnvelopeSchema.extend({
    type: z.literal('ExecutorInvoked'),
    data: ExecutorInvokedData,
  }),
  ExecutorReturned: EnvelopeSchema.extend({
    type: z.literal('ExecutorReturned'),
    data: ExecutorReturnedData,
  }),
  DiffCaptured: EnvelopeSchema.extend({
    type: z.literal('DiffCaptured'),
    data: DiffCapturedData,
  }),
  BudgetConsumed: EnvelopeSchema.extend({
    type: z.literal('BudgetConsumed'),
    data: BudgetConsumedData,
  }),
  BudgetExhausted: EnvelopeSchema.extend({
    type: z.literal('BudgetExhausted'),
    data: BudgetExhaustedData,
  }),
  CheckpointRaised: EnvelopeSchema.extend({
    type: z.literal('CheckpointRaised'),
    data: CheckpointRaisedData,
  }),
  CheckpointDecided: EnvelopeSchema.extend({
    type: z.literal('CheckpointDecided'),
    data: CheckpointDecidedData,
  }),
  AutoApproved: EnvelopeSchema.extend({
    type: z.literal('AutoApproved'),
    data: AutoApprovedData,
  }),
  AssumptionRecorded: EnvelopeSchema.extend({
    type: z.literal('AssumptionRecorded'),
    data: AssumptionRecordedData,
  }),
  TestsFrozen: EnvelopeSchema.extend({
    type: z.literal('TestsFrozen'),
    data: TestsFrozenData,
  }),
  TestsTampered: EnvelopeSchema.extend({
    type: z.literal('TestsTampered'),
    data: TestsTamperedData,
  }),
  ItemArtifactRecorded: EnvelopeSchema.extend({
    type: z.literal('ItemArtifactRecorded'),
    data: ItemArtifactRecordedData,
  }),
  DriftDetected: EnvelopeSchema.extend({
    type: z.literal('DriftDetected'),
    data: DriftDetectedData,
  }),
  TaskGraphActivated: EnvelopeSchema.extend({ type: z.literal('TaskGraphActivated'), data: TaskGraphActivatedData }),
  TaskStarted: EnvelopeSchema.extend({ type: z.literal('TaskStarted'), data: TaskStartedData }),
  TaskAccepted: EnvelopeSchema.extend({ type: z.literal('TaskAccepted'), data: TaskAcceptedData }),
  FailureCauseOpened: EnvelopeSchema.extend({ type: z.literal('FailureCauseOpened'), data: FailureCauseOpenedData }),
  FailureAttempted: EnvelopeSchema.extend({ type: z.literal('FailureAttempted'), data: FailureAttemptedData }),
  EscalationAdvanced: EnvelopeSchema.extend({ type: z.literal('EscalationAdvanced'), data: EscalationAdvancedData }),
  FailureCauseResolved: EnvelopeSchema.extend({ type: z.literal('FailureCauseResolved'), data: FailureCauseResolvedData }),
  ArtifactsInvalidated: EnvelopeSchema.extend({ type: z.literal('ArtifactsInvalidated'), data: ArtifactsInvalidatedData }),
  OracleSweepStarted: EnvelopeSchema.extend({ type: z.literal('OracleSweepStarted'), data: OracleSweepStartedData }),
  OracleResultRecorded: EnvelopeSchema.extend({ type: z.literal('OracleResultRecorded'), data: OracleResultRecordedData }),
  OracleSweepCompleted: EnvelopeSchema.extend({ type: z.literal('OracleSweepCompleted'), data: OracleSweepCompletedData }),
  WorkspaceCheckpointed: EnvelopeSchema.extend({ type: z.literal('WorkspaceCheckpointed'), data: WorkspaceCheckpointedData }),
  WorkspaceRestored: EnvelopeSchema.extend({ type: z.literal('WorkspaceRestored'), data: WorkspaceRestoredData }),
  FinalPatchCaptured: EnvelopeSchema.extend({ type: z.literal('FinalPatchCaptured'), data: FinalPatchCapturedData }),
} satisfies Record<EventType, z.ZodObject<{ type: z.ZodLiteral<EventType> } & z.ZodRawShape>>;

export const MienguEventSchema = z.discriminatedUnion(
  'type',
  Object.values(MEMBERS) as [(typeof MEMBERS)[EventType], ...(typeof MEMBERS)[EventType][]],
);
export type MienguEvent = z.infer<typeof MienguEventSchema>;
export type EventOf<T extends EventType> = Extract<MienguEvent, { type: T }>;

// V2 remains an input-only storage format. Its members deliberately reuse the Phase 2 data
// schemas above; only the envelope version differs. Parsed legacy events are upcast in memory
// to the sole current domain union and are never written back to disk.
const V2EnvelopeSchema = EnvelopeSchema.extend({ schema_version: z.literal(2) });
const V2_DATA = {
  WorkItemCreated: WorkItemCreatedData, WorkItemParked: WorkItemParkedData,
  WorkItemResumed: WorkItemResumedData, WorkItemCompleted: WorkItemCompletedData,
  WorkItemFailed: WorkItemFailedData, RunStarted: RunStartedData, RunFinished: RunFinishedData,
  StageEntered: StageEnteredData, StageCompleted: StageCompletedData, StageFailed: StageFailedData,
  ArtifactValidationFailed: ArtifactValidationFailedData, WorkspacePrepared: WorkspacePreparedData,
  WorkspaceDiscarded: WorkspaceDiscardedData, WorktreeLockAcquired: WorktreeLockAcquiredData,
  WorktreeLockReleased: WorktreeLockReleasedData, ExecutorInvoked: ExecutorInvokedData,
  ExecutorReturned: ExecutorReturnedData, DiffCaptured: DiffCapturedData, BudgetConsumed: BudgetConsumedData,
  BudgetExhausted: BudgetExhaustedData, CheckpointRaised: CheckpointRaisedData,
  CheckpointDecided: CheckpointDecidedData, AutoApproved: AutoApprovedData,
  AssumptionRecorded: AssumptionRecordedData, TestsFrozen: TestsFrozenData, TestsTampered: TestsTamperedData,
  ItemArtifactRecorded: ItemArtifactRecordedData, DriftDetected: DriftDetectedData,
} as const;
const V2_EVENT_TYPES = Object.keys(V2_DATA) as readonly (keyof typeof V2_DATA)[];
const V2_MEMBERS = Object.fromEntries(V2_EVENT_TYPES.map((type) => [
  type,
  V2EnvelopeSchema.extend({ type: z.literal(type), data: V2_DATA[type] }),
])) as unknown as { [T in keyof typeof V2_DATA]: z.ZodObject<z.ZodRawShape> };
const V2StoredEventSchema = z.discriminatedUnion(
  'type', Object.values(V2_MEMBERS) as [z.ZodDiscriminatedUnionOption<'type'>, ...z.ZodDiscriminatedUnionOption<'type'>[]],
);
export const StoredEventSchema: z.ZodType<MienguEvent> = z.union([MienguEventSchema, V2StoredEventSchema]).transform((event) =>
  event.schema_version === 2 ? MienguEventSchema.parse({ ...event, schema_version: EVENT_SCHEMA_VERSION }) : event,
 ) as unknown as z.ZodType<MienguEvent>;
export type StoredEvent = z.infer<typeof StoredEventSchema>;

/** §7 default provenance per event type. The appender uses this unless overridden. */
export const DEFAULT_TIER = {
  WorkItemCreated: 'T0',
  WorkItemParked: 'T1',
  WorkItemResumed: 'T1',
  WorkItemCompleted: 'T1',
  WorkItemFailed: 'T1',
  RunStarted: 'T1',
  RunFinished: 'T1',
  StageEntered: 'T1',
  StageCompleted: 'T1',
  StageFailed: 'T1',
  ArtifactValidationFailed: 'T1',
  WorkspacePrepared: 'T1',
  WorkspaceDiscarded: 'T1',
  WorktreeLockAcquired: 'T1',
  WorktreeLockReleased: 'T1',
  ExecutorInvoked: 'T1',
  ExecutorReturned: 'T1',
  DiffCaptured: 'T1',
  BudgetConsumed: 'T1',
  BudgetExhausted: 'T1',
  CheckpointRaised: 'T1',
  CheckpointDecided: 'T0',
  AutoApproved: 'T1',
  AssumptionRecorded: 'T2',
  TestsFrozen: 'T1',
  TestsTampered: 'T1',
  ItemArtifactRecorded: 'T2',
  DriftDetected: 'T1',
  TaskGraphActivated: 'T1',
  TaskStarted: 'T1',
  TaskAccepted: 'T1',
  FailureCauseOpened: 'T1',
  FailureAttempted: 'T1',
  EscalationAdvanced: 'T1',
  FailureCauseResolved: 'T1',
  ArtifactsInvalidated: 'T1',
  OracleSweepStarted: 'T1',
  OracleResultRecorded: 'T1',
  OracleSweepCompleted: 'T1',
  WorkspaceCheckpointed: 'T1',
  WorkspaceRestored: 'T1',
  FinalPatchCaptured: 'T1',
} satisfies Record<EventType, ProvenanceTier>;

export function assertNever(x: never): never {
  throw new Error(`unreachable event type: ${JSON.stringify(x)}`);
}
