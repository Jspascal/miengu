import { z } from 'zod';
import {
  ARTIFACT_KINDS,
  BUDGET_LIMIT_KINDS,
  BUDGET_SCOPES,
  CHECKPOINT_KINDS,
  EXECUTOR_STATUSES,
  EXECUTOR_TYPES,
  PARK_REASONS,
  ROLES,
  RUN_OUTCOMES,
  SANDBOX_INTENTS,
  STAGE_FAILURE_REASONS,
  STAGES,
  TARGET_MODES,
  VALIDATION_FAILURE_KINDS,
  ESCALATION_LEVELS,
  FAILURE_KINDS,
  FAILURE_ATTEMPT_BUCKETS,
  ORACLE_KINDS,
  ORACLE_SCOPES,
  ORACLE_RESULT_STATUSES,
  WORKSPACE_CHECKPOINT_KINDS,
  INVALIDATION_TARGETS,
} from '../core/events.js';
import type {
  ArtifactKind,
  BudgetLimitKind,
  BudgetScope,
  CheckpointKind,
  ExecutorStatus,
  ExecutorType,
  ParkReason,
  Role,
  RunOutcome,
  SandboxIntent,
  Stage,
  StageFailureReason,
  TargetMode,
  ValidationFailureKind,
  EscalationLevel,
  FailureKind,
  FailureAttemptBucket,
  OracleKind,
  OracleScope,
  OracleResultStatus,
  WorkspaceCheckpointKind,
  InvalidationTarget,
} from '../core/events.js';
import {
  AccountIdSchema,
  AssumptionIdSchema,
  CheckpointIdSchema,
  ClaimIdSchema,
  EventIdSchema,
  ExecutorInstanceIdSchema,
  RunIdSchema,
  SlugSchema,
  SuiteIdSchema,
  TaskIdSchema,
  WorkItemIdSchema,
  ComponentIdSchema,
  ReqIdSchema,
} from '../core/ids.js';
import type {
  AccountId,
  AssumptionId,
  CheckpointId,
  ClaimId,
  EventId,
  ExecutorInstanceId,
  RunId,
  Slug,
  SuiteId,
  TaskId,
  WorkItemId,
  CauseId,
  OracleSweepId,
  WorkspaceCheckpointId,
  ComponentId,
  ReqId,
} from '../core/ids.js';

export const PROJECTION_VERSION = 3;

export const STAGE_ORDER: readonly Stage[] = STAGES;

export function nextStageInOrder(s: Stage): Stage {
  const idx = STAGE_ORDER.indexOf(s);
  const next = STAGE_ORDER[idx + 1];
  return next ?? 'done';
}

export function emptyAttempts(): Record<Stage, number> {
  return {
    intake: 0,
    analysis: 0,
    architecture: 0,
    planning: 0,
    'test-authoring': 0,
    implementation: 0,
    review: 0,
    integration: 0,
    done: 0,
  } satisfies Record<Stage, number>;
}

/** All nine `Stage` keys, zeroed. Binding decision 19's parallel counter. */
export function emptyQuotaAborts(): Record<Stage, number> {
  return {
    intake: 0,
    analysis: 0,
    architecture: 0,
    planning: 0,
    'test-authoring': 0,
    implementation: 0,
    review: 0,
    integration: 0,
    done: 0,
  } satisfies Record<Stage, number>;
}

const STAGE_ROLE: Readonly<Record<Stage, Role | null>> = {
  intake: null,
  analysis: 'analyst',
  architecture: 'architect',
  planning: 'planner',
  'test-authoring': 'testAuthor',
  implementation: 'coder',
  review: 'reviewer',
  integration: null,
  done: null,
};

const ROLE_STAGE: Readonly<Record<Role, Stage>> = {
  analyst: 'analysis',
  architect: 'architecture',
  planner: 'planning',
  testAuthor: 'test-authoring',
  coder: 'implementation',
  reviewer: 'review',
};

/** `intake`, `integration`, `done` are supervisor-only (binding decision 5): `null`. */
export function roleForStage(s: Stage): Role | null {
  return STAGE_ROLE[s];
}

/** Total, the inverse of `roleForStage` over the six agent-run stages. */
export function stageForRole(r: Role): Stage {
  return ROLE_STAGE[r];
}

// Mirrors src/core/clock.ts's IsoTimestampSchema exactly (same validation, same brand
// literal) without importing clock.ts, which the determinism zone forbids for this file.
const IsoTimestampSchema = z.string().datetime({ offset: false }).brand<'IsoTimestamp'>();
type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export interface StageFailureRecord {
  stage: Stage;
  attempt: number;
  reason: StageFailureReason;
  detail: string;
  at: IsoTimestamp;
  eventId: EventId;
}

export interface CheckpointStateRecord {
  id: CheckpointId;
  kind: CheckpointKind;
  stage: Stage;
  blocking: boolean;
  status: 'open' | 'accepted' | 'rejected' | 'auto-approved';
  raisedAt: IsoTimestamp;
  resolvedAt: IsoTimestamp | null;
  resolvedBy: 'human' | 'auto' | null;
}

export interface AssumptionRecord {
  id: AssumptionId;
  question: string;
  chosen: string;
  alternatives: readonly string[];
  affects: readonly string[];
  depth: number;
  at: IsoTimestamp;
}

export interface ArtifactRef {
  kind: ArtifactKind;
  sha256: string;
  stage: Stage;
  eventId: EventId;
  /** Durable event order, used to reject acceptance from a stale checkpoint. */
  seq?: number;
}

export interface ActiveArtifacts {
  readonly requirementSet: ArtifactRef | null;
  readonly architecturePlan: ArtifactRef | null;
  readonly taskGraph: ArtifactRef | null;
  readonly testSuiteSpec: ArtifactRef | null;
}

export interface WorkspaceCheckpointState {
  readonly eventId: WorkspaceCheckpointId;
  readonly kind: WorkspaceCheckpointKind;
  readonly taskId: TaskId | null;
  readonly parentCommit: string;
  readonly commit: string;
  readonly patch: { sha256: string; path: string; bytes: number } | null;
  /** Durable event order, used to prove this checkpoint follows the accepted evidence. */
  readonly seq?: number;
}

export interface TaskExecutionState {
  readonly taskId: TaskId;
  readonly orderIndex: number;
  readonly status: 'pending' | 'active' | 'accepted';
  readonly implementation: ArtifactRef | null;
  readonly review: ArtifactRef | null;
  /** Copied from the durable ReviewVerdict artifact for replay-time acceptance checks. */
  readonly reviewAccepted: boolean | null;
  readonly acceptedAt: IsoTimestamp | null;
  readonly checkpoint: WorkspaceCheckpointState | null;
}

export interface TaskRuntimeState {
  readonly taskGraphEventId: EventId;
  readonly activationEventId: EventId;
  readonly order: readonly TaskId[];
  readonly currentTaskId: TaskId | null;
  readonly records: Readonly<Record<TaskId, TaskExecutionState>>;
}

export interface FailureCauseState {
  readonly causeId: CauseId;
  readonly triggerEventId: EventId;
  readonly parentCauseId: CauseId | null;
  readonly kind: FailureKind;
  readonly taskId: TaskId | null;
  readonly status: 'active' | 'resolved' | 'human';
  readonly level: EscalationLevel;
  readonly affects: { readonly reqIds: readonly ReqId[]; readonly componentIds: readonly ComponentId[]; readonly taskIds: readonly TaskId[] };
  readonly attempts: Readonly<Record<FailureAttemptBucket, number>>;
  readonly exhausted: readonly FailureAttemptBucket[];
  readonly openedAt: IsoTimestamp;
  readonly resolvedAt: IsoTimestamp | null;
}

export interface OracleResultState {
  readonly eventId: EventId;
  readonly kind: OracleKind;
  readonly status: OracleResultStatus;
  readonly command: string | null;
  readonly commandSha256: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: { sha256: string; path: string; bytes: number };
  readonly stderr: { sha256: string; path: string; bytes: number };
}

export interface OracleSweepState {
  readonly sweepId: OracleSweepId;
  readonly scope: OracleScope;
  readonly taskId: TaskId | null;
  /** Immutable command declaration from OracleSweepStarted. */
  readonly commands: readonly { readonly kind: OracleKind; readonly command: string | null; readonly sha256: string | null }[];
  /** The active implementation when this task sweep began; null for integration. */
  readonly implementationEventId: EventId | null;
  readonly causeId: CauseId | null;
  readonly resultEventIds: readonly EventId[];
  readonly results: readonly OracleResultState[];
  readonly outcome: 'running' | 'passed' | 'failed' | 'aborted';
  readonly failedKind: OracleKind | null;
  /** Sequence of OracleSweepCompleted; absent only in legacy/synthetic projection state. */
  readonly completedSeq?: number;
}

export interface BudgetLedger {
  wallSeconds: number;
  turns: number | null;
  usd: number | null;
  partial: { turns: boolean; usd: boolean };
}

export interface BudgetExhaustion {
  readonly scope: BudgetScope;
  readonly limitKind: BudgetLimitKind;
  readonly at: IsoTimestamp;
  readonly resetsAt: IsoTimestamp | null;
  readonly detail: string;
}

export interface AccountLedger {
  readonly consumed: BudgetLedger;
  readonly exhausted: BudgetExhaustion | null;
}

export interface BudgetState {
  readonly accounts: Readonly<Record<AccountId, AccountLedger>>;
  readonly item: BudgetLedger;
  readonly itemExhausted: BudgetExhaustion | null;
}

export interface FrozenTestsState {
  readonly suiteId: SuiteId;
  readonly contentHash: string;
  readonly files: readonly { path: string; sha256: string; bytes: number }[];
  readonly frozenCopyDir: string;
  readonly at: IsoTimestamp;
}

export interface WorktreeLockState {
  readonly holder: ExecutorInstanceId;
  readonly workdir: string;
  readonly stage: Stage;
  readonly intent: SandboxIntent;
  readonly since: IsoTimestamp;
}

export interface ValidationFailureRecord {
  readonly stage: Stage;
  readonly role: Role;
  readonly attempt: number;
  readonly validationAttempt: 1 | 2;
  readonly kind: ValidationFailureKind;
  readonly errors: readonly string[];
  readonly at: IsoTimestamp;
}

export interface ItemArtifactRecord {
  readonly role: Role;
  readonly stage: Stage;
  readonly artifactKind: ArtifactKind;
  readonly sha256: string;
  readonly summary: string;
  readonly at: IsoTimestamp;
}

// Mirrors src/executors/executor.ts's ExecutorTelemetry contract (that module is built
// in a later item). Kept private and structural so this file does not need to import it.
interface ExecutorTelemetry {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  wallSeconds: number;
}

export interface WorkItemState {
  readonly projectionVersion: number;
  readonly itemId: WorkItemId;
  readonly slug: Slug;
  readonly seq: number;
  readonly lastEventId: EventId | null;
  /** Every event ID folded into this state; needed to validate durable causal references. */
  readonly priorEventIds?: readonly EventId[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly title: string;
  readonly source: { kind: 'prd-file'; path: string; sha256: string; bytes: number };
  readonly configHash: string;
  readonly status: 'active' | 'parked' | 'completed' | 'failed';
  readonly stage: Stage;
  readonly stageEnteredAt: IsoTimestamp | null;
  readonly attempts: Readonly<Record<Stage, number>>;
  readonly failures: readonly StageFailureRecord[];
  readonly park: {
    reason: ParkReason;
    detail: string;
    since: IsoTimestamp;
    resumable: boolean;
    account: AccountId | null;
    resetsAt: IsoTimestamp | null;
  } | null;
  readonly budget: BudgetState;
  readonly quotaAborts: Readonly<Record<Stage, number>>;
  readonly worktreeLock: WorktreeLockState | null;
  readonly frozenTests: FrozenTestsState | null;
  readonly validationFailures: readonly ValidationFailureRecord[];
  readonly itemArtifacts: readonly ItemArtifactRecord[];
  readonly workspace: {
    mode: TargetMode;
    targetRepo: string;
    workdir: string;
    baseRef: string;
    baseCommit: string;
    discarded: boolean;
  } | null;
  readonly lastExecutor: {
    executorId: ExecutorInstanceId;
    executorType: ExecutorType;
    account: AccountId;
    stage: Stage;
    status: ExecutorStatus;
    telemetry: ExecutorTelemetry;
    at: IsoTimestamp;
  } | null;
  readonly lastDiff: {
    sha256: string;
    filesTouched: readonly string[];
    untracked: readonly string[];
    insertions: number;
    deletions: number;
    committedDuringRun: boolean;
  } | null;
  readonly artifacts: ActiveArtifacts;
  /** Task IDs from the active TaskGraph artifact, retained for activation integrity checks. */
  readonly taskGraphTaskIds: readonly TaskId[] | null;
  /** Dependency edges retained with the graph so replay can validate its durable scheduler order. */
  readonly taskGraphDependencies: Readonly<Record<TaskId, readonly TaskId[]>> | null;
  readonly tasks: TaskRuntimeState | null;
  readonly activeCauseId: CauseId | null;
  readonly causes: Readonly<Record<CauseId, FailureCauseState>>;
  readonly invalidatedEventIds: readonly EventId[];
  /** Most recent invalidation boundary, retained to validate its following workspace rebuild. */
  readonly lastInvalidation?: { readonly causeId: CauseId; readonly target: InvalidationTarget; readonly taskIds: readonly TaskId[] } | null;
  readonly oracleSweeps: Readonly<Record<OracleSweepId, OracleSweepState>>;
  readonly workspaceCheckpoints: Readonly<Record<WorkspaceCheckpointId, WorkspaceCheckpointState>>;
  readonly integration: {
    status: 'pending' | 'running' | 'passed' | 'failed';
    sweepId: OracleSweepId | null;
    finalPatch: { sha256: string; path: string; bytes: number } | null;
  };
  readonly checkpoints: Readonly<Record<string, CheckpointStateRecord>>;
  readonly assumptions: readonly AssumptionRecord[];
  readonly drift: readonly {
    claim: ClaimId;
    expected: string;
    observed: string;
    area: string | null;
    at: IsoTimestamp;
  }[];
  readonly tampering: readonly {
    taskId: TaskId;
    suiteId: SuiteId;
    expectedHash: string;
    observedHash: string;
    paths: readonly string[];
    restored: boolean;
    at: IsoTimestamp;
  }[];
  readonly runs: readonly {
    runId: RunId;
    startedAt: IsoTimestamp;
    finishedAt: IsoTimestamp | null;
    outcome: RunOutcome | null;
  }[];
}

const SourceSchema = z
  .object({
    kind: z.literal('prd-file'),
    path: z.string(),
    sha256: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

const StatusSchema = z.enum(['active', 'parked', 'completed', 'failed']);

const ParkSchema = z
  .object({
    reason: z.enum(PARK_REASONS),
    detail: z.string(),
    since: IsoTimestampSchema,
    resumable: z.boolean(),
    account: AccountIdSchema.nullable(),
    resetsAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .nullable();

const AttemptsSchema = z
  .object({
    intake: z.number().int().nonnegative(),
    analysis: z.number().int().nonnegative(),
    architecture: z.number().int().nonnegative(),
    planning: z.number().int().nonnegative(),
    'test-authoring': z.number().int().nonnegative(),
    implementation: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    integration: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  })
  .strict();

const QuotaAbortsSchema = AttemptsSchema;

const StageFailureRecordSchema = z
  .object({
    stage: z.enum(STAGES),
    attempt: z.number().int().min(1),
    reason: z.enum(STAGE_FAILURE_REASONS),
    detail: z.string(),
    at: IsoTimestampSchema,
    eventId: EventIdSchema,
  })
  .strict();

const BudgetLedgerSchema = z
  .object({
    wallSeconds: z.number().nonnegative(),
    turns: z.number().int().nonnegative().nullable(),
    usd: z.number().nonnegative().nullable(),
    partial: z
      .object({
        turns: z.boolean(),
        usd: z.boolean(),
      })
      .strict(),
  })
  .strict();

const BudgetExhaustionSchema = z
  .object({
    scope: z.enum(BUDGET_SCOPES),
    limitKind: z.enum(BUDGET_LIMIT_KINDS),
    at: IsoTimestampSchema,
    resetsAt: IsoTimestampSchema.nullable(),
    detail: z.string(),
  })
  .strict();

const AccountLedgerSchema = z
  .object({
    consumed: BudgetLedgerSchema,
    exhausted: BudgetExhaustionSchema.nullable(),
  })
  .strict();

const BudgetStateSchema = z
  .object({
    accounts: z.record(AccountIdSchema, AccountLedgerSchema),
    item: BudgetLedgerSchema,
    itemExhausted: BudgetExhaustionSchema.nullable(),
  })
  .strict();

const FrozenTestsStateSchema = z
  .object({
    suiteId: SuiteIdSchema,
    contentHash: z.string(),
    files: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string(),
          bytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    frozenCopyDir: z.string(),
    at: IsoTimestampSchema,
  })
  .strict()
  .nullable();

const WorktreeLockStateSchema = z
  .object({
    holder: ExecutorInstanceIdSchema,
    workdir: z.string(),
    stage: z.enum(STAGES),
    intent: z.enum(SANDBOX_INTENTS),
    since: IsoTimestampSchema,
  })
  .strict()
  .nullable();

const ValidationFailureRecordSchema = z
  .object({
    stage: z.enum(STAGES),
    role: z.enum(ROLES),
    attempt: z.number().int().min(1),
    validationAttempt: z.union([z.literal(1), z.literal(2)]),
    kind: z.enum(VALIDATION_FAILURE_KINDS),
    errors: z.array(z.string()),
    at: IsoTimestampSchema,
  })
  .strict();

const ItemArtifactRecordSchema = z
  .object({
    role: z.enum(ROLES),
    stage: z.enum(STAGES),
    artifactKind: z.enum(ARTIFACT_KINDS),
    sha256: z.string(),
    summary: z.string(),
    at: IsoTimestampSchema,
  })
  .strict();

const WorkspaceStateSchema = z
  .object({
    mode: z.enum(TARGET_MODES),
    targetRepo: z.string(),
    workdir: z.string(),
    baseRef: z.string(),
    baseCommit: z.string(),
    discarded: z.boolean(),
  })
  .strict()
  .nullable();

const ExecutorTelemetrySchema = z
  .object({
    turns: z.number().int().nonnegative().nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    cacheCreationTokens: z.number().int().nonnegative().nullable(),
    wallSeconds: z.number().nonnegative(),
  })
  .strict();

const LastExecutorStateSchema = z
  .object({
    executorId: ExecutorInstanceIdSchema,
    executorType: z.enum(EXECUTOR_TYPES),
    account: AccountIdSchema,
    stage: z.enum(STAGES),
    status: z.enum(EXECUTOR_STATUSES),
    telemetry: ExecutorTelemetrySchema,
    at: IsoTimestampSchema,
  })
  .strict()
  .nullable();

const LastDiffStateSchema = z
  .object({
    sha256: z.string(),
    filesTouched: z.array(z.string()),
    untracked: z.array(z.string()),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    committedDuringRun: z.boolean(),
  })
  .strict()
  .nullable();

const ArtifactRefSchema = z
  .object({
    kind: z.enum(ARTIFACT_KINDS),
    sha256: z.string(),
    stage: z.enum(STAGES),
    eventId: EventIdSchema,
    seq: z.number().int().positive().optional(),
  })
  .strict();

const ActiveArtifactsSchema = z
  .object({
    requirementSet: ArtifactRefSchema.nullable(),
    architecturePlan: ArtifactRefSchema.nullable(),
    taskGraph: ArtifactRefSchema.nullable(),
    testSuiteSpec: ArtifactRefSchema.nullable(),
  })
  .strict();

const EvidenceRefSchema = z.object({ sha256: z.string(), path: z.string(), bytes: z.number().int().nonnegative() }).strict();
const WorkspaceCheckpointStateSchema = z.object({
  eventId: EventIdSchema, kind: z.enum(WORKSPACE_CHECKPOINT_KINDS), taskId: TaskIdSchema.nullable(),
  parentCommit: z.string(), commit: z.string(), patch: EvidenceRefSchema.nullable(), seq: z.number().int().positive().optional(),
}).strict();
const TaskExecutionStateSchema = z.object({
  taskId: TaskIdSchema, orderIndex: z.number().int().nonnegative(), status: z.enum(['pending', 'active', 'accepted']),
  implementation: ArtifactRefSchema.nullable(), review: ArtifactRefSchema.nullable(),
  reviewAccepted: z.boolean().nullable(),
  acceptedAt: IsoTimestampSchema.nullable(), checkpoint: WorkspaceCheckpointStateSchema.nullable(),
}).strict();
const TaskRuntimeStateSchema = z.object({
  taskGraphEventId: EventIdSchema, activationEventId: EventIdSchema, order: z.array(TaskIdSchema),
  currentTaskId: TaskIdSchema.nullable(), records: z.record(TaskIdSchema, TaskExecutionStateSchema),
}).strict().nullable();
const FailureAttemptsSchema = z.object({ oracle: z.number().int().nonnegative(), test: z.number().int().nonnegative(), review: z.number().int().nonnegative(), reviewer: z.number().int().nonnegative(), planner: z.number().int().nonnegative(), architect: z.number().int().nonnegative(), analyst: z.number().int().nonnegative() }).strict();
const FailureCauseStateSchema = z.object({
  causeId: EventIdSchema, triggerEventId: EventIdSchema, parentCauseId: EventIdSchema.nullable(), kind: z.enum(FAILURE_KINDS), taskId: TaskIdSchema.nullable(), status: z.enum(['active', 'resolved', 'human']), level: z.enum(ESCALATION_LEVELS),
  affects: z.object({ reqIds: z.array(ReqIdSchema), componentIds: z.array(ComponentIdSchema), taskIds: z.array(TaskIdSchema) }).strict(),
  attempts: FailureAttemptsSchema, exhausted: z.array(z.enum(FAILURE_ATTEMPT_BUCKETS)), openedAt: IsoTimestampSchema, resolvedAt: IsoTimestampSchema.nullable(),
}).strict();
const LastInvalidationSchema = z.object({ causeId: EventIdSchema, target: z.enum(INVALIDATION_TARGETS), taskIds: z.array(TaskIdSchema) }).strict().nullable().optional();
const OracleResultStateSchema = z.object({
  eventId: EventIdSchema, kind: z.enum(ORACLE_KINDS), status: z.enum(ORACLE_RESULT_STATUSES), command: z.string().nullable(), commandSha256: z.string().nullable(), exitCode: z.number().int().nullable(), signal: z.string().nullable(), durationMs: z.number().int().nonnegative(), stdout: EvidenceRefSchema, stderr: EvidenceRefSchema,
}).strict();
const OracleSweepStateSchema = z.object({
  sweepId: EventIdSchema, scope: z.enum(ORACLE_SCOPES), taskId: TaskIdSchema.nullable(), commands: z.array(z.object({ kind: z.enum(ORACLE_KINDS), command: z.string().nullable(), sha256: z.string().nullable() }).strict()), implementationEventId: EventIdSchema.nullable(), causeId: EventIdSchema.nullable(), resultEventIds: z.array(EventIdSchema), results: z.array(OracleResultStateSchema), outcome: z.enum(['running', 'passed', 'failed', 'aborted']), failedKind: z.enum(ORACLE_KINDS).nullable(), completedSeq: z.number().int().positive().optional(),
}).strict();
const IntegrationStateSchema = z.object({ status: z.enum(['pending', 'running', 'passed', 'failed']), sweepId: EventIdSchema.nullable(), finalPatch: EvidenceRefSchema.nullable() }).strict();

const CheckpointStateRecordSchema = z
  .object({
    id: CheckpointIdSchema,
    kind: z.enum(CHECKPOINT_KINDS),
    stage: z.enum(STAGES),
    blocking: z.boolean(),
    status: z.enum(['open', 'accepted', 'rejected', 'auto-approved']),
    raisedAt: IsoTimestampSchema,
    resolvedAt: IsoTimestampSchema.nullable(),
    resolvedBy: z.union([z.literal('human'), z.literal('auto')]).nullable(),
  })
  .strict();

const AssumptionRecordSchema = z
  .object({
    id: AssumptionIdSchema,
    question: z.string(),
    chosen: z.string(),
    alternatives: z.array(z.string()),
    affects: z.array(z.string()),
    depth: z.number().int().nonnegative(),
    at: IsoTimestampSchema,
  })
  .strict();

const DriftRecordSchema = z
  .object({
    claim: ClaimIdSchema,
    expected: z.string(),
    observed: z.string(),
    area: z.string().nullable(),
    at: IsoTimestampSchema,
  })
  .strict();

const TamperingRecordSchema = z
  .object({
    taskId: TaskIdSchema,
    suiteId: SuiteIdSchema,
    expectedHash: z.string(),
    observedHash: z.string(),
    paths: z.array(z.string()),
    restored: z.boolean(),
    at: IsoTimestampSchema,
  })
  .strict();

const RunRecordSchema = z
  .object({
    runId: RunIdSchema,
    startedAt: IsoTimestampSchema,
    finishedAt: IsoTimestampSchema.nullable(),
    outcome: z.enum(RUN_OUTCOMES).nullable(),
  })
  .strict();

// zod's `.optional()` infers `T | undefined` for a present-but-optional key, which is
// stricter than `Partial<Record<Stage, ArtifactRef>>`'s `key?: ArtifactRef` (no explicit
// `undefined`) under `exactOptionalPropertyTypes`. The runtime behaviour (missing keys
// accepted, present keys validated) is exactly what WorkItemState requires; only the
// intermediate zod-inferred type is stricter than the mapped type, hence the cast below.
export const WorkItemStateSchema = z
  .object({
    projectionVersion: z.number().int().nonnegative(),
    itemId: WorkItemIdSchema,
    slug: SlugSchema,
    seq: z.number().int().positive(),
    lastEventId: EventIdSchema.nullable(),
    priorEventIds: z.array(EventIdSchema).optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    title: z.string(),
    source: SourceSchema,
    configHash: z.string(),
    status: StatusSchema,
    stage: z.enum(STAGES),
    stageEnteredAt: IsoTimestampSchema.nullable(),
    attempts: AttemptsSchema,
    failures: z.array(StageFailureRecordSchema),
    park: ParkSchema,
    budget: BudgetStateSchema,
    quotaAborts: QuotaAbortsSchema,
    worktreeLock: WorktreeLockStateSchema,
    frozenTests: FrozenTestsStateSchema,
    validationFailures: z.array(ValidationFailureRecordSchema),
    itemArtifacts: z.array(ItemArtifactRecordSchema),
    workspace: WorkspaceStateSchema,
    lastExecutor: LastExecutorStateSchema,
    lastDiff: LastDiffStateSchema,
    artifacts: ActiveArtifactsSchema,
    taskGraphTaskIds: z.array(TaskIdSchema).nullable(),
    taskGraphDependencies: z.record(TaskIdSchema, z.array(TaskIdSchema)).nullable(),
    tasks: TaskRuntimeStateSchema,
    activeCauseId: EventIdSchema.nullable(),
    causes: z.record(EventIdSchema, FailureCauseStateSchema),
    invalidatedEventIds: z.array(EventIdSchema),
    lastInvalidation: LastInvalidationSchema,
    oracleSweeps: z.record(EventIdSchema, OracleSweepStateSchema),
    workspaceCheckpoints: z.record(EventIdSchema, WorkspaceCheckpointStateSchema),
    integration: IntegrationStateSchema,
    checkpoints: z.record(z.string(), CheckpointStateRecordSchema),
    assumptions: z.array(AssumptionRecordSchema),
    drift: z.array(DriftRecordSchema),
    tampering: z.array(TamperingRecordSchema),
    runs: z.array(RunRecordSchema),
  })
  .strict() as unknown as z.ZodType<WorkItemState>;
