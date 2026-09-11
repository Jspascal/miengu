import type { ClaimId, EventId, WorkItemId } from '../core/ids.js';
import type { EventOf, MienguEvent } from '../core/events.js';
import type { ProvenanceTier } from '../core/provenance.js';
import { PROVENANCE_TIERS } from '../core/provenance.js';
import type { Claim, ClaimKind, ClaimSet } from './records.js';
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

function eventOrder(left: MienguEvent, right: MienguEvent): number {
  if (left.seq < right.seq) return -1;
  if (left.seq > right.seq) return 1;
  return defaultCompare(left.event_id, right.event_id);
}

function isHistoryFact(fact: EventOf<'BrownfieldEvidenceRecorded'>['data']['facts'][number]): boolean {
  return fact.kind === 'git-vocabulary' || fact.kind === 'git-churn' || fact.kind === 'git-cochange';
}

/**
 * Scoped git archaeology only. The event's normalized facts are rendered directly; its raw
 * attachment reference never crosses the pack boundary.
 */
export function brownfieldHistoryBodies(
  events: readonly MienguEvent[],
  scopeSha256: string,
): readonly TieredBody[] {
  return events
    .filter((event): event is Extract<MienguEvent, { type: 'BrownfieldEvidenceRecorded' }> =>
      event.type === 'BrownfieldEvidenceRecorded' &&
      event.data.ladder_tier === 'git-archaeology' &&
      event.data.scope.sha256 === scopeSha256,
    )
    .sort(eventOrder)
    .flatMap((event) => {
      const facts = event.data.facts.filter(isHistoryFact);
      return facts.length === 0
        ? []
        : [{ body: facts.map((fact) => JSON.stringify(fact)).join('\n'), tier: event.tier, sourceEventId: event.event_id }];
    });
}

/**
 * Completed, scoped predicate outcomes only. Proposals and raw evaluation attachments remain
 * audit-log material; an inconclusive result is not a constraint and is therefore omitted.
 */
export function brownfieldFalsificationBodies(
  events: readonly MienguEvent[],
  scopeSha256: string,
): readonly TieredBody[] {
  const proposals = new Map<EventId, Extract<MienguEvent, { type: 'BrownfieldPredicateProposed' }>>();
  for (const event of events) {
    if (event.type === 'BrownfieldPredicateProposed' && event.data.scope_sha256 === scopeSha256) {
      proposals.set(event.event_id, event);
    }
  }
  return events
    .filter((event): event is Extract<MienguEvent, { type: 'BrownfieldPredicateEvaluated' }> =>
      event.type === 'BrownfieldPredicateEvaluated' &&
      event.data.outcome !== 'inconclusive' &&
      proposals.has(event.data.proposal_event_id),
    )
    .sort(eventOrder)
    .map((event) => {
      const proposal = proposals.get(event.data.proposal_event_id);
      return {
        body: JSON.stringify({
          assertion: proposal?.data.assertion,
          area: proposal?.data.area,
          outcome: event.data.outcome,
          reason: event.data.reason,
          expected: event.data.expected,
          observed: event.data.observed,
        }),
        tier: event.tier,
        sourceEventId: event.event_id,
      };
    });
}

type EvidenceEvent = Extract<MienguEvent, { type: 'BrownfieldEvidenceRecorded' }>;
type BrownfieldFact = EvidenceEvent['data']['facts'][number];

/**
 * The single mechanical-skeleton evidence event pinned to `baseCommit`. Tier 0 is idempotent
 * per base commit, so the latest matching record is authoritative.
 */
function skeletonEvidenceForBase(
  events: readonly MienguEvent[],
  baseCommit: string,
): EvidenceEvent | undefined {
  return events
    .filter((event): event is EvidenceEvent =>
      event.type === 'BrownfieldEvidenceRecorded' &&
      event.data.ladder_tier === 'mechanical-skeleton' &&
      event.data.scope.target_commit === baseCommit,
    )
    .sort(eventOrder)
    .at(-1);
}

/** The latest tests-as-spec evidence event for the selected-neighborhood scope. */
function testSpecEvidenceForScope(
  events: readonly MienguEvent[],
  scopeSha256: string,
): EvidenceEvent | undefined {
  return events
    .filter((event): event is EvidenceEvent =>
      event.type === 'BrownfieldEvidenceRecorded' &&
      event.data.ladder_tier === 'tests-as-spec' &&
      event.data.scope.sha256 === scopeSha256,
    )
    .sort(eventOrder)
    .at(-1);
}

function skeletonBody(
  events: readonly MienguEvent[],
  baseCommit: string,
  select: (fact: BrownfieldFact) => string | null,
): readonly TieredBody[] {
  const evidence = skeletonEvidenceForBase(events, baseCommit);
  if (evidence === undefined) return [];
  const lines = evidence.data.facts
    .map(select)
    .filter((line): line is string => line !== null)
    .sort(defaultCompare);
  return lines.length === 0
    ? []
    : [{ body: lines.join('\n'), tier: evidence.tier, sourceEventId: evidence.event_id }];
}

/**
 * Scoped tier-0 stack facts from the mechanical skeleton — manifests, framework markers and
 * declared test commands only. Rendered from the normalized event facts; the raw attachment
 * never crosses the pack boundary.
 */
export function brownfieldStackFactsBodies(
  events: readonly MienguEvent[],
  baseCommit: string,
): readonly TieredBody[] {
  return skeletonBody(events, baseCommit, (fact) =>
    fact.kind === 'manifest' || fact.kind === 'framework' || fact.kind === 'test-command'
      ? JSON.stringify(fact)
      : null,
  );
}

/** Scoped tier-0 structural view from the mechanical skeleton — dependency edges and entrypoints. */
export function brownfieldSystemSkeletonBodies(
  events: readonly MienguEvent[],
  baseCommit: string,
): readonly TieredBody[] {
  return skeletonBody(events, baseCommit, (fact) =>
    fact.kind === 'dependency-edge' || fact.kind === 'entrypoint' ? JSON.stringify(fact) : null,
  );
}

/** Scoped tier-0 observed file paths from the mechanical skeleton. Paths only, never contents. */
export function brownfieldFileMapBodies(
  events: readonly MienguEvent[],
  baseCommit: string,
): readonly TieredBody[] {
  return skeletonBody(events, baseCommit, (fact) => (fact.kind === 'file' ? fact.path : null));
}

/**
 * Scoped tests-as-spec identifiers and source hashes — the body-free view for the Test Author
 * and the Reviewer. Excerpts are deliberately excluded (decision 12).
 */
export function brownfieldTestConventionLines(
  events: readonly MienguEvent[],
  scopeSha256: string,
): readonly string[] {
  const evidence = testSpecEvidenceForScope(events, scopeSha256);
  if (evidence === undefined) return [];
  return evidence.data.facts
    .filter((fact): fact is Extract<BrownfieldFact, { kind: 'test-spec' }> => fact.kind === 'test-spec')
    .map((fact) => `${fact.path}::${fact.test_id} (sha256=${fact.source_sha256}, bytes=${String(fact.bytes)})`)
    .sort(defaultCompare);
}

/**
 * Scoped tests-as-spec verbatim excerpts grouped by path — the Coder-only body channel
 * (decision 20: "Coder bodies through source-files").
 */
export function brownfieldTestSpecFiles(
  events: readonly MienguEvent[],
  scopeSha256: string,
): readonly { readonly path: string; readonly body: string }[] {
  const evidence = testSpecEvidenceForScope(events, scopeSha256);
  if (evidence === undefined) return [];
  const byPath = new Map<string, string[]>();
  for (const fact of evidence.data.facts) {
    if (fact.kind !== 'test-spec') continue;
    const parts = byPath.get(fact.path) ?? [];
    parts.push(`# ${fact.test_id}\n${fact.excerpt}`);
    byPath.set(fact.path, parts);
  }
  return [...byPath.entries()]
    .sort((left, right) => defaultCompare(left[0], right[0]))
    .map(([path, parts]) => ({ path, body: parts.join('\n\n') }));
}

/** One qualified, falsifiable active claim the Architect may name as a Tier-3 proposal
 *  subject (Phase 6 decision 23). Kept structural so `CheckContext` can carry it without a
 *  wiki→agents import cycle. */
export interface FalsifiableClaimRef {
  readonly claimItem: WorkItemId;
  readonly claim: ClaimId;
  readonly statement: string;
}

/** Decision 17's falsifiable claim kinds: closed-key stack facts and the path-bearing
 *  component/task/test-case/observed-file claims. Decision, requirement, interface,
 *  assumption and oracle-result prose is never mechanically comparable. */
const FALSIFIABLE_CLAIM_KINDS: readonly ClaimKind[] = [
  'stack-fact', 'component', 'task', 'test-case', 'file',
];

function pathInScope(path: string, scope: ReadonlySet<string>, scopePaths: readonly string[]): boolean {
  return scope.has(path) || scopePaths.some((s) => path.startsWith(`${s}/`) || s.startsWith(`${path}/`));
}

/**
 * The qualified ids and canonical statements of the falsifiable active claims whose declared
 * paths fall inside the selected scope, across every supplied item claim set. A stack-fact
 * claim carries no path and is always in scope. Sorted by `(claimItem, claim)` so the
 * Architect pack material is deterministic and a `subject` can never be guessed from prose.
 */
export function falsifiableClaimCatalogue(
  sets: Iterable<ClaimSet>,
  scopePaths: readonly string[],
): readonly FalsifiableClaimRef[] {
  const scope = new Set(scopePaths);
  const out: FalsifiableClaimRef[] = [];
  for (const set of sets) {
    for (const claim of set.claims) {
      if (claim.status !== 'active' || !FALSIFIABLE_CLAIM_KINDS.includes(claim.kind)) {
        continue;
      }
      if (claim.kind !== 'stack-fact') {
        const anyPathInScope = claim.trace.paths.some((path) => pathInScope(path, scope, scopePaths));
        if (!anyPathInScope) {
          continue;
        }
      }
      out.push({ claimItem: claim.itemId, claim: claim.id, statement: claim.statement });
    }
  }
  out.sort((a, b) => defaultCompare(`${a.claimItem}\x00${a.claim}`, `${b.claimItem}\x00${b.claim}`));
  return out;
}

/** The Architect-only `brownfield-falsification` catalogue section: one line per qualified
 *  falsifiable claim. Never shown to the Test Author (decision 23). */
export function brownfieldFalsifiableClaimBodies(
  catalogue: readonly FalsifiableClaimRef[],
): readonly TieredBody[] {
  if (catalogue.length === 0) {
    return [];
  }
  const body = catalogue.map((ref) => `${ref.claimItem}::${ref.claim}: ${ref.statement}`).join('\n');
  return [{ body, tier: 'T2', sourceEventId: null }];
}

/** Touched-event selection occurs before this function; it only renders normalized drift. */
export function brownfieldDriftBodies(
  events: readonly MienguEvent[],
  touchedEventIds: readonly EventId[],
): readonly TieredBody[] {
  const touched = new Set(touchedEventIds);
  return events
    .filter((event): event is Extract<MienguEvent, { type: 'DriftDetected' }> =>
      event.type === 'DriftDetected' && touched.has(event.event_id),
    )
    .sort(eventOrder)
    .map((event) => ({
      body: JSON.stringify({
        claim_item: event.data.claim_item,
        claim: event.data.claim,
        expected: event.data.expected,
        observed: event.data.observed,
        area: event.data.area,
      }),
      tier: event.tier,
      sourceEventId: event.event_id,
    }));
}
