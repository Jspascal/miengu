import { z } from 'zod';
import type { MienguEvent, EvidenceRef, ParkReason, Stage, CheckpointKind, OracleKind, OracleScope, OracleResultStatus } from '../core/events.js';
import { ORACLE_KINDS } from '../core/events.js';
import type {
  AccountId,
  AssumptionId,
  CheckpointId,
  ClaimId,
  EventId,
  OracleSweepId,
  ReqId,
  TaskId,
  WorkItemId,
} from '../core/ids.js';
import type { ProvenanceTier } from '../core/provenance.js';
import type { CheckpointStateRecord, WorkItemState } from '../state/workitem.js';
import { project } from '../state/projector.js';
import type { Claim, ClaimSet, ContestedOutcome } from '../wiki/records.js';
import { activeClaims, claimComponents, deriveStoreClaimSets } from '../wiki/records.js';
import { ImplementationSchema } from '../contracts/implementation.js';
import { assumptionFacts, escalates } from '../supervisor/assumptions.js';
import { blastRadiusInput, classifyBlastRadius } from '../supervisor/blastRadius.js';
import type { FiredTrigger } from '../supervisor/blastRadius.js';
import { checkpointOwner, gatePolicyAt } from '../supervisor/checkpointPolicy.js';

// Mirrors src/core/clock.ts's IsoTimestampSchema brand exactly (same brand literal) without
// importing clock.ts, which the determinism zone forbids for this file (§1/decision 20's
// `--since` is already a validated IsoTimestamp by the time it reaches this module).
type IsoTimestamp = z.infer<z.ZodBranded<z.ZodString, 'IsoTimestamp'>>;

/** Duplicated from humanview.ts (decision 8/§4) rather than imported: item 15 forbids this
 *  module from importing humanview.js at all, even for a shared constant. */
const WIKI_DIR = 'wiki';
const UNASSIGNED_KEY = '_unassigned';

export interface BatchReportItemInput {
  readonly itemId: WorkItemId;
  readonly events: readonly MienguEvent[];
}

export interface BatchReportInput {
  readonly locale: 'fr' | 'en';
  readonly since: IsoTimestamp | null;
  readonly items: readonly BatchReportItemInput[];
  readonly corrupt: readonly { readonly itemId: WorkItemId; readonly error: string }[];
  /** Event-id keyed raw evidence availability, supplied by the I/O command.  Pure callers may
   * omit it when attachment state is unavailable. */
  readonly attachmentAvailability?: ReadonlyMap<EventId, boolean>;
}

export interface BlockedCheckpoint {
  readonly itemId: WorkItemId;
  readonly checkpointId: CheckpointId;
  readonly kind: CheckpointKind;
  readonly stage: Stage;
  readonly summary: string;
  readonly raisedAt: IsoTimestamp;
  readonly owner: string;
  readonly slaSeconds: number | null;
  readonly defaultDecision: 'accept' | null;
  /** Non-empty only for `kind === 'blast-radius'` whose `causation_id` resolves to a
   *  `DiffCaptured`; `null` when it does not resolve, which renders as "triggers unknown"
   *  and never as an empty (i.e. "nothing fired") list. */
  readonly triggers: readonly FiredTrigger[] | null;
  /** Non-empty only for `kind === 'assumption-gate'`. */
  readonly gatedAssumptionIds: readonly AssumptionId[];
}

export interface AgentOriginatedEntry {
  readonly itemId: WorkItemId;
  readonly claimId: ClaimId;
  readonly kind: 'decision' | 'requirement';
  readonly subject: string;
  readonly statement: string;
  readonly tier: ProvenanceTier;
  readonly checkpointId: CheckpointId | null;
  readonly wikiLink: string;
}

export interface AssumptionEntry {
  readonly itemId: WorkItemId;
  readonly assumptionId: AssumptionId;
  readonly question: string;
  readonly chosen: string;
  readonly alternatives: readonly string[];
  readonly affects: readonly string[];
  readonly depth: number;
  readonly at: IsoTimestamp;
  readonly gateCheckpointId: CheckpointId | null;
  /** `depth >= maxStackDepth` under the in-force config. */
  readonly escalated: boolean;
}

export interface OracleFailureEntry {
  readonly itemId: WorkItemId;
  readonly sweepId: OracleSweepId;
  readonly scope: OracleScope;
  readonly taskId: TaskId | null;
  readonly kind: OracleKind;
  readonly status: OracleResultStatus;
  readonly exitCode: number | null;
  readonly stdout: EvidenceRef;
  readonly stderr: EvidenceRef;
}

export interface DriftEntry {
  /** Item that recorded the observation. */
  readonly itemId: WorkItemId;
  readonly observerItemId: WorkItemId;
  /** Item that minted the drift target; equals observerItemId for v3/local drift. */
  readonly ownerItemId: WorkItemId;
  readonly claimId: ClaimId;
  readonly resolution: 'claim-quarantined' | ContestedOutcome;
  readonly expected: string;
  readonly observed: string;
  readonly area: string | null;
  /** True when the drifted claim's components intersect this item's touched components. */
  readonly touched: boolean;
  readonly wikiLink: string | null;
  readonly attachmentAvailable: boolean | null;
}

export interface ShippedTask {
  readonly taskId: TaskId;
  readonly reqIds: readonly ReqId[];
  readonly filesTouched: readonly string[];
  readonly implementationEventId: EventId;
  readonly reviewEventId: EventId;
  readonly checkpointCommit: string;
}

export interface ShippedItem {
  readonly itemId: WorkItemId;
  readonly title: string;
  readonly stage: Stage;
  readonly status: WorkItemState['status'];
  readonly updatedAt: IsoTimestamp;
  readonly tasks: readonly ShippedTask[];
  readonly finalPatch: EvidenceRef | null;
  /** Links into the decision chain: `wiki/components/<c>.md#<itemId>/<claimId>` per contributing
   *  decision (matches the anchor `humanview.ts` actually writes, decision 3's `<itemId>/<claimId>`
   *  cross-item qualification). */
  readonly decisionChain: readonly { readonly claimId: ClaimId; readonly wikiLink: string }[];
  readonly park: {
    readonly reason: ParkReason;
    readonly detail: string;
    readonly account: AccountId | null;
    readonly resetsAt: IsoTimestamp | null;
    readonly resumable: boolean;
  } | null;
}

export interface BatchReport {
  readonly generatedFrom: {
    readonly items: number;
    readonly events: number;
    readonly since: IsoTimestamp | null;
  };
  readonly blockedIrreversible: readonly BlockedCheckpoint[];
  readonly agentOriginated: readonly AgentOriginatedEntry[];
  readonly unresolvedAssumptions: readonly AssumptionEntry[];
  readonly oracleFailures: readonly OracleFailureEntry[];
  readonly drift: readonly DriftEntry[];
  readonly shipped: readonly ShippedItem[];
  readonly corrupt: readonly { readonly itemId: WorkItemId; readonly error: string }[];
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

/** A claim's kind fixes its origin stage under §2's emission map: `decision` only ever comes
 *  from `StageCompleted{architecture}`, `requirement` only ever from `StageCompleted{analysis}`.
 *  These are the only two kinds decision 4 lets be `agentOriginated`. */
const AGENT_ORIGINATED_KIND_STAGE: Readonly<Record<'decision' | 'requirement', Stage>> = {
  decision: 'architecture',
  requirement: 'analysis',
};

/** Component files a claim renders into (decision 8); `_unassigned` when none. The anchor
 *  format matches the one `humanview.ts` actually writes (`<itemId>/<claimId>`), so the link
 *  resolves against the wiki this same log would render. */
function wikiLinkFor(itemId: WorkItemId, claim: Claim): string {
  const components = claimComponents(claim);
  const key = components.length > 0 ? (components[0] as string) : UNASSIGNED_KEY;
  return `${WIKI_DIR}/components/${key}.md#${itemId}/${claim.id}`;
}

/** The task claim for `taskId`: the active one if any, else the most recently minted one
 *  (never fabricated; `null` if this task graph never minted a claim for it). */
function findTaskClaim(set: ClaimSet, taskId: TaskId): Claim | null {
  const active = activeClaims(set, 'task').find((c) => c.subject === taskId);
  if (active !== undefined) {
    return active;
  }
  const all = set.claims.filter((c) => c.kind === 'task' && c.subject === taskId);
  return all.length > 0 ? (all[all.length - 1] as Claim) : null;
}

/** `files_touched` from the accepted Implementation artifact body; `[]` if the artifact body
 *  does not match its contract shape (§6: never a partial or fabricated claim). */
function implementationFilesTouched(event: MienguEvent | undefined): readonly string[] {
  if (event === undefined || event.type !== 'StageCompleted') {
    return [];
  }
  const artifact = event.data.artifact;
  if (artifact === null || artifact.kind !== 'implementation') {
    return [];
  }
  const parsed = ImplementationSchema.safeParse(artifact.body);
  return parsed.success ? parsed.data.files_touched : [];
}

interface LoadedItem {
  readonly itemId: WorkItemId;
  readonly events: readonly MienguEvent[];
  readonly state: WorkItemState;
  readonly claimSet: ClaimSet;
  readonly eventsById: ReadonlyMap<EventId, MienguEvent>;
}

/**
 * Pure. Deterministic. Performs no I/O.
 *
 * Builds a `BatchReport` from raw event logs alone (§5): `project` recovers the routing state
 * (checkpoints, assumptions, oracle sweeps, tasks, integration) and `deriveClaims` (Group A)
 * recovers the knowledge model; nothing else is read. `--since` filters `items` only, never a
 * section within a qualifying item (decision 20): a blocked irreversible checkpoint raised
 * before the cutoff on an item updated after it is still reported. `corrupt` passes through
 * unfiltered — a corrupt item has no `state.updatedAt` to filter against.
 */
export function buildBatchReport(i: BatchReportInput): BatchReport {
  const storeClaimSets = deriveStoreClaimSets(i.items.map((item) => ({ events: item.events })));
  const loaded: LoadedItem[] = i.items.map((item) => {
    const claimSet = storeClaimSets.get(item.itemId);
    if (claimSet === undefined) {
      throw new Error(`buildBatchReport missing claim set for ${item.itemId}`);
    }
    return ({
    itemId: item.itemId,
    events: item.events,
    state: project(item.events),
    claimSet,
    eventsById: new Map(item.events.map((e) => [e.event_id, e])),
    });
  });

  const qualifying =
    i.since === null
      ? loaded
      : loaded.filter((l) => defaultCompare(l.state.updatedAt, i.since as IsoTimestamp) >= 0);

  // --- blocked checkpoints (decision 18, position 1; §8 amendment: every open blocking
  // checkpoint, not only kind === 'irreversible' — a blocking blast-radius, assumption-gate or
  // escalation checkpoint is a gate the operator must clear too). ---
  const blockedIrreversible: BlockedCheckpoint[] = [];
  for (const l of qualifying) {
    const summaries = new Map<CheckpointId, string>();
    const raiseEvents = new Map<CheckpointId, MienguEvent & { type: 'CheckpointRaised' }>();
    for (const e of l.events) {
      if (e.type === 'CheckpointRaised') {
        summaries.set(e.data.checkpoint, e.data.summary);
        raiseEvents.set(e.data.checkpoint, e);
      }
    }
    const facts = assumptionFacts(l.events);
    for (const cp of Object.values(l.state.checkpoints)) {
      if (!cp.blocking || cp.status !== 'open') {
        continue;
      }
      const raiseEvent = raiseEvents.get(cp.id);

      let triggers: readonly FiredTrigger[] | null = null;
      if (cp.kind === 'blast-radius' && raiseEvent !== undefined) {
        const causationId = raiseEvent.causation_id;
        const diffEvent = causationId !== null ? l.eventsById.get(causationId) : undefined;
        if (diffEvent !== undefined && diffEvent.type === 'DiffCaptured') {
          const policy = gatePolicyAt(l.events, raiseEvent.seq).blastRadius;
          triggers = classifyBlastRadius(blastRadiusInput(diffEvent.data), policy).fired;
        }
      }

      const gatedAssumptionIds: readonly AssumptionId[] =
        cp.kind === 'assumption-gate' ? facts.filter((f) => f.gateCheckpointId === cp.id).map((f) => f.id) : [];

      blockedIrreversible.push({
        itemId: l.itemId,
        checkpointId: cp.id,
        kind: cp.kind,
        stage: cp.stage,
        summary: summaries.get(cp.id) ?? '',
        raisedAt: cp.raisedAt,
        owner: checkpointOwner(l.events, cp.id),
        slaSeconds: raiseEvent?.data.sla_seconds ?? null,
        defaultDecision: raiseEvent?.data.default_decision === 'accept' ? 'accept' : null,
        triggers,
        gatedAssumptionIds,
      });
    }
  }
  blockedIrreversible.sort(
    (a, b) =>
      Number(a.kind !== 'irreversible') - Number(b.kind !== 'irreversible') ||
      defaultCompare(a.raisedAt, b.raisedAt) ||
      defaultCompare(a.itemId, b.itemId) ||
      defaultCompare(a.checkpointId, b.checkpointId),
  );

  // --- agent-originated decisions/requirements (decision 18, position 2). ---
  const agentOriginated: AgentOriginatedEntry[] = [];
  for (const l of qualifying) {
    const checkpointsByStage = new Map<Stage, CheckpointStateRecord[]>();
    for (const cp of Object.values(l.state.checkpoints)) {
      if (cp.kind === 'agent-originated' || cp.kind === 'irreversible') {
        const arr = checkpointsByStage.get(cp.stage);
        if (arr === undefined) {
          checkpointsByStage.set(cp.stage, [cp]);
        } else {
          arr.push(cp);
        }
      }
    }
    for (const arr of checkpointsByStage.values()) {
      arr.sort((a, b) => defaultCompare(a.raisedAt, b.raisedAt) || defaultCompare(a.id, b.id));
    }
    for (const claim of l.claimSet.claims) {
      if (!claim.agentOriginated || (claim.kind !== 'decision' && claim.kind !== 'requirement')) {
        continue;
      }
      const stage = AGENT_ORIGINATED_KIND_STAGE[claim.kind];
      const matches = checkpointsByStage.get(stage);
      const checkpointId = matches !== undefined && matches.length > 0 ? (matches[0] as CheckpointStateRecord).id : null;
      agentOriginated.push({
        itemId: l.itemId,
        claimId: claim.id,
        kind: claim.kind,
        subject: claim.subject,
        statement: claim.statement,
        tier: claim.tier,
        checkpointId,
        wikiLink: wikiLinkFor(l.itemId, claim),
      });
    }
  }
  agentOriginated.sort((a, b) => defaultCompare(a.itemId, b.itemId) || defaultCompare(a.claimId, b.claimId));

  // --- unresolved assumptions, deepest first (decision 18, position 3). "Unresolved" is now
  // `AssumptionFact.resolved === false`: an assumption resolved by an accepted assumption-gate
  // checkpoint leaves this section (§8 amendment). ---
  const unresolvedAssumptions: AssumptionEntry[] = [];
  for (const l of qualifying) {
    const facts = assumptionFacts(l.events);
    const recordsById = new Map(l.state.assumptions.map((a) => [a.id, a]));
    for (const f of facts) {
      if (f.resolved) {
        continue;
      }
      const record = recordsById.get(f.id);
      if (record === undefined) {
        continue;
      }
      const maxStackDepth = gatePolicyAt(l.events, f.seq).maxStackDepth;
      unresolvedAssumptions.push({
        itemId: l.itemId,
        assumptionId: f.id,
        question: record.question,
        chosen: record.chosen,
        alternatives: record.alternatives,
        affects: record.affects,
        depth: f.depth,
        at: record.at,
        gateCheckpointId: f.gateCheckpointId,
        escalated: escalates(f.depth, maxStackDepth),
      });
    }
  }
  unresolvedAssumptions.sort(
    (a, b) => b.depth - a.depth || defaultCompare(a.itemId, b.itemId) || defaultCompare(a.assumptionId, b.assumptionId),
  );

  // --- oracle failures (decision 18, position 4). ---
  const oracleFailures: OracleFailureEntry[] = [];
  for (const l of qualifying) {
    for (const sweep of Object.values(l.state.oracleSweeps)) {
      for (const result of sweep.results) {
        if (result.status === 'passed') {
          continue;
        }
        oracleFailures.push({
          itemId: l.itemId,
          sweepId: sweep.sweepId,
          scope: sweep.scope,
          taskId: sweep.taskId,
          kind: result.kind,
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
    }
  }
  oracleFailures.sort(
    (a, b) =>
      defaultCompare(a.itemId, b.itemId) ||
      defaultCompare(a.sweepId, b.sweepId) ||
      (ORACLE_KINDS.indexOf(a.kind) - ORACLE_KINDS.indexOf(b.kind)),
  );

  // --- drift in touched areas first (decision 18, position 5).  The event's envelope item is
  // the observer and its qualified claim_item is the owner; store-wide claim sets above resolve
  // the latter without conflating equal claim ids from different work items. ---
  const drift: DriftEntry[] = [];
  for (const l of qualifying) {
    const relevantComponents = new Set<string>();
    if (l.state.tasks !== null) {
      for (const record of Object.values(l.state.tasks.records)) {
        if (record.status !== 'accepted' && record.taskId !== l.state.tasks.currentTaskId) {
          continue;
        }
        const taskClaim = findTaskClaim(l.claimSet, record.taskId);
        if (taskClaim !== null) {
          for (const c of taskClaim.trace.componentIds) {
            relevantComponents.add(c);
          }
        }
      }
    }
    const scopePaths = l.events
      .filter((event): event is Extract<MienguEvent, { type: 'BrownfieldEvidenceRecorded' }> => event.type === 'BrownfieldEvidenceRecorded')
      .flatMap((event) => event.data.scope.paths);
    const touchedFor = (claim: Claim | undefined): boolean =>
      claim !== undefined && (
        claim.trace.componentIds.some((component) => relevantComponents.has(component)) ||
        claim.trace.paths.some((path) => scopePaths.includes(path))
      );
    for (const event of l.events) {
      if (event.type !== 'DriftDetected') continue;
      const ownerSet = storeClaimSets.get(event.data.claim_item);
      const claim = ownerSet?.byId[event.data.claim];
      const contested = ownerSet?.contested.find((entry) => entry.byEventId === event.event_id);
      const resolution: DriftEntry['resolution'] =
        claim?.quarantine?.byEventId === event.event_id
          ? 'claim-quarantined'
          : (contested?.outcome ?? 'unknown-claim');
      drift.push({
        itemId: l.itemId,
        observerItemId: l.itemId,
        ownerItemId: event.data.claim_item,
        claimId: event.data.claim,
        resolution,
        expected: event.data.expected,
        observed: event.data.observed,
        area: event.data.area,
        touched: touchedFor(claim),
        wikiLink: claim !== undefined ? wikiLinkFor(event.data.claim_item, claim) : null,
        attachmentAvailable:
          event.causation_id === null
            ? null
            : (i.attachmentAvailability?.get(event.causation_id) ?? null),
      });
    }
  }
  drift.sort(
    (a, b) =>
      (b.touched ? 1 : 0) - (a.touched ? 1 : 0) ||
      defaultCompare(a.observerItemId, b.observerItemId) ||
      defaultCompare(a.ownerItemId, b.ownerItemId) ||
      defaultCompare(a.claimId, b.claimId),
  );

  // --- what shipped per item, with links into the decision chain (decision 18, position 6). ---
  const shipped: ShippedItem[] = [];
  for (const l of qualifying) {
    const tasks: ShippedTask[] = [];
    if (l.state.tasks !== null) {
      for (const taskId of l.state.tasks.order) {
        const record = l.state.tasks.records[taskId];
        if (record === undefined || record.status !== 'accepted') {
          continue;
        }
        if (record.implementation === null || record.review === null || record.checkpoint === null) {
          continue;
        }
        const taskClaim = findTaskClaim(l.claimSet, taskId);
        tasks.push({
          taskId,
          reqIds: taskClaim !== null ? taskClaim.trace.reqIds : [],
          filesTouched: implementationFilesTouched(l.eventsById.get(record.implementation.eventId)),
          implementationEventId: record.implementation.eventId,
          reviewEventId: record.review.eventId,
          checkpointCommit: record.checkpoint.commit,
        });
      }
    }

    const reqIdSet = new Set<string>();
    for (const t of tasks) {
      for (const r of t.reqIds) {
        reqIdSet.add(r);
      }
    }
    const decisionsById = new Map<ClaimId, Claim>();
    for (const claim of l.claimSet.claims) {
      if (claim.kind === 'decision' && claim.trace.reqIds.some((r) => reqIdSet.has(r))) {
        decisionsById.set(claim.id, claim);
      }
    }
    const decisionChain = [...decisionsById.values()]
      .sort((a, b) => defaultCompare(a.id, b.id))
      .map((claim) => ({ claimId: claim.id, wikiLink: wikiLinkFor(l.itemId, claim) }));

    shipped.push({
      itemId: l.itemId,
      title: l.claimSet.title,
      stage: l.state.stage,
      status: l.state.status,
      updatedAt: l.state.updatedAt,
      tasks,
      finalPatch: l.state.integration.finalPatch,
      decisionChain,
      park:
        l.state.park === null
          ? null
          : {
              reason: l.state.park.reason,
              detail: l.state.park.detail,
              account: l.state.park.account,
              resetsAt: l.state.park.resetsAt,
              resumable: l.state.park.resumable,
            },
    });
  }
  shipped.sort((a, b) => defaultCompare(a.itemId, b.itemId));

  // --- then, and only then, corrupt items (decision 18, last position). ---
  const corrupt = [...i.corrupt].sort((a, b) => defaultCompare(a.itemId, b.itemId));

  return {
    generatedFrom: {
      items: qualifying.length,
      events: qualifying.reduce((sum, l) => sum + l.events.length, 0),
      since: i.since,
    },
    blockedIrreversible,
    agentOriginated,
    unresolvedAssumptions,
    oracleFailures,
    drift,
    shipped,
    corrupt,
  };
}

type ReportStringKey =
  | 'title'
  | 'summaryItems'
  | 'summaryEvents'
  | 'summarySince'
  | 'summarySinceNone'
  | 'sectionBlocked'
  | 'sectionAgentOriginated'
  | 'sectionAssumptions'
  | 'sectionOracleFailures'
  | 'sectionDrift'
  | 'sectionShipped'
  | 'sectionCorrupt'
  | 'labelStage'
  | 'labelRaised'
  | 'labelCheckpoint'
  | 'labelNone'
  | 'labelDepth'
  | 'labelAlternatives'
  | 'labelAffects'
  | 'labelScope'
  | 'labelTask'
  | 'labelStatus'
  | 'labelExitCode'
  | 'labelStdout'
  | 'labelStderr'
  | 'labelExpected'
  | 'labelObserved'
  | 'labelArea'
  | 'labelTouched'
  | 'labelObserver'
  | 'labelOwnerItem'
  | 'labelAttachment'
  | 'labelAvailable'
  | 'labelUnavailable'
  | 'labelUnknown'
  | 'labelYes'
  | 'labelNo'
  | 'labelFilesTouched'
  | 'labelCheckpointCommit'
  | 'labelFinalPatch'
  | 'labelDecisionChain'
  | 'labelUpdated'
  | 'labelOwner'
  | 'labelSla'
  | 'labelDefault'
  | 'labelTriggers'
  | 'labelTriggersUnknown'
  | 'labelGates'
  | 'labelEscalated'
  | 'labelPark'
  | 'labelResumable'
  | 'triggerMigrationOrSchema'
  | 'triggerSensitiveSurface'
  | 'triggerExternalContract'
  | 'triggerProtectedSurface'
  | 'triggerDependencyManifest'
  | 'triggerDiffSize'
  | 'driftClaimNotFound'
  | 'resolutionClaimQuarantined'
  | 'resolutionObservationQuarantined'
  | 'resolutionTie'
  | 'resolutionUnknownClaim';

/** Frozen bilingual lexicon (decision 16's discipline applied to the report). Every heading
 *  and label rendered by this module comes from here. */
const REPORT_STRINGS: Record<'fr' | 'en', Record<ReportStringKey, string>> = {
  en: {
    title: 'Batch report',
    summaryItems: 'items',
    summaryEvents: 'events',
    summarySince: 'since',
    summarySinceNone: 'none',
    sectionBlocked: 'Blocked irreversible checkpoints',
    sectionAgentOriginated: 'Agent-originated decisions',
    sectionAssumptions: 'Unresolved assumptions',
    sectionOracleFailures: 'Oracle failures',
    sectionDrift: 'Drift',
    sectionShipped: 'Shipped',
    sectionCorrupt: 'Corrupt items',
    labelStage: 'stage',
    labelRaised: 'raised',
    labelCheckpoint: 'checkpoint',
    labelNone: 'none',
    labelDepth: 'depth',
    labelAlternatives: 'alternatives',
    labelAffects: 'affects',
    labelScope: 'scope',
    labelTask: 'task',
    labelStatus: 'status',
    labelExitCode: 'exit code',
    labelStdout: 'stdout',
    labelStderr: 'stderr',
    labelExpected: 'expected',
    labelObserved: 'observed',
    labelArea: 'area',
    labelTouched: 'touched',
    labelObserver: 'observer',
    labelOwnerItem: 'owner item',
    labelAttachment: 'attachment',
    labelAvailable: 'available',
    labelUnavailable: 'unavailable',
    labelUnknown: 'unknown',
    labelYes: 'yes',
    labelNo: 'no',
    labelFilesTouched: 'files touched',
    labelCheckpointCommit: 'checkpoint commit',
    labelFinalPatch: 'final patch',
    labelDecisionChain: 'decision chain',
    labelUpdated: 'updated',
    labelOwner: 'owner',
    labelSla: 'sla',
    labelDefault: 'default',
    labelTriggers: 'triggers',
    labelTriggersUnknown: 'triggers unknown',
    labelGates: 'gates',
    labelEscalated: 'escalated',
    labelPark: 'park',
    labelResumable: 'resumable',
    triggerMigrationOrSchema: 'migration or schema',
    triggerSensitiveSurface: 'sensitive surface',
    triggerExternalContract: 'external contract',
    triggerProtectedSurface: 'protected surface',
    triggerDependencyManifest: 'dependency manifest',
    triggerDiffSize: 'diff size',
    driftClaimNotFound: 'claim not found',
    resolutionClaimQuarantined: 'claim quarantined',
    resolutionObservationQuarantined: 'observation quarantined',
    resolutionTie: 'tie',
    resolutionUnknownClaim: 'unknown claim',
  },
  fr: {
    title: 'Rapport global',
    summaryItems: 'éléments',
    summaryEvents: 'événements',
    summarySince: 'depuis',
    summarySinceNone: 'aucune',
    sectionBlocked: 'Points de contrôle irréversibles bloqués',
    sectionAgentOriginated: "Décisions d'origine agent",
    sectionAssumptions: 'Hypothèses non résolues',
    sectionOracleFailures: 'Échecs des oracles',
    sectionDrift: 'Dérive',
    sectionShipped: 'Livré',
    sectionCorrupt: 'Éléments corrompus',
    labelStage: 'étape',
    labelRaised: 'soulevé',
    labelCheckpoint: 'point de contrôle',
    labelNone: 'aucun',
    labelDepth: 'profondeur',
    labelAlternatives: 'alternatives',
    labelAffects: 'affecte',
    labelScope: 'portée',
    labelTask: 'tâche',
    labelStatus: 'statut',
    labelExitCode: 'code de sortie',
    labelStdout: 'stdout',
    labelStderr: 'stderr',
    labelExpected: 'attendu',
    labelObserved: 'observé',
    labelArea: 'zone',
    labelTouched: 'touché',
    labelObserver: 'observateur',
    labelOwnerItem: 'élément propriétaire',
    labelAttachment: 'pièce jointe',
    labelAvailable: 'disponible',
    labelUnavailable: 'indisponible',
    labelUnknown: 'inconnu',
    labelYes: 'oui',
    labelNo: 'non',
    labelFilesTouched: 'fichiers touchés',
    labelCheckpointCommit: 'commit du point de contrôle',
    labelFinalPatch: 'correctif final',
    labelDecisionChain: 'chaîne de décision',
    labelUpdated: 'mis à jour',
    labelOwner: 'responsable',
    labelSla: 'délai',
    labelDefault: 'défaut',
    labelTriggers: 'déclencheurs',
    labelTriggersUnknown: 'déclencheurs inconnus',
    labelGates: 'porte',
    labelEscalated: 'escaladé',
    labelPark: 'suspendu',
    labelResumable: 'reprenable',
    triggerMigrationOrSchema: 'migration ou schéma',
    triggerSensitiveSurface: 'surface sensible',
    triggerExternalContract: 'contrat externe',
    triggerProtectedSurface: 'surface protégée',
    triggerDependencyManifest: 'manifeste de dépendances',
    triggerDiffSize: 'taille du diff',
    driftClaimNotFound: 'affirmation introuvable',
    resolutionClaimQuarantined: 'affirmation mise en quarantaine',
    resolutionObservationQuarantined: 'observation mise en quarantaine',
    resolutionTie: 'égalité',
    resolutionUnknownClaim: 'affirmation inconnue',
  },
};

const TRIGGER_LABEL_KEY: Readonly<Record<FiredTrigger['trigger'], ReportStringKey>> = {
  'migration-or-schema': 'triggerMigrationOrSchema',
  'sensitive-surface': 'triggerSensitiveSurface',
  'external-contract': 'triggerExternalContract',
  'protected-surface': 'triggerProtectedSurface',
  'dependency-manifest': 'triggerDependencyManifest',
  'diff-size': 'triggerDiffSize',
};

function resolutionLabel(resolution: DriftEntry['resolution'], s: Record<ReportStringKey, string>): string {
  switch (resolution) {
    case 'claim-quarantined':
      return s.resolutionClaimQuarantined;
    case 'observation-quarantined':
      return s.resolutionObservationQuarantined;
    case 'tie':
      return s.resolutionTie;
    case 'unknown-claim':
      return s.resolutionUnknownClaim;
  }
}

/**
 * Pure. Deterministic. Renders `r` into text from `REPORT_STRINGS[locale]` alone (decision 17:
 * this module reads `locale`, never `wiki.language`). A section with no entries is omitted
 * entirely (§8's design test: an empty heading reduces no review minutes); the sections that
 * are present always appear in decision 18's fixed order, because that is the order `r`'s own
 * fields are populated in and read here.
 */
export function renderBatchReport(r: BatchReport, locale: 'fr' | 'en'): string {
  const s = REPORT_STRINGS[locale];
  const parts: string[] = [`# ${s.title}`];

  const sinceText = r.generatedFrom.since === null ? s.summarySinceNone : r.generatedFrom.since;
  parts.push(
    `${s.summaryItems}: ${r.generatedFrom.items} · ${s.summaryEvents}: ${r.generatedFrom.events} · ${s.summarySince}: ${sinceText}`,
  );

  if (r.blockedIrreversible.length > 0) {
    parts.push(`## ${s.sectionBlocked}`);
    for (const cp of r.blockedIrreversible) {
      const slaPart = ` — ${s.labelSla}: ${cp.slaSeconds === null ? s.labelNone : cp.slaSeconds}`;
      const defaultPart = ` — ${s.labelDefault}: ${cp.defaultDecision === null ? s.labelNone : cp.defaultDecision}`;
      const triggersPart =
        cp.kind === 'blast-radius'
          ? ` — ${s.labelTriggers}: ${cp.triggers === null ? s.labelTriggersUnknown : cp.triggers.map((t) => s[TRIGGER_LABEL_KEY[t.trigger]]).join(', ')}`
          : '';
      const gatesPart =
        cp.kind === 'assumption-gate' ? ` — ${s.labelGates}: ${cp.gatedAssumptionIds.join(', ')}` : '';
      parts.push(
        `- [${cp.itemId}] ${cp.checkpointId} (${s.labelStage}: ${cp.stage}) — ${cp.summary} — ${s.labelRaised}: ${cp.raisedAt} — ${s.labelOwner}: ${cp.owner}${slaPart}${defaultPart}${triggersPart}${gatesPart}`,
      );
    }
  }

  if (r.agentOriginated.length > 0) {
    parts.push(`## ${s.sectionAgentOriginated}`);
    for (const e of r.agentOriginated) {
      const cp = e.checkpointId === null ? s.labelNone : e.checkpointId;
      parts.push(
        `- [${e.itemId}] ${e.claimId} (${e.kind}, ${e.tier}) ${e.subject}: ${e.statement} — ${s.labelCheckpoint}: ${cp} — ${e.wikiLink}`,
      );
    }
  }

  if (r.unresolvedAssumptions.length > 0) {
    parts.push(`## ${s.sectionAssumptions}`);
    for (const a of r.unresolvedAssumptions) {
      const alt = a.alternatives.length > 0 ? ` (${s.labelAlternatives}: ${a.alternatives.join(', ')})` : '';
      const aff = a.affects.length > 0 ? ` (${s.labelAffects}: ${a.affects.join(', ')})` : '';
      const checkpointPart = ` — ${s.labelCheckpoint}: ${a.gateCheckpointId === null ? s.labelNone : a.gateCheckpointId}`;
      const escalatedPart = a.escalated ? ` — ${s.labelEscalated}` : '';
      parts.push(
        `- [${a.itemId}] ${a.assumptionId} (${s.labelDepth}: ${a.depth}) ${a.question} → ${a.chosen}${alt}${aff}${checkpointPart}${escalatedPart}`,
      );
    }
  }

  if (r.oracleFailures.length > 0) {
    parts.push(`## ${s.sectionOracleFailures}`);
    for (const f of r.oracleFailures) {
      const taskPart = f.taskId !== null ? `, ${s.labelTask}: ${f.taskId}` : '';
      const exitPart = f.exitCode !== null ? ` (${s.labelExitCode}: ${f.exitCode})` : '';
      parts.push(
        `- [${f.itemId}] ${f.sweepId} ${f.kind} (${s.labelScope}: ${f.scope}${taskPart}) — ${s.labelStatus}: ${f.status}${exitPart} — ${s.labelStdout}: ${f.stdout.path} — ${s.labelStderr}: ${f.stderr.path}`,
      );
    }
  }

  if (r.drift.length > 0) {
    parts.push(`## ${s.sectionDrift}`);
    for (const d of r.drift) {
      const note = d.resolution === 'unknown-claim' ? ` (${s.driftClaimNotFound})` : '';
      const areaPart = d.area !== null ? ` (${s.labelArea}: ${d.area})` : '';
      const linkPart = d.wikiLink !== null ? ` — ${d.wikiLink}` : '';
      const attachment = d.attachmentAvailable === null
        ? s.labelUnknown
        : (d.attachmentAvailable ? s.labelAvailable : s.labelUnavailable);
      parts.push(
        `- [${d.observerItemId}] ${d.claimId}${note} — ${resolutionLabel(d.resolution, s)} — ${s.labelObserver}: ${d.observerItemId} — ${s.labelOwnerItem}: ${d.ownerItemId} — ${s.labelExpected}: ${d.expected} / ${s.labelObserved}: ${d.observed}${areaPart} — ${s.labelTouched}: ${d.touched ? s.labelYes : s.labelNo} — ${s.labelAttachment}: ${attachment}${linkPart}`,
      );
    }
  }

  if (r.shipped.length > 0) {
    parts.push(`## ${s.sectionShipped}`);
    for (const item of r.shipped) {
      parts.push(`### ${item.title} (${item.itemId})`);
      parts.push(
        `${s.labelStage}: ${item.stage} — ${s.labelStatus}: ${item.status} — ${s.labelUpdated}: ${item.updatedAt}`,
      );
      for (const t of item.tasks) {
        parts.push(
          `- ${t.taskId} (${s.labelFilesTouched}: ${t.filesTouched.join(', ')}) — ${s.labelCheckpointCommit}: ${t.checkpointCommit}`,
        );
      }
      if (item.finalPatch !== null) {
        parts.push(`${s.labelFinalPatch}: ${item.finalPatch.path}`);
      }
      if (item.decisionChain.length > 0) {
        parts.push(`${s.labelDecisionChain}: ${item.decisionChain.map((d) => d.wikiLink).join(', ')}`);
      }
      if (item.park !== null) {
        const accountPart = item.park.account !== null ? ` (${item.park.account})` : '';
        const resetsPart = item.park.resetsAt !== null ? `, ${item.park.resetsAt}` : '';
        parts.push(
          `${s.labelPark}: ${item.park.reason}${accountPart}${resetsPart} — ${s.labelResumable}: ${item.park.resumable ? s.labelYes : s.labelNo}`,
        );
      }
    }
  }

  if (r.corrupt.length > 0) {
    parts.push(`## ${s.sectionCorrupt}`);
    for (const c of r.corrupt) {
      parts.push(`- ${c.itemId}: ${c.error}`);
    }
  }

  return parts.join('\n\n');
}
