import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../src/core/canonical.js';
import { IsoTimestampSchema } from '../../src/core/clock.js';
import { STAGES } from '../../src/core/events.js';
import type { Stage } from '../../src/core/events.js';
import {
  CheckpointIdSchema,
  EventIdSchema,
  SlugSchema,
  WorkItemIdSchema,
} from '../../src/core/ids.js';
import { limitForStage, nextStage } from '../../src/supervisor/nextStage.js';
import type { StageDecision, StagePolicy } from '../../src/supervisor/nextStage.js';
import { EMPTY_LEDGER } from '../../src/supervisor/budget.js';
import { PROJECTION_VERSION, emptyAttempts } from '../../src/state/workitem.js';
import type { WorkItemState } from '../../src/state/workitem.js';

const GOLDEN_PATH = fileURLToPath(new URL('../golden/nextStage.table.json', import.meta.url));

const TIMESTAMP = IsoTimestampSchema.parse('2024-01-01T00:00:00.000Z');
const ITEM_ID = WorkItemIdSchema.parse('wi-example-abc123');
const SLUG = SlugSchema.parse('example');
const EVENT_ID = EventIdSchema.parse('evt-00000000-0000-4000-8000-000000000000');
const CHECKPOINT_ID = CheckpointIdSchema.parse('cp-example-1');

const POLICY: StagePolicy = {
  limits: { kOracle: 3, kTest: 3, kReview: 2, maxAttemptsPerStage: 3 },
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
        ? { reason: 'awaiting-human', detail: 'test-park', since: TIMESTAMP, resumable: true }
        : null,
    budget: {
      consumed: EMPTY_LEDGER,
      exhausted:
        row.budgetExhausted === 'none'
          ? null
          : {
              scope: 'task',
              limitKind: row.budgetExhausted === 'provider-quota-caused' ? 'provider-quota' : 'turns',
              at: TIMESTAMP,
            },
    },
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
    const serialized = rows.map(serializeRow);
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8');
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as string[];
    expect(serialized).toEqual(golden);
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
    expect(decision).toEqual({ kind: 'park', reason: 'awaiting-human', detail: 'test-park' });
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
