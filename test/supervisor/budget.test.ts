import { describe, it, expect } from 'vitest';
import {
  EMPTY_ACCOUNT_LEDGER,
  EMPTY_BUDGET_STATE,
  EMPTY_LEDGER,
  accountLedger,
  accumulate,
  checkLimits,
  foldConsumed,
  foldExhausted,
  fromTelemetry,
  isAccountExhausted,
} from '../../src/supervisor/budget.js';
import type { BudgetDelta, BudgetLimits } from '../../src/supervisor/budget.js';
import { IsoTimestampSchema } from '../../src/core/clock.js';
import { AccountIdSchema } from '../../src/core/ids.js';
import type { BudgetExhaustion, BudgetLedger } from '../../src/state/workitem.js';

const ACCOUNT_A = AccountIdSchema.parse('claude-personal');
const ACCOUNT_B = AccountIdSchema.parse('codex-personal');
const AT = IsoTimestampSchema.parse('2024-01-01T00:00:00.000Z');

describe('accumulate', () => {
  it('always adds wallSeconds', () => {
    const next = accumulate(EMPTY_LEDGER, { wallSeconds: 5, turns: null, usd: null });
    expect(next.wallSeconds).toBe(5);
  });

  it('adds turns and usd when the delta is non-null', () => {
    const first = accumulate(EMPTY_LEDGER, { wallSeconds: 10, turns: 3, usd: 1.5 });
    expect(first).toEqual({
      wallSeconds: 10,
      turns: 3,
      usd: 1.5,
      partial: { turns: false, usd: false },
    });
    const second = accumulate(first, { wallSeconds: 10, turns: 2, usd: 0.5 });
    expect(second).toEqual({
      wallSeconds: 20,
      turns: 5,
      usd: 2,
      partial: { turns: false, usd: false },
    });
  });

  it('leaves a dimension unchanged and marks it partial when the delta is null', () => {
    const next = accumulate(EMPTY_LEDGER, { wallSeconds: 5, turns: null, usd: null });
    expect(next.turns).toBe(EMPTY_LEDGER.turns);
    expect(next.usd).toBe(EMPTY_LEDGER.usd);
    expect(next.partial).toEqual({ turns: true, usd: true });
  });

  it('partial is sticky: once true, a later known delta does not clear it', () => {
    const partial = accumulate(EMPTY_LEDGER, { wallSeconds: 1, turns: null, usd: null });
    const next = accumulate(partial, { wallSeconds: 1, turns: 4, usd: 2 });
    expect(next.turns).toBe(4);
    expect(next.usd).toBe(2);
    expect(next.partial).toEqual({ turns: true, usd: true });
  });
});

describe('checkLimits', () => {
  const table: Array<{
    label: string;
    ledger: BudgetLedger;
    limits: BudgetLimits;
    expected: ReturnType<typeof checkLimits>;
  }> = [
    // turns: known/null x under/at/over
    {
      label: 'turns known, under limit',
      ledger: { ...EMPTY_LEDGER, turns: 2 },
      limits: { maxTurns: 3, maxWallSeconds: null, maxUsd: null },
      expected: { ok: true },
    },
    {
      label: 'turns known, at limit — not a violation',
      ledger: { ...EMPTY_LEDGER, turns: 3 },
      limits: { maxTurns: 3, maxWallSeconds: null, maxUsd: null },
      expected: { ok: true },
    },
    {
      label: 'turns known, over limit',
      ledger: { ...EMPTY_LEDGER, turns: 4 },
      limits: { maxTurns: 3, maxWallSeconds: null, maxUsd: null },
      expected: { ok: false, limitKind: 'turns', declaredLimit: 3, observed: 4 },
    },
    {
      label: 'turns unknown (null), limit declared — no violation on this dimension',
      ledger: { ...EMPTY_LEDGER, turns: null, partial: { turns: true, usd: false } },
      limits: { maxTurns: 3, maxWallSeconds: null, maxUsd: null },
      expected: { ok: true },
    },
    {
      label: 'turns known, limit null (unlimited)',
      ledger: { ...EMPTY_LEDGER, turns: 1000 },
      limits: { maxTurns: null, maxWallSeconds: null, maxUsd: null },
      expected: { ok: true },
    },
    // wall: always known x under/at/over
    {
      label: 'wall under limit',
      ledger: { ...EMPTY_LEDGER, wallSeconds: 10 },
      limits: { maxTurns: null, maxWallSeconds: 20, maxUsd: null },
      expected: { ok: true },
    },
    {
      label: 'wall at limit — not a violation',
      ledger: { ...EMPTY_LEDGER, wallSeconds: 20 },
      limits: { maxTurns: null, maxWallSeconds: 20, maxUsd: null },
      expected: { ok: true },
    },
    {
      label: 'wall over limit',
      ledger: { ...EMPTY_LEDGER, wallSeconds: 21 },
      limits: { maxTurns: null, maxWallSeconds: 20, maxUsd: null },
      expected: { ok: false, limitKind: 'wall', declaredLimit: 20, observed: 21 },
    },
    {
      label: 'wall limit null (unlimited)',
      ledger: { ...EMPTY_LEDGER, wallSeconds: 999999 },
      limits: { maxTurns: null, maxWallSeconds: null, maxUsd: null },
      expected: { ok: true },
    },
    // usd: known/null x under/at/over
    {
      label: 'usd known, under limit',
      ledger: { ...EMPTY_LEDGER, usd: 5 },
      limits: { maxTurns: null, maxWallSeconds: null, maxUsd: 10 },
      expected: { ok: true },
    },
    {
      label: 'usd known, at limit — not a violation',
      ledger: { ...EMPTY_LEDGER, usd: 10 },
      limits: { maxTurns: null, maxWallSeconds: null, maxUsd: 10 },
      expected: { ok: true },
    },
    {
      label: 'usd known, over limit',
      ledger: { ...EMPTY_LEDGER, usd: 11 },
      limits: { maxTurns: null, maxWallSeconds: null, maxUsd: 10 },
      expected: { ok: false, limitKind: 'usd', declaredLimit: 10, observed: 11 },
    },
    {
      label: 'usd unknown (null), limit declared — no violation on this dimension',
      ledger: { ...EMPTY_LEDGER, usd: null, partial: { turns: false, usd: true } },
      limits: { maxTurns: null, maxWallSeconds: null, maxUsd: 10 },
      expected: { ok: true },
    },
    {
      label: 'usd known, limit null (unlimited)',
      ledger: { ...EMPTY_LEDGER, usd: 999 },
      limits: { maxTurns: null, maxWallSeconds: null, maxUsd: null },
      expected: { ok: true },
    },
  ];

  for (const row of table) {
    it(row.label, () => {
      expect(checkLimits(row.ledger, row.limits)).toEqual(row.expected);
    });
  }

  it('first violated dimension wins in the order turns, wall, usd', () => {
    const ledger: BudgetLedger = {
      wallSeconds: 100,
      turns: 10,
      usd: 100,
      partial: { turns: false, usd: false },
    };
    const limits: BudgetLimits = { maxTurns: 5, maxWallSeconds: 5, maxUsd: 5 };
    expect(checkLimits(ledger, limits)).toEqual({
      ok: false,
      limitKind: 'turns',
      declaredLimit: 5,
      observed: 10,
    });
  });

  it('partial never suppresses a violation on a dimension it does not concern', () => {
    const ledger: BudgetLedger = {
      wallSeconds: 100,
      turns: null,
      usd: 100,
      partial: { turns: true, usd: false },
    };
    const limits: BudgetLimits = { maxTurns: 5, maxWallSeconds: null, maxUsd: 5 };
    expect(checkLimits(ledger, limits)).toEqual({
      ok: false,
      limitKind: 'usd',
      declaredLimit: 5,
      observed: 100,
    });
  });
});

describe('fromTelemetry', () => {
  it('maps telemetry and the supplied usd into a delta', () => {
    const delta: BudgetDelta = fromTelemetry(
      { turns: 4, inputTokens: 100, outputTokens: 50, wallSeconds: 12.5 },
      0.42,
    );
    expect(delta).toEqual({ wallSeconds: 12.5, turns: 4, usd: 0.42 });
  });

  it('preserves null turns and usd', () => {
    const delta = fromTelemetry(
      { turns: null, inputTokens: null, outputTokens: null, wallSeconds: 3 },
      null,
    );
    expect(delta).toEqual({ wallSeconds: 3, turns: null, usd: null });
  });
});

describe('foldConsumed', () => {
  it('updates both accounts[a] and item from one delta', () => {
    const delta: BudgetDelta = { wallSeconds: 5, turns: 2, usd: 1 };
    const next = foldConsumed(EMPTY_BUDGET_STATE, ACCOUNT_A, delta);
    expect(next.accounts[ACCOUNT_A]?.consumed).toEqual(accumulate(EMPTY_LEDGER, delta));
    expect(next.item).toEqual(accumulate(EMPTY_LEDGER, delta));
  });

  it('two accounts accumulate independently', () => {
    const deltaA: BudgetDelta = { wallSeconds: 5, turns: 2, usd: 1 };
    const deltaB: BudgetDelta = { wallSeconds: 3, turns: 1, usd: 0.5 };
    let state = foldConsumed(EMPTY_BUDGET_STATE, ACCOUNT_A, deltaA);
    state = foldConsumed(state, ACCOUNT_B, deltaB);
    expect(state.accounts[ACCOUNT_A]?.consumed).toEqual(accumulate(EMPTY_LEDGER, deltaA));
    expect(state.accounts[ACCOUNT_B]?.consumed).toEqual(accumulate(EMPTY_LEDGER, deltaB));
    expect(state.item).toEqual(accumulate(accumulate(EMPTY_LEDGER, deltaA), deltaB));
  });

  it('does not derive item by summing accounts — it is its own fold', () => {
    const delta: BudgetDelta = { wallSeconds: 1, turns: null, usd: null };
    const state = foldConsumed(EMPTY_BUDGET_STATE, ACCOUNT_A, delta);
    expect(state.itemExhausted).toBeNull();
    expect(state.item.partial).toEqual({ turns: true, usd: true });
  });
});

describe('foldExhausted', () => {
  const exhaustion: BudgetExhaustion = {
    scope: 'item',
    limitKind: 'provider-quota',
    at: AT,
    resetsAt: null,
    detail: 'waiting on claude-personal window',
  };

  it('account === null sets itemExhausted and leaves accounts untouched', () => {
    const withAccount = foldConsumed(EMPTY_BUDGET_STATE, ACCOUNT_A, {
      wallSeconds: 1,
      turns: 1,
      usd: null,
    });
    const next = foldExhausted(withAccount, null, exhaustion);
    expect(next.itemExhausted).toEqual(exhaustion);
    expect(next.accounts).toEqual(withAccount.accounts);
  });

  it('a non-null account sets accounts[account].exhausted, not itemExhausted', () => {
    const next = foldExhausted(EMPTY_BUDGET_STATE, ACCOUNT_A, exhaustion);
    expect(next.accounts[ACCOUNT_A]?.exhausted).toEqual(exhaustion);
    expect(next.itemExhausted).toBeNull();
  });
});

describe('accountLedger', () => {
  it('returns EMPTY_ACCOUNT_LEDGER for an unknown account and does not mint a key', () => {
    const ledger = accountLedger(EMPTY_BUDGET_STATE, ACCOUNT_A);
    expect(ledger).toEqual(EMPTY_ACCOUNT_LEDGER);
    expect(Object.keys(EMPTY_BUDGET_STATE.accounts)).toEqual([]);
  });
});

describe('isAccountExhausted', () => {
  it('is false for account === null', () => {
    expect(isAccountExhausted(EMPTY_BUDGET_STATE, null)).toBe(false);
  });

  it('is false for an account with no recorded exhaustion', () => {
    expect(isAccountExhausted(EMPTY_BUDGET_STATE, ACCOUNT_A)).toBe(false);
  });

  it('is true once foldExhausted has set that account', () => {
    const exhaustion: BudgetExhaustion = {
      scope: 'task',
      limitKind: 'turns',
      at: AT,
      resetsAt: null,
      detail: 'x',
    };
    const next = foldExhausted(EMPTY_BUDGET_STATE, ACCOUNT_A, exhaustion);
    expect(isAccountExhausted(next, ACCOUNT_A)).toBe(true);
  });
});
