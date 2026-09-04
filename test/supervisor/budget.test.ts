import { describe, it, expect } from 'vitest';
import {
  EMPTY_LEDGER,
  accumulate,
  checkLimits,
  fromTelemetry,
} from '../../src/supervisor/budget.js';
import type { BudgetDelta, BudgetLimits } from '../../src/supervisor/budget.js';
import type { BudgetLedger } from '../../src/state/workitem.js';

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
