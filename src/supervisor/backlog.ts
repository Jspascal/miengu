import { z } from 'zod';
import type { ParkReason } from '../core/events.js';
import type { AccountId, WorkItemId } from '../core/ids.js';

// Mirrors src/core/clock.ts's IsoTimestampSchema brand exactly (same brand literal) without
// importing clock.ts, which the determinism zone forbids for this file.
type IsoTimestamp = z.infer<z.ZodBranded<z.ZodString, 'IsoTimestamp'>>;

export const BACKLOG_BLOCKERS = [
  'not-parked',
  'not-resumable',
  'blocking-checkpoint-open',
  'blocking-checkpoint-rejected',
  'quota-window-open',
  'account-blocked-this-run',
  'budget-cap',
  'attempts-exhausted',
  'lock-held',
  'corrupt',
] as const;
export type BacklogBlocker = (typeof BACKLOG_BLOCKERS)[number];

export interface BacklogCandidate {
  readonly itemId: WorkItemId;
  readonly status: 'active' | 'parked' | 'completed' | 'failed';
  readonly parkReason: ParkReason | null;
  readonly parkSince: IsoTimestamp | null;
  readonly resumable: boolean;
  readonly parkAccount: AccountId | null;
  /** Whether the caller's clock says the declared window has passed, or none was declared. */
  readonly quotaWindowCleared: boolean;
  readonly openBlockingCheckpoints: number;
  readonly rejectedBlockingCheckpoints: number;
  /** `policy.stageAccounts[state.stage]` — the account this item's next stage will need. */
  readonly nextStageAccount: AccountId | null;
}

export interface BacklogEntry {
  readonly itemId: WorkItemId;
  readonly ready: boolean;
  readonly blocker: BacklogBlocker | null;
  readonly parkSince: IsoTimestamp | null;
  readonly parkReason: ParkReason | null;
  readonly nextStageAccount: AccountId | null;
}

function classify(c: BacklogCandidate): BacklogBlocker | null {
  if (c.status !== 'parked') {
    return 'not-parked';
  }
  // "any, with resumable: false" (decision 13's last row) is an absolute veto that overrides
  // every reason-specific clearance rule below it.
  if (!c.resumable) {
    return 'not-resumable';
  }
  // A rejected blocking checkpoint is never cleared (decision 15) and takes precedence over a
  // merely-open one: reporting "open" when the true blocker is a human's rejection would tell
  // the operator to wait for something that is never going to resolve itself.
  if (c.rejectedBlockingCheckpoints > 0) {
    return 'blocking-checkpoint-rejected';
  }
  if (c.openBlockingCheckpoints > 0) {
    return 'blocking-checkpoint-open';
  }
  switch (c.parkReason) {
    case 'provider-quota':
      return c.quotaWindowCleared ? null : 'quota-window-open';
    case 'awaiting-human':
      // Every blocking checkpoint is resolved and none was rejected, or this candidate would
      // have returned above.
      return null;
    case 'executor-unavailable':
    case 'operator-abort':
      return null;
    case 'budget-exhausted':
      return 'budget-cap';
    case 'attempts-exhausted':
      return 'attempts-exhausted';
    case null:
      return null;
  }
}

/** Pure. Ascending by `(parkSince ?? '', itemId)`. Classifies every candidate; the caller
 *  filters on `ready`. Blocker precedence follows binding decision 13's table top to bottom. */
export function planBacklog(candidates: readonly BacklogCandidate[]): readonly BacklogEntry[] {
  const entries = candidates.map((c) => {
    const blocker = classify(c);
    return {
      itemId: c.itemId,
      ready: blocker === null,
      blocker,
      parkSince: c.parkSince,
      parkReason: c.parkReason,
      nextStageAccount: c.nextStageAccount,
    } satisfies BacklogEntry;
  });
  return entries.slice().sort((a, b) => {
    const aSince = a.parkSince ?? '';
    const bSince = b.parkSince ?? '';
    if (aSince < bSince) return -1;
    if (aSince > bSince) return 1;
    if (a.itemId < b.itemId) return -1;
    if (a.itemId > b.itemId) return 1;
    return 0;
  });
}

/** Binding decision 14's run-scoped gate, re-checked immediately before each item runs. */
export function blockedByAccount(
  entry: BacklogEntry,
  blockedAccounts: ReadonlySet<AccountId>,
): boolean {
  return entry.nextStageAccount !== null && blockedAccounts.has(entry.nextStageAccount);
}
