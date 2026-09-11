import { z } from 'zod';
import type { EventOf, MienguEvent } from '../core/events.js';
import { RE_REQ_ID, formatClaimId } from '../core/ids.js';
import type { ClaimId, ComponentId, EventId, ReqId, Slug, TaskId, WorkItemId } from '../core/ids.js';
import type { ProvenanceTier } from '../core/provenance.js';
import { resolveContradiction, tierRank } from '../core/provenance.js';
import { ArchitecturePlanSchema } from '../contracts/architecturePlan.js';
import { RequirementSetSchema } from '../contracts/requirementSet.js';
import { TaskGraphSchema } from '../contracts/taskGraph.js';
import { TestSuiteSpecSchema } from '../contracts/testSuiteSpec.js';
import { ProjectionError } from '../errors.js';

// Mirrors src/core/clock.ts's IsoTimestampSchema brand exactly (same brand literal, so the
// type below is structurally identical to clock.ts's `IsoTimestamp`) without importing
// clock.ts, which the determinism zone forbids for this file. No runtime schema is needed
// here: events already carry a validated `IsoTimestamp` and this module never parses one.
type IsoTimestamp = z.infer<z.ZodBranded<z.ZodString, 'IsoTimestamp'>>;

export const CLAIM_KINDS = [
  'stack-fact',
  'requirement',
  'decision',
  'component',
  'interface',
  'task',
  'test-case',
  'file',
  'assumption',
  'oracle-result',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUSES = ['active', 'superseded', 'invalidated', 'quarantined'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Traceability links (§4/§6): also the invalidation index and the wiki placement key. */
export interface ClaimTrace {
  readonly reqIds: readonly ReqId[];
  readonly componentIds: readonly ComponentId[];
  readonly taskIds: readonly TaskId[];
  readonly decisionIds: readonly string[];
  /** Declared paths for `component`/`task`; the observed path for `file`. */
  readonly paths: readonly string[];
}

export interface ClaimQuarantine {
  readonly byEventId: EventId;
  readonly winnerTier: ProvenanceTier;
  readonly expected: string;
  readonly observed: string;
}

export interface Claim {
  readonly id: ClaimId;
  readonly itemId: WorkItemId;
  readonly kind: ClaimKind;
  /** Stable natural key within (itemId, kind). */
  readonly subject: string;
  /** One line, taken verbatim from the artifact. Never synthesised prose. */
  readonly statement: string;
  readonly tier: ProvenanceTier;
  /** §4: RequirementSet.source_span === null, or ArchitecturePlan decision req_ids === []. */
  readonly agentOriginated: boolean;
  readonly status: ClaimStatus;
  readonly trace: ClaimTrace;
  readonly originEventId: EventId;
  readonly originSeq: number;
  readonly at: IsoTimestamp;
  readonly supersededByClaimId: ClaimId | null;
  readonly supersedesClaimId: ClaimId | null;
  readonly quarantine: ClaimQuarantine | null;
}

export type ContestedOutcome = 'observation-quarantined' | 'tie' | 'unknown-claim';

export interface ContestedDrift {
  readonly claimId: ClaimId;
  readonly byEventId: EventId;
  readonly outcome: ContestedOutcome;
  readonly expected: string;
  readonly observed: string;
  readonly at: IsoTimestamp;
}

export interface ClaimSet {
  readonly itemId: WorkItemId;
  readonly slug: Slug;
  readonly title: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** Mint order (decision 3). */
  readonly claims: readonly Claim[];
  /** Insertion order matches `claims`. */
  readonly byId: Readonly<Record<ClaimId, Claim>>;
  readonly contested: readonly ContestedDrift[];
}

const EMPTY_TRACE: ClaimTrace = {
  reqIds: [],
  componentIds: [],
  taskIds: [],
  decisionIds: [],
  paths: [],
};

/** Everything an emission function knows before an id can be minted (decision 3 needs the
 *  full emission pass to finish before any id exists). */
interface CoreClaim {
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly statement: string;
  readonly baseTier: ProvenanceTier;
  readonly agentOriginated: boolean;
  readonly trace: ClaimTrace;
}

// A deliberately narrow, local mirror of the four config fields a stack-fact claim can name
// (binding decision "RunStarted.data.config unparseable ⇒ no stack-fact claims"). Importing
// src/config/schema.ts is forbidden in this file (determinism zone; §12's config-module ban),
// so the relevant subset of MienguConfigSchema's shape is duplicated here rather than shared.
const StackConfigSchema = z.object({
  target: z
    .object({
      mode: z.string(),
      baseRef: z.string(),
    })
    .passthrough(),
  oracles: z
    .object({
      build: z.string().nullable(),
      test: z.string().nullable(),
      lint: z.string().nullable(),
      typecheck: z.string().nullable(),
    })
    .passthrough(),
});

function stackFactClaims(event: EventOf<'RunStarted'>): CoreClaim[] {
  const parsed = StackConfigSchema.safeParse(event.data.config);
  if (!parsed.success) {
    return [];
  }
  const { oracles, target } = parsed.data;
  const out: CoreClaim[] = [];
  const oracleEntries: readonly (readonly [string, string | null])[] = [
    ['oracle.build', oracles.build],
    ['oracle.test', oracles.test],
    ['oracle.lint', oracles.lint],
    ['oracle.typecheck', oracles.typecheck],
  ];
  for (const [subject, value] of oracleEntries) {
    if (value !== null) {
      out.push({
        kind: 'stack-fact',
        subject,
        statement: value,
        baseTier: 'T0',
        agentOriginated: false,
        trace: EMPTY_TRACE,
      });
    }
  }
  out.push({
    kind: 'stack-fact',
    subject: 'target.mode',
    statement: target.mode,
    baseTier: 'T0',
    agentOriginated: false,
    trace: EMPTY_TRACE,
  });
  out.push({
    kind: 'stack-fact',
    subject: 'target.baseRef',
    statement: target.baseRef,
    baseTier: 'T0',
    agentOriginated: false,
    trace: EMPTY_TRACE,
  });
  return out;
}

function requirementClaims(artifactBody: unknown): CoreClaim[] {
  const parsed = RequirementSetSchema.safeParse(artifactBody);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.requirements.map((r) => ({
    kind: 'requirement' as const,
    subject: r.req_id,
    statement: r.statement,
    baseTier: 'T2' as const,
    agentOriginated: r.source_span === null,
    trace: { ...EMPTY_TRACE, reqIds: [r.req_id] },
  }));
}

function architectureClaims(artifactBody: unknown): CoreClaim[] {
  const parsed = ArchitecturePlanSchema.safeParse(artifactBody);
  if (!parsed.success) {
    return [];
  }
  const out: CoreClaim[] = [];
  for (const d of parsed.data.decisions) {
    out.push({
      kind: 'decision',
      subject: d.decision_id,
      statement: d.choice,
      baseTier: 'T2',
      agentOriginated: d.req_ids.length === 0,
      trace: { ...EMPTY_TRACE, reqIds: d.req_ids, decisionIds: [d.decision_id] },
    });
  }
  for (const c of parsed.data.components) {
    out.push({
      kind: 'component',
      subject: c.component_id,
      statement: c.responsibility,
      baseTier: 'T2',
      agentOriginated: false,
      trace: { ...EMPTY_TRACE, componentIds: [c.component_id], paths: c.paths },
    });
  }
  for (const i of parsed.data.interfaces) {
    out.push({
      kind: 'interface',
      subject: i.interface_id,
      statement: i.behaviour,
      baseTier: 'T2',
      agentOriginated: false,
      trace: { ...EMPTY_TRACE, componentIds: [i.component_id], reqIds: i.req_ids },
    });
  }
  return out;
}

function planningClaims(artifactBody: unknown): CoreClaim[] {
  const parsed = TaskGraphSchema.safeParse(artifactBody);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.tasks.map((t) => ({
    kind: 'task' as const,
    subject: t.task_id,
    statement: t.title,
    baseTier: 'T2' as const,
    agentOriginated: false,
    trace: {
      ...EMPTY_TRACE,
      reqIds: t.req_ids,
      componentIds: t.component_ids,
      taskIds: [t.task_id],
      paths: t.expected_paths,
    },
  }));
}

function testAuthoringClaims(artifactBody: unknown): CoreClaim[] {
  const parsed = TestSuiteSpecSchema.safeParse(artifactBody);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.cases.map((c) => ({
    kind: 'test-case' as const,
    subject: c.test_id,
    statement: c.intent,
    baseTier: 'T2' as const,
    agentOriginated: false,
    trace: { ...EMPTY_TRACE, reqIds: c.req_ids, paths: [c.path] },
  }));
}

function assumptionClaims(event: EventOf<'AssumptionRecorded'>): CoreClaim[] {
  const reqIds = event.data.affects.filter((a) => RE_REQ_ID.test(a)) as ReqId[];
  return [
    {
      kind: 'assumption',
      subject: event.data.id,
      statement: event.data.chosen,
      baseTier: 'T2',
      agentOriginated: false,
      trace: { ...EMPTY_TRACE, reqIds },
    },
  ];
}

function fileClaims(event: EventOf<'DiffCaptured'>): CoreClaim[] {
  return event.data.files_touched.map((path) => ({
    kind: 'file' as const,
    subject: path,
    statement: path,
    baseTier: 'T1' as const,
    agentOriginated: false,
    trace: { ...EMPTY_TRACE, paths: [path] },
  }));
}

function oracleResultClaims(event: EventOf<'OracleResultRecorded'>): CoreClaim[] {
  const subject = `${event.data.sweep_id}:${event.data.kind}`;
  return [
    {
      kind: 'oracle-result',
      subject,
      statement: event.data.status,
      baseTier: 'T1',
      agentOriginated: false,
      trace: { ...EMPTY_TRACE, taskIds: event.data.task_id !== null ? [event.data.task_id] : [] },
    },
  ];
}

interface EmittedClaim extends CoreClaim {
  readonly originEventId: EventId;
  readonly originSeq: number;
  readonly at: IsoTimestamp;
  /** Final tiebreaker beneath (seq, kind index, subject); see decision 3. */
  readonly emissionIndex: number;
}

function coreClaimsFor(event: MienguEvent): CoreClaim[] {
  switch (event.type) {
    case 'RunStarted':
      return stackFactClaims(event);
    case 'StageCompleted': {
      const artifact = event.data.artifact;
      if (artifact === null) {
        return [];
      }
      switch (event.data.stage) {
        case 'analysis':
          return artifact.kind === 'requirement-set' ? requirementClaims(artifact.body) : [];
        case 'architecture':
          return artifact.kind === 'architecture-plan' ? architectureClaims(artifact.body) : [];
        case 'planning':
          return artifact.kind === 'task-graph' ? planningClaims(artifact.body) : [];
        case 'test-authoring':
          return artifact.kind === 'test-suite-spec' ? testAuthoringClaims(artifact.body) : [];
        // implementation/review mint no claim (§2): an Implementation is a diff reference and
        // a ReviewVerdict is a routing fact, both already first-class in WorkItemState.
        default:
          return [];
      }
    }
    case 'AssumptionRecorded':
      return assumptionClaims(event);
    case 'DiffCaptured':
      return fileClaims(event);
    case 'OracleResultRecorded':
      return oracleResultClaims(event);
    default:
      return [];
  }
}

function defaultCompare(a: string, b: string): number {
  // Array.prototype.sort's default comparator, UTF-16 code units. The locale-aware string
  // compare method is forbidden here (decision 3): it is ICU-version dependent and would make
  // claim ids non-portable.
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Pure. Same events in, byte-identical ClaimSet out.
 *
 * Three passes, in order (Group A item 1): emission (this function's sort, decision 3) →
 * tier resolution (decision 4: base tier from origin, then T3 demotion — no promotion pass
 * exists) → status resolution (decisions 5 and 6, via resolveContradiction). Status is
 * resolved using each claim's *base* tier: decision 4's demotion only ever moves a T2 claim
 * to T3, and resolveContradiction(T2, 'T1') and resolveContradiction(T3, 'T1') select the same
 * row of decision 5's table (T1 always outranks both), so evaluating contradictions against
 * the base tier and the final tier is equivalent. That equivalence is what lets the T3
 * demotion rule (which needs to know whether an upstream decision claim is "active") consult
 * status without a circular dependency on the tier it has not finished computing.
 */
export function deriveClaims(events: readonly MienguEvent[]): ClaimSet {
  const created = events.find(
    (e): e is EventOf<'WorkItemCreated'> => e.type === 'WorkItemCreated',
  );
  if (created === undefined) {
    throw new ProjectionError('deriveClaims requires a WorkItemCreated event in the log');
  }
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  // A per-item projection deliberately sees only observations made about claims in that same
  // item. Store-wide callers use deriveStoreClaimSets below for qualified foreign drift.
  const localDrift = ordered.filter(
    (event): event is EventOf<'DriftDetected'> =>
      event.type === 'DriftDetected' && event.data.claim_item === created.item_id,
  );
  return deriveClaimsWithDrift(events, localDrift);
}

function deriveClaimsWithDrift(
  events: readonly MienguEvent[],
  driftEvents: readonly EventOf<'DriftDetected'>[],
): ClaimSet {
  const created = events.find(
    (e): e is EventOf<'WorkItemCreated'> => e.type === 'WorkItemCreated',
  );
  if (created === undefined) {
    throw new ProjectionError('deriveClaims requires a WorkItemCreated event in the log');
  }
  const itemId = created.item_id;
  const slug = created.data.slug;
  const title = created.data.title;
  const createdAt = created.ts;

  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  let updatedAt: IsoTimestamp = createdAt;
  const emitted: EmittedClaim[] = [];
  const invalidatedEventIds = new Set<EventId>();
  let emissionIndex = 0;

  for (const event of ordered) {
    if (event.ts > updatedAt) {
      updatedAt = event.ts;
    }
    if (event.type === 'ArtifactsInvalidated') {
      for (const id of event.data.artifact_event_ids) {
        invalidatedEventIds.add(id);
      }
      continue;
    }
    for (const core of coreClaimsFor(event)) {
      emitted.push({
        ...core,
        originEventId: event.event_id,
        originSeq: event.seq,
        at: event.ts,
        emissionIndex,
      });
      emissionIndex += 1;
    }
  }

  const kindIndex = (k: ClaimKind): number => CLAIM_KINDS.indexOf(k);
  emitted.sort((a, b) => {
    if (a.originSeq !== b.originSeq) {
      return a.originSeq - b.originSeq;
    }
    const ka = kindIndex(a.kind);
    const kb = kindIndex(b.kind);
    if (ka !== kb) {
      return ka - kb;
    }
    const bySubject = defaultCompare(a.subject, b.subject);
    if (bySubject !== 0) {
      return bySubject;
    }
    return a.emissionIndex - b.emissionIndex;
  });

  const minted = emitted.map((e, idx) => ({ ...e, id: formatClaimId(slug, idx + 1) }));

  // Supersession chains (decision 6): grouped by (kind, subject), linked in mint order.
  const groups = new Map<string, (typeof minted)[number][]>();
  for (const c of minted) {
    // NUL (\x00) cannot appear in a ClaimKind or a subject string, so it is an
    // unambiguous separator here -- unlike ':' or '|', which a subject could contain.
    const key = `${c.kind}\x00${c.subject}`;
    const arr = groups.get(key);
    if (arr === undefined) {
      groups.set(key, [c]);
    } else {
      arr.push(c);
    }
  }
  const supersededByClaimId = new Map<ClaimId, ClaimId>();
  const supersedesClaimId = new Map<ClaimId, ClaimId>();
  for (const arr of groups.values()) {
    for (let i = 0; i < arr.length - 1; i += 1) {
      const cur = arr[i];
      const next = arr[i + 1];
      if (cur !== undefined && next !== undefined) {
        supersededByClaimId.set(cur.id, next.id);
        supersedesClaimId.set(next.id, cur.id);
      }
    }
  }

  // Contradiction (decision 5): resolved against each claim's base tier — see the function
  // doc comment for why that is equivalent to resolving against the (not yet computed) final
  // tier.
  const byId = new Map(minted.map((c) => [c.id, c]));
  const quarantineById = new Map<ClaimId, ClaimQuarantine>();
  const contested: ContestedDrift[] = [];
  for (const event of driftEvents) {
    const claim = byId.get(event.data.claim);
    if (claim === undefined) {
      contested.push({
        claimId: event.data.claim,
        byEventId: event.event_id,
        outcome: 'unknown-claim',
        expected: event.data.expected,
        observed: event.data.observed,
        at: event.ts,
      });
      continue;
    }
    const outcome = resolveContradiction(claim.baseTier, 'T1');
    if (outcome.kind === 'tie') {
      contested.push({
        claimId: claim.id,
        byEventId: event.event_id,
        outcome: 'tie',
        expected: event.data.expected,
        observed: event.data.observed,
        at: event.ts,
      });
    } else if (outcome.winner === 'T1') {
      quarantineById.set(claim.id, {
        byEventId: event.event_id,
        winnerTier: 'T1',
        expected: event.data.expected,
        observed: event.data.observed,
      });
    } else {
      contested.push({
        claimId: claim.id,
        byEventId: event.event_id,
        outcome: 'observation-quarantined',
        expected: event.data.expected,
        observed: event.data.observed,
        at: event.ts,
      });
    }
  }

  // Status lattice (decision 6): invalidated > quarantined > superseded > active.
  function statusOf(c: (typeof minted)[number]): ClaimStatus {
    if (invalidatedEventIds.has(c.originEventId)) {
      return 'invalidated';
    }
    if (quarantineById.has(c.id)) {
      return 'quarantined';
    }
    if (supersededByClaimId.has(c.id)) {
      return 'superseded';
    }
    return 'active';
  }
  const statuses = new Map<ClaimId, ClaimStatus>();
  for (const c of minted) {
    statuses.set(c.id, statusOf(c));
  }

  // T3 demotion (decision 4). Consults no checkpoint (open question 1: human acceptance
  // promotes nothing, so nothing about a checkpoint could ever change this computation).
  const activeAgentDecisionEventIds = new Set<EventId>();
  let minActiveAgentDecisionSeq = Number.POSITIVE_INFINITY;
  for (const c of minted) {
    if (c.kind === 'decision' && c.agentOriginated && statuses.get(c.id) === 'active') {
      activeAgentDecisionEventIds.add(c.originEventId);
      if (c.originSeq < minActiveAgentDecisionSeq) {
        minActiveAgentDecisionSeq = c.originSeq;
      }
    }
  }
  function isProtectedAgentDecision(c: (typeof minted)[number]): boolean {
    return c.kind === 'decision' && c.agentOriginated && statuses.get(c.id) === 'active';
  }
  function finalTierOf(c: (typeof minted)[number]): ProvenanceTier {
    if (c.baseTier !== 'T2') {
      // T0/T1 claims are never demoted: a machine observation is not provisional.
      return c.baseTier;
    }
    if (activeAgentDecisionEventIds.has(c.originEventId) && !isProtectedAgentDecision(c)) {
      return 'T3';
    }
    if (
      (c.kind === 'task' || c.kind === 'test-case') &&
      c.originSeq > minActiveAgentDecisionSeq
    ) {
      return 'T3';
    }
    return 'T2';
  }

  const claims: Claim[] = minted.map((c) => ({
    id: c.id,
    itemId,
    kind: c.kind,
    subject: c.subject,
    statement: c.statement,
    tier: finalTierOf(c),
    agentOriginated: c.agentOriginated,
    status: statuses.get(c.id) ?? 'active',
    trace: c.trace,
    originEventId: c.originEventId,
    originSeq: c.originSeq,
    at: c.at,
    supersededByClaimId: supersededByClaimId.get(c.id) ?? null,
    supersedesClaimId: supersedesClaimId.get(c.id) ?? null,
    quarantine: quarantineById.get(c.id) ?? null,
  }));

  const byIdRecord: Record<ClaimId, Claim> = {};
  for (const c of claims) {
    byIdRecord[c.id] = c;
  }

  return { itemId, slug, title, createdAt, updatedAt, claims, byId: byIdRecord, contested };
}

/** An event log with its own WorkItemCreated envelope. */
export interface ClaimLogInput {
  readonly events: readonly MienguEvent[];
}

function compareStoreDrift(a: EventOf<'DriftDetected'>, b: EventOf<'DriftDetected'>): number {
  const byTimestamp = defaultCompare(a.ts, b.ts);
  if (byTimestamp !== 0) return byTimestamp;
  const byObserver = defaultCompare(a.item_id, b.item_id);
  if (byObserver !== 0) return byObserver;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return defaultCompare(a.event_id, b.event_id);
}

/**
 * Projects independent item logs, then resolves v4's qualified drift key globally. Claim ids
 * are scoped by item id here: two items are permitted to have the same slug and serial ids.
 */
export function deriveStoreClaimSets(
  items: readonly ClaimLogInput[],
): ReadonlyMap<WorkItemId, ClaimSet> {
  const base = items.map((item) => deriveClaimsWithDrift(item.events, []));
  base.sort((a, b) => defaultCompare(a.itemId, b.itemId));

  const baseByItem = new Map<WorkItemId, ClaimSet>();
  const claimOwners = new Map<string, WorkItemId>();
  for (const set of base) {
    if (baseByItem.has(set.itemId)) {
      throw new ProjectionError(`deriveStoreClaimSets received duplicate item ${set.itemId}`);
    }
    baseByItem.set(set.itemId, set);
    for (const claim of set.claims) {
      claimOwners.set(`${set.itemId}\x00${claim.id}`, set.itemId);
    }
  }

  const allDrift = items.flatMap((item) => item.events).filter(
    (event): event is EventOf<'DriftDetected'> => event.type === 'DriftDetected',
  ).sort(compareStoreDrift);
  const driftByResolutionItem = new Map<WorkItemId, EventOf<'DriftDetected'>[]>();
  for (const drift of allDrift) {
    const owner = claimOwners.get(`${drift.data.claim_item}\x00${drift.data.claim}`);
    // Unknown qualified claims remain contested in the observer's record, rather than being
    // attached to an arbitrary item with a matching slug/serial.
    const resolutionItem = owner ?? drift.item_id;
    const arr = driftByResolutionItem.get(resolutionItem);
    if (arr === undefined) {
      driftByResolutionItem.set(resolutionItem, [drift]);
    } else {
      arr.push(drift);
    }
  }

  const out = new Map<WorkItemId, ClaimSet>();
  for (const item of base) {
    const input = items.find((candidate) => {
      const created = candidate.events.find(
        (event): event is EventOf<'WorkItemCreated'> => event.type === 'WorkItemCreated',
      );
      return created?.item_id === item.itemId;
    });
    if (input === undefined) {
      throw new ProjectionError(`deriveStoreClaimSets could not find item ${item.itemId}`);
    }
    out.set(item.itemId, deriveClaimsWithDrift(input.events, driftByResolutionItem.get(item.itemId) ?? []));
  }
  return out;
}

/** Active claims only, in mint order. */
export function activeClaims(set: ClaimSet, kind?: ClaimKind): readonly Claim[] {
  return set.claims.filter((c) => c.status === 'active' && (kind === undefined || c.kind === kind));
}

/** Component files a claim renders into; empty means `_unassigned`. */
export function claimComponents(claim: Claim): readonly ComponentId[] {
  return claim.trace.componentIds;
}

/** The weakest tier among active claims minted by `eventId`; `fallback` when there are none. */
export function artifactSectionTier(
  set: ClaimSet,
  eventId: EventId | null,
  fallback: ProvenanceTier,
): ProvenanceTier {
  if (eventId === null) {
    return fallback;
  }
  let weakest: ProvenanceTier | null = null;
  for (const c of set.claims) {
    if (c.originEventId !== eventId || c.status !== 'active') {
      continue;
    }
    if (weakest === null || tierRank(c.tier) > tierRank(weakest)) {
      weakest = c.tier;
    }
  }
  return weakest ?? fallback;
}
