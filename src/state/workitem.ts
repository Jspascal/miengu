import { z } from 'zod';
import {
  ARTIFACT_KINDS,
  BUDGET_LIMIT_KINDS,
  BUDGET_SCOPES,
  CHECKPOINT_KINDS,
  EXECUTOR_STATUSES,
  PARK_REASONS,
  RUN_OUTCOMES,
  STAGE_FAILURE_REASONS,
  STAGES,
  TARGET_MODES,
} from '../core/events.js';
import type {
  ArtifactKind,
  BudgetLimitKind,
  BudgetScope,
  CheckpointKind,
  ExecutorStatus,
  ParkReason,
  RunOutcome,
  Stage,
  StageFailureReason,
  TargetMode,
} from '../core/events.js';
import {
  AssumptionIdSchema,
  CheckpointIdSchema,
  ClaimIdSchema,
  EventIdSchema,
  RunIdSchema,
  SlugSchema,
  SuiteIdSchema,
  TaskIdSchema,
  WorkItemIdSchema,
} from '../core/ids.js';
import type {
  AssumptionId,
  CheckpointId,
  ClaimId,
  EventId,
  RunId,
  Slug,
  SuiteId,
  TaskId,
  WorkItemId,
} from '../core/ids.js';

export const PROJECTION_VERSION = 1;

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
}

export interface BudgetLedger {
  wallSeconds: number;
  turns: number | null;
  usd: number | null;
  partial: { turns: boolean; usd: boolean };
}

// Mirrors src/executors/executor.ts's ExecutorTelemetry contract (that module is built
// in a later item). Kept private and structural so this file does not need to import it.
interface ExecutorTelemetry {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  wallSeconds: number;
}

export interface WorkItemState {
  readonly projectionVersion: number;
  readonly itemId: WorkItemId;
  readonly slug: Slug;
  readonly seq: number;
  readonly lastEventId: EventId | null;
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
  } | null;
  readonly budget: {
    readonly consumed: BudgetLedger;
    readonly exhausted: { scope: BudgetScope; limitKind: BudgetLimitKind; at: IsoTimestamp } | null;
  };
  readonly workspace: {
    mode: TargetMode;
    targetRepo: string;
    workdir: string;
    baseRef: string;
    baseCommit: string;
    discarded: boolean;
  } | null;
  readonly lastExecutor: {
    executorId: string;
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
  readonly artifacts: Readonly<Partial<Record<Stage, ArtifactRef>>>;
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

const BudgetStateSchema = z
  .object({
    consumed: BudgetLedgerSchema,
    exhausted: z
      .object({
        scope: z.enum(BUDGET_SCOPES),
        limitKind: z.enum(BUDGET_LIMIT_KINDS),
        at: IsoTimestampSchema,
      })
      .strict()
      .nullable(),
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
    wallSeconds: z.number().nonnegative(),
  })
  .strict();

const LastExecutorStateSchema = z
  .object({
    executorId: z.string(),
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
  })
  .strict();

const ArtifactsSchema = z
  .object({
    intake: ArtifactRefSchema.optional(),
    analysis: ArtifactRefSchema.optional(),
    architecture: ArtifactRefSchema.optional(),
    planning: ArtifactRefSchema.optional(),
    'test-authoring': ArtifactRefSchema.optional(),
    implementation: ArtifactRefSchema.optional(),
    review: ArtifactRefSchema.optional(),
    integration: ArtifactRefSchema.optional(),
    done: ArtifactRefSchema.optional(),
  })
  .strict();

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
    workspace: WorkspaceStateSchema,
    lastExecutor: LastExecutorStateSchema,
    lastDiff: LastDiffStateSchema,
    artifacts: ArtifactsSchema,
    checkpoints: z.record(z.string(), CheckpointStateRecordSchema),
    assumptions: z.array(AssumptionRecordSchema),
    drift: z.array(DriftRecordSchema),
    tampering: z.array(TamperingRecordSchema),
    runs: z.array(RunRecordSchema),
  })
  .strict() as unknown as z.ZodType<WorkItemState>;
