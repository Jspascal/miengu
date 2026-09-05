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
  SuiteIdSchema,
  ClaimIdSchema,
  AccountIdSchema,
  ExecutorInstanceIdSchema,
} from './ids.js';

// EVENT_SCHEMA_VERSION 2: clean break, no v1 reader exists (binding decision 7). The repo
// has zero commits and no production runs; EventLog.open already hard-refuses any line whose
// schema_version !== EVENT_SCHEMA_VERSION with LogCorruptError, and that refusal is the
// migration story.
export const EVENT_SCHEMA_VERSION = 2;

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
] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const KILL_MODES = ['none', 'sigterm', 'sigkill'] as const;
export type KillMode = (typeof KILL_MODES)[number];

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
} satisfies Record<EventType, z.ZodObject<{ type: z.ZodLiteral<EventType> } & z.ZodRawShape>>;

export const MienguEventSchema = z.discriminatedUnion(
  'type',
  Object.values(MEMBERS) as [(typeof MEMBERS)[EventType], ...(typeof MEMBERS)[EventType][]],
);
export type MienguEvent = z.infer<typeof MienguEventSchema>;
export type EventOf<T extends EventType> = Extract<MienguEvent, { type: T }>;

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
} satisfies Record<EventType, ProvenanceTier>;

export function assertNever(x: never): never {
  throw new Error(`unreachable event type: ${JSON.stringify(x)}`);
}
