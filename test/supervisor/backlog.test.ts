import { describe, it, expect } from 'vitest';
import { AccountIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import { IsoTimestampSchema } from '../../src/core/clock.js';
import type { BacklogCandidate } from '../../src/supervisor/backlog.js';
import { blockedByAccount, planBacklog } from '../../src/supervisor/backlog.js';

const ITEM_A = WorkItemIdSchema.parse('wi-example-aaaaaa');
const ITEM_B = WorkItemIdSchema.parse('wi-example-bbbbbb');
const ACCOUNT = AccountIdSchema.parse('claude-personal');
const T1 = IsoTimestampSchema.parse('2024-01-01T00:00:00.000Z');
const T2 = IsoTimestampSchema.parse('2024-01-02T00:00:00.000Z');

function candidate(overrides: Partial<BacklogCandidate> = {}): BacklogCandidate {
  return {
    itemId: ITEM_A,
    status: 'parked',
    parkReason: 'provider-quota',
    parkSince: T1,
    resumable: true,
    parkAccount: ACCOUNT,
    quotaWindowCleared: true,
    openBlockingCheckpoints: 0,
    rejectedBlockingCheckpoints: 0,
    nextStageAccount: null,
    ...overrides,
  };
}

describe('planBacklog — one row per binding decision 13 clearance rule', () => {
  it('provider-quota clears when the quota window has passed', () => {
    const [entry] = planBacklog([candidate({ parkReason: 'provider-quota', quotaWindowCleared: true })]);
    expect(entry).toMatchObject({ ready: true, blocker: null });
  });

  it('provider-quota does not clear while the window is still open', () => {
    const [entry] = planBacklog([candidate({ parkReason: 'provider-quota', quotaWindowCleared: false })]);
    expect(entry).toMatchObject({ ready: false, blocker: 'quota-window-open' });
  });

  it('awaiting-human clears when every blocking checkpoint is resolved and none was rejected', () => {
    const [entry] = planBacklog([
      candidate({ parkReason: 'awaiting-human', openBlockingCheckpoints: 0, rejectedBlockingCheckpoints: 0 }),
    ]);
    expect(entry).toMatchObject({ ready: true, blocker: null });
  });

  it('awaiting-human does not clear while a blocking checkpoint is still open', () => {
    const [entry] = planBacklog([
      candidate({ parkReason: 'awaiting-human', openBlockingCheckpoints: 1, rejectedBlockingCheckpoints: 0 }),
    ]);
    expect(entry).toMatchObject({ ready: false, blocker: 'blocking-checkpoint-open' });
  });

  it('awaiting-human does not clear when a blocking checkpoint was rejected', () => {
    const [entry] = planBacklog([
      candidate({ parkReason: 'awaiting-human', openBlockingCheckpoints: 0, rejectedBlockingCheckpoints: 1 }),
    ]);
    expect(entry).toMatchObject({ ready: false, blocker: 'blocking-checkpoint-rejected' });
  });

  it('executor-unavailable always clears', () => {
    const [entry] = planBacklog([candidate({ parkReason: 'executor-unavailable' })]);
    expect(entry).toMatchObject({ ready: true, blocker: null });
  });

  it('operator-abort always clears', () => {
    const [entry] = planBacklog([candidate({ parkReason: 'operator-abort' })]);
    expect(entry).toMatchObject({ ready: true, blocker: null });
  });

  it('budget-exhausted never clears', () => {
    const [entry] = planBacklog([candidate({ parkReason: 'budget-exhausted' })]);
    expect(entry).toMatchObject({ ready: false, blocker: 'budget-cap' });
  });

  it('attempts-exhausted never clears', () => {
    const [entry] = planBacklog([candidate({ parkReason: 'attempts-exhausted' })]);
    expect(entry).toMatchObject({ ready: false, blocker: 'attempts-exhausted' });
  });

  it('any candidate with resumable: false never clears, whatever its reason', () => {
    const [entry] = planBacklog([candidate({ parkReason: 'operator-abort', resumable: false })]);
    expect(entry).toMatchObject({ ready: false, blocker: 'not-resumable' });
  });

  it('a non-parked candidate is blocked by not-parked', () => {
    const [entry] = planBacklog([candidate({ status: 'active' })]);
    expect(entry).toMatchObject({ ready: false, blocker: 'not-parked' });
  });
});

describe('planBacklog — blocker precedence', () => {
  it('not-resumable beats every other blocker', () => {
    const [entry] = planBacklog([
      candidate({ resumable: false, rejectedBlockingCheckpoints: 1, openBlockingCheckpoints: 1, parkReason: 'budget-exhausted' }),
    ]);
    expect(entry.blocker).toBe('not-resumable');
  });

  it('blocking-checkpoint-rejected beats blocking-checkpoint-open: never fires spuriously as open', () => {
    const [entry] = planBacklog([
      candidate({ parkReason: 'awaiting-human', openBlockingCheckpoints: 1, rejectedBlockingCheckpoints: 1 }),
    ]);
    expect(entry.blocker).toBe('blocking-checkpoint-rejected');
  });
});

describe('planBacklog — ordering', () => {
  it('is ascending by (parkSince, itemId), with a null parkSince sorting first', () => {
    const entries = planBacklog([
      candidate({ itemId: ITEM_B, parkSince: T2 }),
      candidate({ itemId: ITEM_A, parkSince: null }),
      candidate({ itemId: ITEM_A, parkSince: T1 }),
    ]);
    expect(entries.map((e) => [e.parkSince, e.itemId])).toEqual([
      [null, ITEM_A],
      [T1, ITEM_A],
      [T2, ITEM_B],
    ]);
  });
});

describe('blockedByAccount', () => {
  it('is always false when nextStageAccount is null', () => {
    const [entry] = planBacklog([candidate({ nextStageAccount: null })]);
    expect(blockedByAccount(entry, new Set([ACCOUNT]))).toBe(false);
  });

  it('is true when the entry needs a blocked account', () => {
    const [entry] = planBacklog([candidate({ nextStageAccount: ACCOUNT })]);
    expect(blockedByAccount(entry, new Set([ACCOUNT]))).toBe(true);
  });

  it('is false when the entry needs an account not in the blocked set', () => {
    const other = AccountIdSchema.parse('codex-personal');
    const [entry] = planBacklog([candidate({ nextStageAccount: other })]);
    expect(blockedByAccount(entry, new Set([ACCOUNT]))).toBe(false);
  });
});
