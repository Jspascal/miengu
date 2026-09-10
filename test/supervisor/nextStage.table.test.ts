import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../src/core/canonical.js';
import { IsoTimestampSchema } from '../../src/core/clock.js';
import { CHECKPOINT_KINDS, STAGES } from '../../src/core/events.js';
import type { AccountId, CheckpointKind, EscalationLevel, FailureAttemptBucket, Stage } from '../../src/core/events.js';
import { sha256Hex } from '../../src/core/hash.js';
import {
  AccountIdSchema,
  CheckpointIdSchema,
  EventIdSchema,
  SlugSchema,
  WorkItemIdSchema,
  formatCheckpointId,
} from '../../src/core/ids.js';
import { limitForStage, nextStage } from '../../src/supervisor/nextStage.js';
import type { StageDecision, StagePolicy } from '../../src/supervisor/nextStage.js';
import { EMPTY_LEDGER } from '../../src/supervisor/budget.js';
import { PROJECTION_VERSION, emptyAttempts, emptyQuotaAborts } from '../../src/state/workitem.js';
import type { CheckpointStateRecord, WorkItemState } from '../../src/state/workitem.js';
import { bucketLimit, escalationRank } from '../../src/supervisor/escalation.js';

const GOLDEN_PATH = fileURLToPath(new URL('../golden/nextStage.table.json', import.meta.url));
const PHASE1_NONPARK_PATH = fileURLToPath(
  new URL('../golden/nextStage.table.phase1-nonpark.json', import.meta.url),
);
const PHASE2_GOLDEN_PATH = fileURLToPath(
  new URL('../golden/nextStage.phase2.table.json', import.meta.url),
);
const PHASE5_GOLDEN_PATH = fileURLToPath(
  new URL('../golden/nextStage.phase5.table.json', import.meta.url),
);

const TIMESTAMP = IsoTimestampSchema.parse('2024-01-01T00:00:00.000Z');
const ITEM_ID = WorkItemIdSchema.parse('wi-example-abc123');
const SLUG = SlugSchema.parse('example');
const EVENT_ID = EventIdSchema.parse('evt-00000000-0000-4000-8000-000000000000');
const CHECKPOINT_ID = CheckpointIdSchema.parse('cp-example-1');

function nullStageAccounts(): Readonly<Record<Stage, AccountId | null>> {
  const out = {} as Record<Stage, AccountId | null>;
  for (const stage of STAGES) {
    out[stage] = null;
  }
  return out;
}

const POLICY: StagePolicy = {
  limits: { kOracle: 3, kTest: 3, kReview: 2, maxAttemptsPerStage: 3 },
  stageAccounts: nullStageAccounts(),
};

const STATUSES = ['active', 'parked', 'completed', 'failed'] as const;
const ATTEMPT_CATEGORIES = ['zero', 'limit-minus-one', 'at-limit'] as const;
const BUDGET_EXHAUSTED_CAUSES = ['none', 'budget-caused', 'provider-quota-caused'] as const;
type AttemptCategory = (typeof ATTEMPT_CATEGORIES)[number];
type Status = (typeof STATUSES)[number];
type BudgetExhaustedCause = (typeof BUDGET_EXHAUSTED_CAUSES)[number];

interface Row {
  readonly stage: Stage;
  readonly status: Status;
  readonly budgetExhausted: BudgetExhaustedCause;
  readonly attemptsCategory: AttemptCategory;
  readonly attempts: number;
  readonly openBlockingCheckpoint: boolean;
}

function attemptsValueFor(limit: number, category: AttemptCategory): number {
  switch (category) {
    case 'zero':
      return 0;
    case 'limit-minus-one':
      return Math.max(limit - 1, 0);
    case 'at-limit':
      return limit;
  }
}

/**
 * Programmatically generates the 648-row cross product
 * `Stage(9) x status(4) x budgetExhausted(3: none | budget-caused | provider-quota-caused) x
 * attempts in {0, limit-1, limit}(3) x openBlockingCheckpoint(2)`. Never hand-written, never
 * randomised.
 */
function generateRows(): Row[] {
  const rows: Row[] = [];
  for (const stage of STAGES) {
    const limit = limitForStage(stage, POLICY);
    for (const status of STATUSES) {
      for (const budgetExhausted of BUDGET_EXHAUSTED_CAUSES) {
        for (const attemptsCategory of ATTEMPT_CATEGORIES) {
          const attempts = attemptsValueFor(limit, attemptsCategory);
          for (const openBlockingCheckpoint of [false, true]) {
            rows.push({
              stage,
              status,
              budgetExhausted,
              attemptsCategory,
              attempts,
              openBlockingCheckpoint,
            });
          }
        }
      }
    }
  }
  return rows;
}

function buildState(row: {
  stage: Stage;
  status: Status;
  budgetExhausted: BudgetExhaustedCause;
  attempts: number;
  openBlockingCheckpoint: boolean;
}): WorkItemState {
  return {
    projectionVersion: PROJECTION_VERSION,
    itemId: ITEM_ID,
    slug: SLUG,
    seq: 1,
    lastEventId: EVENT_ID,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    title: 'Example item',
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    configHash: 'deadbeef',
    status: row.status,
    stage: row.stage,
    stageEnteredAt: TIMESTAMP,
    attempts: { ...emptyAttempts(), [row.stage]: row.attempts },
    failures: [],
    park:
      row.status === 'parked'
        ? {
            reason: 'awaiting-human',
            detail: 'test-park',
            since: TIMESTAMP,
            resumable: true,
            account: null,
            resetsAt: null,
          }
        : null,
    budget: {
      accounts: {},
      item: EMPTY_LEDGER,
      itemExhausted:
        row.budgetExhausted === 'none'
          ? null
          : {
              scope: 'task',
              limitKind: row.budgetExhausted === 'provider-quota-caused' ? 'provider-quota' : 'turns',
              at: TIMESTAMP,
              resetsAt: null,
              detail: 'test-budget-exhausted',
            },
    },
    quotaAborts: emptyQuotaAborts(),
    worktreeLock: null,
    frozenTests: null,
    validationFailures: [],
    itemArtifacts: [],
    workspace: null,
    lastExecutor: null,
    lastDiff: null,
    artifacts: {},
    checkpoints: row.openBlockingCheckpoint
      ? {
          [CHECKPOINT_ID]: {
            id: CHECKPOINT_ID,
            kind: 'irreversible',
            stage: row.stage,
            blocking: true,
            status: 'open',
            raisedAt: TIMESTAMP,
            resolvedAt: null,
            resolvedBy: null,
          },
        }
      : {},
    assumptions: [],
    drift: [],
    tampering: [],
    runs: [],
  };
}

function decisionFor(row: Row): StageDecision {
  const state = buildState(row);
  return nextStage(state, POLICY);
}

function serializeRow(row: Row): string {
  return canonicalJson({ row, decision: decisionFor(row) });
}

describe('nextStage: 648-row guard-precedence table', () => {
  const rows = generateRows();
  const generated = rows.map(serializeRow);
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as string[];
  const phase1Nonpark = JSON.parse(readFileSync(PHASE1_NONPARK_PATH, 'utf8')) as string[];

  it('generates exactly the 648-row cross product', () => {
    expect(rows).toHaveLength(648);
  });

  it('never throws, and every decision is one of the four StageDecision kinds', () => {
    for (const row of rows) {
      const state = buildState(row);
      let decision: StageDecision | undefined;
      expect(() => {
        decision = nextStage(state, POLICY);
      }).not.toThrow();
      expect(['run', 'checkpoint', 'park', 'done']).toContain(decision?.kind);
    }
  });

  it('matches the committed golden table (canonicalJson per row)', () => {
    expect(generated).toEqual(golden);
  });

  it('"account" in decision iff decision.kind === "park"', () => {
    for (const row of rows) {
      const decision = decisionFor(row);
      expect('account' in decision).toBe(decision.kind === 'park');
    }
  });

  it('every non-park entry is byte-identical to its frozen Phase 1 counterpart', () => {
    const nonParkGenerated = rows
      .map((row, index) => ({ row, serialized: generated[index] }))
      .filter(({ row }) => decisionFor(row).kind !== 'park')
      .map(({ serialized }) => serialized);
    expect(nonParkGenerated).toEqual(phase1Nonpark);
  });

  it('precedence: parked + budget-exhausted => park carrying the park reason, not the budget reason', () => {
    const decision = decisionFor({
      stage: 'implementation',
      status: 'parked',
      budgetExhausted: 'budget-caused',
      attemptsCategory: 'zero',
      attempts: 0,
      openBlockingCheckpoint: false,
    });
    expect(decision).toEqual({
      kind: 'park',
      reason: 'awaiting-human',
      detail: 'test-park',
      account: null,
    });
  });

  it('precedence: budget-exhausted + attempts-over => budget-exhausted', () => {
    const decision = decisionFor({
      stage: 'implementation',
      status: 'active',
      budgetExhausted: 'budget-caused',
      attemptsCategory: 'at-limit',
      attempts: limitForStage('implementation', POLICY) + 5,
      openBlockingCheckpoint: false,
    });
    expect(decision.kind).toBe('park');
    if (decision.kind === 'park') {
      expect(decision.reason).toBe('budget-exhausted');
    }
  });

  it('precedence: open blocking checkpoint + attempts-over => checkpoint', () => {
    const decision = decisionFor({
      stage: 'implementation',
      status: 'active',
      budgetExhausted: 'none',
      attemptsCategory: 'at-limit',
      attempts: limitForStage('implementation', POLICY) + 5,
      openBlockingCheckpoint: true,
    });
    expect(decision.kind).toBe('checkpoint');
  });

  it('provider-quota exhaustion parks with reason "provider-quota"', () => {
    const decision = decisionFor({
      stage: 'implementation',
      status: 'active',
      budgetExhausted: 'provider-quota-caused',
      attemptsCategory: 'zero',
      attempts: 0,
      openBlockingCheckpoint: false,
    });
    expect(decision.kind).toBe('park');
    if (decision.kind === 'park') {
      expect(decision.reason).toBe('provider-quota');
    }
  });
});

// --- Phase 2 dimensions: account-aware guards (§0.7 binding decision 27) ---
// A separate golden file and a separate generator. Appending to the Phase 1 array is
// forbidden; this table lives in its own file with its own cross product.

const ACCT_A = AccountIdSchema.parse('acct-a');
const ACCT_B = AccountIdSchema.parse('acct-b');

const PHASE2_STAGE_ACCOUNTS: Readonly<Record<Stage, AccountId | null>> = {
  intake: null,
  analysis: ACCT_A,
  architecture: ACCT_A,
  planning: ACCT_A,
  'test-authoring': ACCT_A,
  implementation: ACCT_B,
  review: ACCT_B,
  integration: null,
  done: null,
};

const PHASE2_POLICY: StagePolicy = {
  limits: POLICY.limits,
  stageAccounts: PHASE2_STAGE_ACCOUNTS,
};

const ACCOUNT_EXHAUSTED_CASES = ['none', 'this-stage', 'different-stage'] as const;
type AccountExhaustedCase = (typeof ACCOUNT_EXHAUSTED_CASES)[number];

interface Phase2Row {
  readonly stage: Stage;
  readonly accountExhausted: AccountExhaustedCase;
  readonly quotaAborts: number;
  readonly attemptsCategory: AttemptCategory;
  readonly attempts: number;
  readonly openBlockingCheckpoint: boolean;
}

/**
 * Programmatically generates the 486-row cross product
 * `Stage(9) x accountExhausted(3: none | this stage's account | a different account) x
 *  quotaAborts(3: 0, 1, 2) x attempts(3: 0, limit-1, limit) x openBlockingCheckpoint(2)`.
 * `status` is fixed to `'active'`. Never hand-written, never randomised.
 */
function generatePhase2Rows(): Phase2Row[] {
  const rows: Phase2Row[] = [];
  for (const stage of STAGES) {
    const limit = limitForStage(stage, PHASE2_POLICY);
    for (const accountExhausted of ACCOUNT_EXHAUSTED_CASES) {
      for (const quotaAborts of [0, 1, 2]) {
        for (const attemptsCategory of ATTEMPT_CATEGORIES) {
          const attempts = attemptsValueFor(limit, attemptsCategory);
          for (const openBlockingCheckpoint of [false, true]) {
            rows.push({
              stage,
              accountExhausted,
              quotaAborts,
              attemptsCategory,
              attempts,
              openBlockingCheckpoint,
            });
          }
        }
      }
    }
  }
  return rows;
}

function otherAccount(a: AccountId | null): AccountId {
  return a === ACCT_A ? ACCT_B : ACCT_A;
}

function buildPhase2State(row: Phase2Row): WorkItemState {
  const thisAccount = PHASE2_STAGE_ACCOUNTS[row.stage];
  const exhaustedAccount: AccountId | null =
    row.accountExhausted === 'none'
      ? null
      : row.accountExhausted === 'this-stage'
        ? (thisAccount ?? otherAccount(null))
        : otherAccount(thisAccount);

  return {
    projectionVersion: PROJECTION_VERSION,
    itemId: ITEM_ID,
    slug: SLUG,
    seq: 1,
    lastEventId: EVENT_ID,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    title: 'Example item',
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    configHash: 'deadbeef',
    status: 'active',
    stage: row.stage,
    stageEnteredAt: TIMESTAMP,
    attempts: { ...emptyAttempts(), [row.stage]: row.attempts },
    failures: [],
    park: null,
    budget: {
      accounts:
        exhaustedAccount === null
          ? {}
          : {
              [exhaustedAccount]: {
                consumed: EMPTY_LEDGER,
                exhausted: {
                  scope: 'item',
                  limitKind: 'provider-quota',
                  at: TIMESTAMP,
                  resetsAt: TIMESTAMP,
                  detail: 'test-account-exhausted',
                },
              },
            },
      item: EMPTY_LEDGER,
      itemExhausted: null,
    },
    quotaAborts: { ...emptyQuotaAborts(), [row.stage]: row.quotaAborts },
    worktreeLock: null,
    frozenTests: null,
    validationFailures: [],
    itemArtifacts: [],
    workspace: null,
    lastExecutor: null,
    lastDiff: null,
    artifacts: {},
    checkpoints: row.openBlockingCheckpoint
      ? {
          [CHECKPOINT_ID]: {
            id: CHECKPOINT_ID,
            kind: 'irreversible',
            stage: row.stage,
            blocking: true,
            status: 'open',
            raisedAt: TIMESTAMP,
            resolvedAt: null,
            resolvedBy: null,
          },
        }
      : {},
    assumptions: [],
    drift: [],
    tampering: [],
    runs: [],
  };
}

function phase2DecisionFor(row: Phase2Row): StageDecision {
  return nextStage(buildPhase2State(row), PHASE2_POLICY);
}

function serializePhase2Row(row: Phase2Row): string {
  return canonicalJson({ row, decision: phase2DecisionFor(row) });
}

describe('nextStage: 486-row Phase 2 account-aware guard table', () => {
  const rows = generatePhase2Rows();
  const generated = rows.map(serializePhase2Row);
  const golden = JSON.parse(readFileSync(PHASE2_GOLDEN_PATH, 'utf8')) as string[];

  it('generates exactly the 486-row cross product', () => {
    expect(rows).toHaveLength(486);
  });

  it('never throws, and every decision is one of the four StageDecision kinds', () => {
    for (const row of rows) {
      const state = buildPhase2State(row);
      let decision: StageDecision | undefined;
      expect(() => {
        decision = nextStage(state, PHASE2_POLICY);
      }).not.toThrow();
      expect(['run', 'checkpoint', 'park', 'done']).toContain(decision?.kind);
    }
  });

  it('matches the committed Phase 2 golden table (canonicalJson per row)', () => {
    expect(generated).toEqual(golden);
  });

  it("criterion 10: a different account exhausted does NOT park", () => {
    const decision = phase2DecisionFor({
      stage: 'analysis',
      accountExhausted: 'different-stage',
      quotaAborts: 0,
      attemptsCategory: 'zero',
      attempts: 0,
      openBlockingCheckpoint: false,
    });
    expect(decision.kind).toBe('run');
  });

  it("this stage's account exhausted parks with reason 'provider-quota' and account naming it, even at attempts: 0", () => {
    const decision = phase2DecisionFor({
      stage: 'analysis',
      accountExhausted: 'this-stage',
      quotaAborts: 0,
      attemptsCategory: 'zero',
      attempts: 0,
      openBlockingCheckpoint: false,
    });
    expect(decision.kind).toBe('park');
    if (decision.kind === 'park') {
      expect(decision.reason).toBe('provider-quota');
      expect(decision.account).toBe(ACCT_A);
    }
  });

  it("criterion 10: quotaAborts === attempts yields run with attempt: 1 at the limit (no attempt burn)", () => {
    const limit = limitForStage('analysis', PHASE2_POLICY);
    const decision = phase2DecisionFor({
      stage: 'analysis',
      accountExhausted: 'none',
      quotaAborts: limit,
      attemptsCategory: 'at-limit',
      attempts: limit,
      openBlockingCheckpoint: false,
    });
    expect(decision).toEqual({ kind: 'run', stage: 'analysis', attempt: 1, needsHuman: false });
  });
});

// --- Phase 3 dimensions: causal attempts and task runtime ---
// This is generated, not a hand-maintained routing matrix. It deliberately leaves the Phase 1
// and 2 goldens untouched: their states have no activated graph and remain replay-compatible.
const LEVELS = ['coder', 'reviewer', 'planner', 'architect', 'analyst', 'human'] as const;
const BUCKETS = ['oracle', 'test', 'review', 'reviewer', 'planner', 'architect', 'analyst'] as const;
const TASK_STATUSES = ['pending', 'active', 'accepted'] as const;
const ORACLE_STATUSES = ['none', 'passed', 'failed'] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];
type OracleStatus = (typeof ORACLE_STATUSES)[number];

function v3State(values: {
  readonly level: EscalationLevel;
  readonly bucket: FailureAttemptBucket;
  readonly count: 'zero' | 'limit-minus-one' | 'limit';
  readonly taskStatus: TaskStatus;
  readonly oracle: OracleStatus;
  readonly budgetExhausted: boolean;
  readonly checkpoint: boolean;
  readonly terminal: boolean;
}): WorkItemState {
  const limit = bucketLimit(values.bucket, POLICY.limits);
  const attempts = values.count === 'zero' ? 0 : values.count === 'limit-minus-one' ? limit - 1 : limit;
  const base = buildState({ stage: 'implementation', status: values.terminal ? 'completed' : 'active', budgetExhausted: values.budgetExhausted ? 'budget-caused' : 'none', attempts: 0, openBlockingCheckpoint: values.checkpoint });
  const taskId = 'task-a' as WorkItemState['itemId'] as never;
  const causeId = 'evt-00000000-0000-4000-8000-000000000001' as WorkItemState['lastEventId'];
  const task = { taskId, orderIndex: 0, status: values.taskStatus, implementation: values.taskStatus === 'pending' ? null : { kind: 'implementation' as const, sha256: 'b'.repeat(64), stage: 'implementation' as const, eventId: EVENT_ID }, review: null, acceptedAt: null, checkpoint: null };
  const sweep = values.oracle === 'none' ? {} : { [EVENT_ID]: { sweepId: EVENT_ID, scope: 'task' as const, taskId, implementationEventId: EVENT_ID, causeId, resultEventIds: [], results: [], outcome: values.oracle, failedKind: values.oracle === 'failed' ? 'test' as const : null } };
  return {
    ...base,
    artifacts: { requirementSet: null, architecturePlan: null, taskGraph: { kind: 'task-graph', sha256: 'c'.repeat(64), stage: 'planning', eventId: EVENT_ID }, testSuiteSpec: null },
    frozenTests: { suiteId: 'suite-a' as never, contentHash: 'd'.repeat(64), files: [], frozenCopyDir: 'frozen', at: TIMESTAMP },
    tasks: { taskGraphEventId: EVENT_ID, activationEventId: EVENT_ID, order: [taskId], currentTaskId: values.taskStatus === 'active' ? taskId : null, records: { [taskId]: task } },
    activeCauseId: values.level === 'coder' && values.oracle === 'none' ? null : causeId,
    causes: values.level === 'coder' && values.oracle === 'none' ? {} : { [causeId!]: { causeId: causeId!, triggerEventId: EVENT_ID, parentCauseId: null, kind: values.bucket === 'oracle' ? 'oracle' : values.bucket === 'test' ? 'test' : 'review-revision', taskId, status: values.level === 'human' ? 'human' : 'active', level: values.level, affects: { reqIds: [], componentIds: [], taskIds: [taskId] }, attempts: { oracle: values.bucket === 'oracle' ? attempts : 0, test: values.bucket === 'test' ? attempts : 0, review: values.bucket === 'review' ? attempts : 0, reviewer: values.bucket === 'reviewer' ? attempts : 0, planner: values.bucket === 'planner' ? attempts : 0, architect: values.bucket === 'architect' ? attempts : 0, analyst: values.bucket === 'analyst' ? attempts : 0 }, exhausted: [], openedAt: TIMESTAMP, resolvedAt: null } },
    oracleSweeps: sweep,
    integration: { status: 'pending', sweepId: null, finalPatch: null },
  };
}

describe('nextStage: generated Phase 3 causal routing table', () => {
  const rows = [] as Array<{
    level: EscalationLevel; bucket: FailureAttemptBucket; count: 'zero' | 'limit-minus-one' | 'limit';
    taskStatus: TaskStatus; oracle: OracleStatus; budgetExhausted: boolean; checkpoint: boolean; terminal: boolean;
  }>;
  for (const level of LEVELS) for (const bucket of BUCKETS) for (const count of ['zero', 'limit-minus-one', 'limit'] as const) for (const taskStatus of TASK_STATUSES) for (const oracle of ORACLE_STATUSES) for (const budgetExhausted of [false, true]) for (const checkpoint of [false, true]) {
    rows.push({ level, bucket, count, taskStatus, oracle, budgetExhausted, checkpoint, terminal: false });
  }

  it('covers the deterministic causal cross-product', () => {
    expect(rows).toHaveLength(4536);
  });

  it('preserves terminal, budget, and checkpoint precedence before causal routing', () => {
    expect(nextStage(v3State({ ...rows[0]!, terminal: true }), POLICY)).toEqual({ kind: 'done', outcome: 'completed' });
    expect(nextStage(v3State({ ...rows[0]!, budgetExhausted: true }), POLICY).kind).toBe('park');
    expect(nextStage(v3State({ ...rows[0]!, checkpoint: true }), POLICY).kind).toBe('checkpoint');
  });

  it('never lowers a cause rank and exhaustions advance one rung', () => {
    for (const row of rows) {
      const decision = nextStage(v3State(row), POLICY);
      if (decision.action === 'advance-escalation') {
        expect(decision.level).toBeDefined();
        expect(escalationRank(decision.level!)).toBeGreaterThan(escalationRank(row.level));
      }
    }
  });

  it('uses finite action choices for every generated state', () => {
    for (const row of rows) {
      const decision = nextStage(v3State(row), POLICY);
      expect(['run', 'park', 'checkpoint', 'done']).toContain(decision.kind);
      if (decision.kind === 'run' && decision.action !== undefined) {
        expect(['activate-task-graph', 'checkpoint-tests', 'start-task', 'task-oracle', 'review-task', 'accept-task', 'invalidate-artifacts', 'advance-escalation', 'integration-oracle', 'capture-final-patch']).toContain(decision.action);
      }
    }
  });

  it('advances an exhausted originating handler rather than parking or invoking it again', () => {
    const base = v3State({ level: 'planner', bucket: 'planner', count: 'zero', taskStatus: 'active', oracle: 'passed', budgetExhausted: false, checkpoint: false, terminal: false });
    const causeId = base.activeCauseId!;
    const exhausted: WorkItemState = {
      ...base,
      stage: 'planning',
      attempts: { ...base.attempts, planning: POLICY.limits.maxAttemptsPerStage },
      failures: [{
        stage: 'planning', attempt: POLICY.limits.maxAttemptsPerStage,
        reason: 'validation-failed', detail: 'invalid task graph', at: TIMESTAMP, eventId: EVENT_ID,
      }],
      causes: {
        ...base.causes,
        [causeId]: { ...base.causes[causeId]!, triggerEventId: EVENT_ID },
      },
    };
    expect(nextStage(exhausted, POLICY)).toMatchObject({
      kind: 'run', action: 'advance-escalation', causeId, level: 'architect',
    });
  });

  it('runs a new task sweep after a corrective Coder implementation supersedes a failed causal sweep', () => {
    const before = v3State({ level: 'coder', bucket: 'oracle', count: 'limit-minus-one', taskStatus: 'active', oracle: 'failed', budgetExhausted: false, checkpoint: false, terminal: false });
    const replacement = EventIdSchema.parse('evt-00000000-0000-4000-8000-000000000002');
    const taskId = before.tasks!.currentTaskId!;
    const task = before.tasks!.records[taskId]!;
    const corrected: WorkItemState = {
      ...before,
      tasks: {
        ...before.tasks!,
        records: {
          ...before.tasks!.records,
          [taskId]: { ...task, implementation: { ...task.implementation!, eventId: replacement }, review: null },
        },
      },
    };
    expect(nextStage(corrected, POLICY)).toMatchObject({ kind: 'run', action: 'task-oracle', taskId });
  });
});

// --- Phase 5 dimensions: checkpoint routing (WORK_ORDER_PHASE5.md item 18) ---
// Group D supplies no routing change (decision "Group D — routing (proof of non-change)"):
// this table exists to pin that guard 6 and guard 7 keep behaving exactly as before across the
// checkpoint shapes Phase 5's producers can now create. A separate golden file and a separate
// generator; the existing three tables and their generators above are untouched.

const PHASE5_CHECKPOINT_SETS = [
  'none',
  'one-open-blocking',
  'two-open-blocking',
  'one-open-non-blocking',
  'one-open-blocking-plus-accepted',
  'one-rejected-blocking',
  'one-auto-approved-blocking',
] as const;
type Phase5CheckpointSet = (typeof PHASE5_CHECKPOINT_SETS)[number];

const PHASE5_STAGES = ['architecture', 'implementation'] as const;
type Phase5Stage = (typeof PHASE5_STAGES)[number];

interface Phase5Row {
  readonly checkpointSet: Phase5CheckpointSet;
  readonly kind: CheckpointKind;
  readonly stage: Phase5Stage;
}

function phase5CheckpointRecord(
  id: CheckpointStateRecord['id'],
  kind: CheckpointKind,
  stage: Stage,
  blocking: boolean,
  status: CheckpointStateRecord['status'],
): CheckpointStateRecord {
  return {
    id,
    kind,
    stage,
    blocking,
    status,
    raisedAt: TIMESTAMP,
    resolvedAt: status === 'open' ? null : TIMESTAMP,
    resolvedBy: status === 'open' ? null : status === 'auto-approved' ? 'auto' : 'human',
  };
}

/**
 * `two-open-blocking` uses serials 9 and 10 specifically to exercise decision 17's lexicographic
 * comparison (`cp-example-10` sorts before `cp-example-9`). Every other set uses serials 1 (and
 * 2, for the accepted companion) — the serial value is otherwise immaterial to guard 6.
 */
function phase5CheckpointsFor(
  set: Phase5CheckpointSet,
  kind: CheckpointKind,
  stage: Stage,
): Readonly<Record<string, CheckpointStateRecord>> {
  switch (set) {
    case 'none':
      return {};
    case 'one-open-blocking': {
      const id = formatCheckpointId(SLUG, 1);
      return { [id]: phase5CheckpointRecord(id, kind, stage, true, 'open') };
    }
    case 'two-open-blocking': {
      const id9 = formatCheckpointId(SLUG, 9);
      const id10 = formatCheckpointId(SLUG, 10);
      return {
        [id9]: phase5CheckpointRecord(id9, kind, stage, true, 'open'),
        [id10]: phase5CheckpointRecord(id10, kind, stage, true, 'open'),
      };
    }
    case 'one-open-non-blocking': {
      const id = formatCheckpointId(SLUG, 1);
      return { [id]: phase5CheckpointRecord(id, kind, stage, false, 'open') };
    }
    case 'one-open-blocking-plus-accepted': {
      const openId = formatCheckpointId(SLUG, 1);
      const acceptedId = formatCheckpointId(SLUG, 2);
      return {
        [openId]: phase5CheckpointRecord(openId, kind, stage, true, 'open'),
        [acceptedId]: phase5CheckpointRecord(acceptedId, kind, stage, true, 'accepted'),
      };
    }
    case 'one-rejected-blocking': {
      const id = formatCheckpointId(SLUG, 1);
      return { [id]: phase5CheckpointRecord(id, kind, stage, true, 'rejected') };
    }
    case 'one-auto-approved-blocking': {
      const id = formatCheckpointId(SLUG, 1);
      return { [id]: phase5CheckpointRecord(id, kind, stage, true, 'auto-approved') };
    }
  }
}

/**
 * Programmatically generates the 70-row cross product
 * `checkpointSet(7) x kind ∈ CHECKPOINT_KINDS(5) x stage ∈ {architecture, implementation}(2)`.
 * Never hand-written, never randomised.
 */
function generatePhase5Rows(): Phase5Row[] {
  const rows: Phase5Row[] = [];
  for (const checkpointSet of PHASE5_CHECKPOINT_SETS) {
    for (const kind of CHECKPOINT_KINDS) {
      for (const stage of PHASE5_STAGES) {
        rows.push({ checkpointSet, kind, stage });
      }
    }
  }
  return rows;
}

function buildPhase5State(row: Phase5Row): WorkItemState {
  const base = buildState({
    stage: row.stage,
    status: 'active',
    budgetExhausted: 'none',
    attempts: 0,
    openBlockingCheckpoint: false,
  });
  return {
    ...base,
    checkpoints: phase5CheckpointsFor(row.checkpointSet, row.kind, row.stage),
  };
}

function phase5DecisionFor(row: Phase5Row): StageDecision {
  return nextStage(buildPhase5State(row), POLICY);
}

function serializePhase5Row(row: Phase5Row): string {
  return canonicalJson({ row, decision: phase5DecisionFor(row) });
}

describe('nextStage: 70-row Phase 5 checkpoint-routing table', () => {
  const rows = generatePhase5Rows();
  const generated = rows.map(serializePhase5Row);
  const golden = JSON.parse(readFileSync(PHASE5_GOLDEN_PATH, 'utf8')) as string[];

  it('generates exactly the 70-row cross product', () => {
    expect(rows).toHaveLength(70);
  });

  it('never throws, and every decision is one of the four StageDecision kinds', () => {
    for (const row of rows) {
      const state = buildPhase5State(row);
      let decision: StageDecision | undefined;
      expect(() => {
        decision = nextStage(state, POLICY);
      }).not.toThrow();
      expect(['run', 'checkpoint', 'park', 'done']).toContain(decision?.kind);
    }
  });

  it('matches the committed Phase 5 golden table (canonicalJson per row)', () => {
    expect(generated).toEqual(golden);
  });

  it('guard 6 is kind-agnostic: every CHECKPOINT_KINDS value blocks identically when open and blocking', () => {
    for (const kind of CHECKPOINT_KINDS) {
      for (const stage of PHASE5_STAGES) {
        const decision = phase5DecisionFor({ checkpointSet: 'one-open-blocking', kind, stage });
        expect(decision).toMatchObject({ kind: 'checkpoint', checkpoint: formatCheckpointId(SLUG, 1) });
      }
    }
  });

  it('a non-blocking open checkpoint never blocks, for every kind', () => {
    for (const kind of CHECKPOINT_KINDS) {
      for (const stage of PHASE5_STAGES) {
        const decision = phase5DecisionFor({ checkpointSet: 'one-open-non-blocking', kind, stage });
        expect(decision.kind).not.toBe('checkpoint');
      }
    }
  });

  it('an accepted checkpoint never blocks; only the still-open one is named', () => {
    for (const kind of CHECKPOINT_KINDS) {
      for (const stage of PHASE5_STAGES) {
        const decision = phase5DecisionFor({ checkpointSet: 'one-open-blocking-plus-accepted', kind, stage });
        expect(decision).toMatchObject({ kind: 'checkpoint', checkpoint: formatCheckpointId(SLUG, 1) });
      }
    }
  });

  it('an auto-approved checkpoint never blocks, however "blocking" its record still reads, for every kind', () => {
    for (const kind of CHECKPOINT_KINDS) {
      for (const stage of PHASE5_STAGES) {
        const decision = phase5DecisionFor({ checkpointSet: 'one-auto-approved-blocking', kind, stage });
        expect(decision.kind).not.toBe('checkpoint');
      }
    }
  });

  // WORK_ORDER_PHASE5.md binding decision 15: a rejected blocking checkpoint does not clear a
  // park, so a naively-resumed item would re-enter the very stage the operator refused. Guard 6
  // only ever looks at `status === 'open'`, and a rejected checkpoint is not open, so it never
  // blocks *here* -- the fix lives one layer up, in the drain's `blocking-checkpoint-rejected`
  // backlog blocker (src/supervisor/backlog.ts), which refuses to resume such an item at all.
  it('a rejected checkpoint never blocks at the routing layer (decision 15; the drain, not nextStage, keeps it parked)', () => {
    for (const kind of CHECKPOINT_KINDS) {
      for (const stage of PHASE5_STAGES) {
        const decision = phase5DecisionFor({ checkpointSet: 'one-rejected-blocking', kind, stage });
        expect(decision.kind).not.toBe('checkpoint');
      }
    }
  });

  // WORK_ORDER_PHASE5.md binding decision 17: checkpoint ids compare as strings, so once an
  // item passes nine checkpoints the "lowest id" guard 6 selects is lexicographic, not
  // numeric -- `cp-example-10` sorts before `cp-example-9`. This is cosmetic (every blocking
  // checkpoint must be resolved regardless of which one is named) and is pinned here, in this
  // golden table, precisely so it cannot be "fixed" silently later without moving this file.
  it('serial 9 vs 10: guard 6 names the lexicographically lowest id (decision 17)', () => {
    for (const kind of CHECKPOINT_KINDS) {
      for (const stage of PHASE5_STAGES) {
        const decision = phase5DecisionFor({ checkpointSet: 'two-open-blocking', kind, stage });
        expect(decision).toMatchObject({ kind: 'checkpoint', checkpoint: formatCheckpointId(SLUG, 10) });
      }
    }
  });
});

// The Phase 1, Phase 2 and Phase 1-nonpark golden files are frozen (binding decision 3: no
// `WorkItemState` field moves, so no existing table moves). These hashes were captured from
// the files as landed by Groups A-C and pin them at the byte level, catching a reformat or a
// silent regeneration that the row-by-row `toEqual` checks above would not: those checks parse
// each file into an array first, so a change that reformats the file without changing any row's
// value would still pass them.
describe('nextStage: the three existing golden tables are byte-identical to their committed contents', () => {
  it('nextStage.table.json', () => {
    expect(sha256Hex(readFileSync(GOLDEN_PATH))).toBe(
      '3d9ef41444183710809921862b11ea74faf08bcd7a5164f576298b32310c01d9',
    );
  });

  it('nextStage.phase2.table.json', () => {
    expect(sha256Hex(readFileSync(PHASE2_GOLDEN_PATH))).toBe(
      '6c960bb92c0856121e437762a7f98380a51a67d088c5435d5ca9de131de21ea8',
    );
  });

  it('nextStage.table.phase1-nonpark.json', () => {
    expect(sha256Hex(readFileSync(PHASE1_NONPARK_PATH))).toBe(
      '3ae01537ede845a69085134b9234e6da3b16321fe8f403bad385522e7d1ce19b',
    );
  });
});
