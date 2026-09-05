import type { AccountId } from '../core/ids.js';
import type { AccountLedger, BudgetExhaustion, BudgetLedger, BudgetState } from '../state/workitem.js';

export const EMPTY_LEDGER: BudgetLedger = {
  wallSeconds: 0,
  turns: 0,
  usd: 0,
  partial: { turns: false, usd: false },
};

export const EMPTY_ACCOUNT_LEDGER: AccountLedger = {
  consumed: EMPTY_LEDGER,
  exhausted: null,
};

export const EMPTY_BUDGET_STATE: BudgetState = {
  accounts: {},
  item: EMPTY_LEDGER,
  itemExhausted: null,
};

export interface BudgetDelta {
  wallSeconds: number;
  turns: number | null;
  usd: number | null;
}

/**
 * `wallSeconds` always adds. `turns`/`usd` add when the delta is non-null; when a delta
 * dimension is `null` the total is unchanged and `partial[dim]` becomes `true` permanently.
 */
export function accumulate(prev: BudgetLedger, delta: BudgetDelta): BudgetLedger {
  return {
    wallSeconds: prev.wallSeconds + delta.wallSeconds,
    turns: delta.turns === null ? prev.turns : (prev.turns ?? 0) + delta.turns,
    usd: delta.usd === null ? prev.usd : (prev.usd ?? 0) + delta.usd,
    partial: {
      turns: prev.partial.turns || delta.turns === null,
      usd: prev.partial.usd || delta.usd === null,
    },
  };
}

export interface BudgetLimits {
  maxTurns: number | null;
  maxWallSeconds: number | null;
  maxUsd: number | null;
}

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; limitKind: 'turns' | 'wall' | 'usd'; declaredLimit: number; observed: number };

/**
 * Enforces on the KNOWN total; `null` limit = unlimited; first violated dimension in the
 * order `turns`, `wall`, `usd`; at limit is not a violation, over is. `partial` never
 * suppresses exhaustion — it only means the true figure may be higher, and that is recorded.
 */
export function checkLimits(l: BudgetLedger, lim: BudgetLimits): BudgetVerdict {
  if (lim.maxTurns !== null && l.turns !== null && l.turns > lim.maxTurns) {
    return { ok: false, limitKind: 'turns', declaredLimit: lim.maxTurns, observed: l.turns };
  }
  if (lim.maxWallSeconds !== null && l.wallSeconds > lim.maxWallSeconds) {
    return {
      ok: false,
      limitKind: 'wall',
      declaredLimit: lim.maxWallSeconds,
      observed: l.wallSeconds,
    };
  }
  if (lim.maxUsd !== null && l.usd !== null && l.usd > lim.maxUsd) {
    return { ok: false, limitKind: 'usd', declaredLimit: lim.maxUsd, observed: l.usd };
  }
  return { ok: true };
}

// Mirrors src/executors/executor.ts's ExecutorTelemetry contract (that module is built in
// a later item). Kept private and structural so this file does not need to import it.
interface ExecutorTelemetry {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  wallSeconds: number;
}

export function fromTelemetry(t: ExecutorTelemetry, usd: number | null): BudgetDelta {
  return {
    wallSeconds: t.wallSeconds,
    turns: t.turns,
    usd,
  };
}

/**
 * Applies one delta to BOTH `accounts[account]` and `item` — the two-accumulator rule
 * (binding decision 21). Never derives `item` by summing `accounts`.
 */
export function foldConsumed(s: BudgetState, account: AccountId, d: BudgetDelta): BudgetState {
  const existing = s.accounts[account] ?? EMPTY_ACCOUNT_LEDGER;
  return {
    accounts: {
      ...s.accounts,
      [account]: { ...existing, consumed: accumulate(existing.consumed, d) },
    },
    item: accumulate(s.item, d),
    itemExhausted: s.itemExhausted,
  };
}

/** `account === null` targets `itemExhausted`; otherwise `accounts[account].exhausted`. */
export function foldExhausted(
  s: BudgetState,
  account: AccountId | null,
  e: BudgetExhaustion | null,
): BudgetState {
  if (account === null) {
    return { ...s, itemExhausted: e };
  }
  const existing = s.accounts[account] ?? EMPTY_ACCOUNT_LEDGER;
  return {
    accounts: { ...s.accounts, [account]: { ...existing, exhausted: e } },
    item: s.item,
    itemExhausted: s.itemExhausted,
  };
}

/** An account with no recorded spend is not exhausted. Never throws, never mints a key. */
export function accountLedger(s: BudgetState, account: AccountId): AccountLedger {
  return s.accounts[account] ?? EMPTY_ACCOUNT_LEDGER;
}

export function isAccountExhausted(s: BudgetState, account: AccountId | null): boolean {
  if (account === null) {
    return false;
  }
  return accountLedger(s, account).exhausted !== null;
}
