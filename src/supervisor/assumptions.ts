import type { MienguEvent } from '../core/events.js';
import type { AssumptionId, CheckpointId } from '../core/ids.js';

export interface AssumptionFact {
  readonly id: AssumptionId;
  readonly affects: readonly string[];
  readonly depth: number;
  readonly resolved: boolean;
  /** The `seq` of the `AssumptionRecorded` event, for well-founded ordering. */
  readonly seq: number;
  /** The `assumption-gate` checkpoint that gates it, if one has been raised. */
  readonly gateCheckpointId: CheckpointId | null;
}

/** Explicit IDs in both historical escalation summaries and assumption-gate summaries. */
export function checkpointAssumptions(
  event: Extract<MienguEvent, { type: 'CheckpointRaised' }>,
  open: readonly AssumptionFact[],
): readonly AssumptionId[] {
  const named = new Set(event.data.summary.match(/assumption-[a-z0-9-]+-\d+/g) ?? []);
  if (event.data.kind === 'escalation' && named.size === 0) return [];
  if (event.data.kind !== 'assumption-gate' && event.data.kind !== 'escalation') return [];
  return open.filter((fact) => !fact.resolved && (named.size === 0 || named.has(fact.id))).map((fact) => fact.id);
}

/** One left-to-right fold over `events` in seq order. Pure, total, allocation-bounded.
 *
 *  1. `AssumptionRecorded` -> append a fact with `resolved: false`, `gateCheckpointId: null`.
 *  2. `CheckpointRaised{kind:'assumption-gate'}` -> record `gated[checkpoint] = ids of every
 *     currently unresolved fact`, and set each of their `gateCheckpointId` if still null.
 *  3. `CheckpointDecided{decision:'accept'}` on a `checkpoint` present in `gated` -> mark
 *     every id in `gated[checkpoint]` resolved.
 *  4. `CheckpointDecided{decision:'reject'}` and `AutoApproved` -> no effect on resolution. */
export function assumptionFacts(events: readonly MienguEvent[]): readonly AssumptionFact[] {
  const facts: AssumptionFact[] = [];
  const byId = new Map<AssumptionId, number>();
  const gated = new Map<CheckpointId, readonly AssumptionId[]>();

  for (const event of events) {
    if (event.type === 'AssumptionRecorded') {
      const index = facts.length;
      facts.push({
        id: event.data.id,
        affects: event.data.affects,
        depth: event.data.depth,
        resolved: false,
        seq: event.seq,
        gateCheckpointId: null,
      });
      byId.set(event.data.id, index);
      continue;
    }
    if (event.type === 'HumanAnswerRecorded') {
      const index = byId.get(event.data.assumption_id);
      const fact = index === undefined ? undefined : facts[index];
      if (index !== undefined && fact !== undefined) facts[index] = { ...fact, resolved: true };
      continue;
    }
    if (event.type === 'CheckpointRaised') {
      const unresolvedIds = checkpointAssumptions(event, facts);
      gated.set(event.data.checkpoint, unresolvedIds);
      for (const id of unresolvedIds) {
        const index = byId.get(id);
        if (index === undefined) continue;
        const fact = facts[index];
        if (fact === undefined || fact.gateCheckpointId !== null) continue;
        facts[index] = { ...fact, gateCheckpointId: event.data.checkpoint };
      }
      continue;
    }
    if (event.type === 'CheckpointDecided' && event.data.decision === 'accept') {
      const gatedIds = gated.get(event.data.checkpoint);
      if (gatedIds === undefined) continue;
      for (const id of gatedIds) {
        const index = byId.get(id);
        if (index === undefined) continue;
        const fact = facts[index];
        if (fact === undefined) continue;
        facts[index] = { ...fact, resolved: true };
      }
      continue;
    }
    // CheckpointDecided{decision:'reject'} and AutoApproved have no effect on resolution.
  }

  return facts;
}

/** Unresolved facts, ascending by seq. */
export function openAssumptions(events: readonly MienguEvent[]): readonly AssumptionFact[] {
  return assumptionFacts(events)
    .filter((f) => !f.resolved)
    .slice()
    .sort((a, b) => a.seq - b.seq);
}

/** Binding decision 9's recurrence. `open` must be ascending by seq.
 *
 *  ```
 *  base(a)  = { b : b in open, affects(b) intersects affects(a) }
 *  depth(a) = 0                              if base(a) is empty
 *           = 1 + max{ depth(b) : b in base(a) }   otherwise
 *  ``` */
export function assumptionDepth(
  affects: readonly string[],
  open: readonly AssumptionFact[],
): number {
  const affectsSet = new Set(affects);
  let maxBaseDepth = -1;
  for (const b of open) {
    if (b.affects.some((a) => affectsSet.has(a))) {
      if (b.depth > maxBaseDepth) {
        maxBaseDepth = b.depth;
      }
    }
  }
  return maxBaseDepth === -1 ? 0 : 1 + maxBaseDepth;
}

export function escalates(depth: number, maxStackDepth: number): boolean {
  return depth >= maxStackDepth;
}
