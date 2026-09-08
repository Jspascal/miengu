import type { EventId } from '../core/ids.js';
import type { ProvenanceTier } from '../core/provenance.js';
import { PROVENANCE_TIERS } from '../core/provenance.js';
import type { Claim, ClaimSet } from './records.js';
import { activeClaims } from './records.js';

/**
 * §3: one entry per distinct tier a group of claims actually carries. `sourceEventId` is
 * `null` here because every function below aggregates claims that may originate from many
 * different `StageCompleted` events (a wiki-sourced material is a cross-artifact view, not
 * a single artifact's section) — decision 13's "filled wherever the origin event is known"
 * has no single known origin event for an aggregate, so it is honestly `null` rather than
 * an arbitrarily chosen one of many.
 */
export interface TieredBody {
  readonly body: string;
  readonly tier: ProvenanceTier;
  readonly sourceEventId: EventId | null;
}

function defaultCompare(a: string, b: string): number {
  // Array.prototype.sort's default comparator, UTF-16 code units (decision 3): the
  // ICU-version-dependent locale-aware string compare method is forbidden in this zone.
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Groups claims by tier, each group sorted by claim id (§3). */
function groupByTier(claims: readonly Claim[]): Map<ProvenanceTier, Claim[]> {
  const byTier = new Map<ProvenanceTier, Claim[]>();
  for (const claim of claims) {
    const group = byTier.get(claim.tier);
    if (group === undefined) {
      byTier.set(claim.tier, [claim]);
    } else {
      group.push(claim);
    }
  }
  for (const group of byTier.values()) {
    group.sort((a, b) => defaultCompare(a.id, b.id));
  }
  return byTier;
}

function entry(tier: ProvenanceTier, lines: readonly string[]): TieredBody {
  return { body: lines.join('\n'), tier, sourceEventId: null };
}

/** T0→T3, skipping any tier no claim in the group carries. */
function bodiesByTier(
  byTier: Map<ProvenanceTier, Claim[]>,
  render: (claims: readonly Claim[]) => readonly string[],
): readonly TieredBody[] {
  const out: TieredBody[] = [];
  for (const tier of PROVENANCE_TIERS) {
    const group = byTier.get(tier);
    if (group === undefined || group.length === 0) {
      continue;
    }
    out.push(entry(tier, render(group)));
  }
  return out;
}

/**
 * Component ids and one-line responsibilities only (§3) — never paths, never interface
 * signatures, never decisions. Reads `activeClaims` only (decision 7): a superseded,
 * invalidated or quarantined component claim never reaches this material.
 */
export function wikiIndexBodies(set: ClaimSet): readonly TieredBody[] {
  const byTier = groupByTier(activeClaims(set, 'component'));
  return bodiesByTier(byTier, (claims) => claims.map((c) => `${c.subject}: ${c.statement}`));
}

/**
 * The component and interface claims minted by architecture: each entry lists a component's
 * id and responsibility, and an interface's id, the component it belongs to (`trace.componentIds`,
 * the only structural link a claim carries — `depends_on` edges and `signature` text are not
 * part of the Claim contract in §2 and are never fabricated here), and its behaviour.
 */
export function systemSkeletonBodies(set: ClaimSet): readonly TieredBody[] {
  const combined = [...activeClaims(set, 'component'), ...activeClaims(set, 'interface')];
  const byTier = groupByTier(combined);
  return bodiesByTier(byTier, (claims) =>
    claims.map((c) =>
      c.kind === 'component'
        ? `component ${c.subject}: ${c.statement}`
        : `interface ${c.subject} (${c.trace.componentIds.join(', ')}): ${c.statement}`,
    ),
  );
}

/**
 * A `T1` entry from observed `file` claims, and separate entries per tier from declared
 * `component`/`task` `trace.paths`. Paths only — never file contents.
 */
export function fileMapBodies(set: ClaimSet): readonly TieredBody[] {
  const out: TieredBody[] = [];

  const observed = [...activeClaims(set, 'file')].sort((a, b) => defaultCompare(a.id, b.id));
  if (observed.length > 0) {
    out.push(entry('T1', observed.map((c) => c.subject)));
  }

  const declared = [...activeClaims(set, 'component'), ...activeClaims(set, 'task')];
  const byTier = groupByTier(declared);
  out.push(...bodiesByTier(byTier, (claims) => claims.flatMap((c) => c.trace.paths)));

  return out;
}

/** A single `T0` entry from `stack-fact` claims. Empty when the config never parsed. */
export function stackFactsBodies(set: ClaimSet): readonly TieredBody[] {
  const claims = [...activeClaims(set, 'stack-fact')].sort((a, b) => defaultCompare(a.id, b.id));
  if (claims.length === 0) {
    return [];
  }
  return [entry('T0', claims.map((c) => `${c.subject}: ${c.statement}`))];
}
