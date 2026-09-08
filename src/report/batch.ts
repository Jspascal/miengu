import { z } from 'zod';
import type { MienguEvent, EvidenceRef, Stage, CheckpointKind, OracleKind, OracleScope, OracleResultStatus } from '../core/events.js';
import { ORACLE_KINDS } from '../core/events.js';
import type {
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
import { activeClaims, claimComponents, deriveClaims } from '../wiki/records.js';
import { ImplementationSchema } from '../contracts/implementation.js';

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
}

export interface BlockedCheckpoint {
  readonly itemId: WorkItemId;
  readonly checkpointId: CheckpointId;
  readonly kind: CheckpointKind;
  readonly stage: Stage;
  readonly summary: string;
  readonly raisedAt: IsoTimestamp;
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
  readonly itemId: WorkItemId;
  readonly claimId: ClaimId;
  readonly resolution: 'claim-quarantined' | ContestedOutcome;
  readonly expected: string;
  readonly observed: string;
  readonly area: string | null;
  /** True when the drifted claim's components intersect this item's touched components. */
  readonly touched: boolean;
  readonly wikiLink: string | null;
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
  const loaded: LoadedItem[] = i.items.map((item) => ({
    itemId: item.itemId,
    events: item.events,
    state: project(item.events),
    claimSet: deriveClaims(item.events),
    eventsById: new Map(item.events.map((e) => [e.event_id, e])),
  }));

  const qualifying =
    i.since === null
      ? loaded
      : loaded.filter((l) => defaultCompare(l.state.updatedAt, i.since as IsoTimestamp) >= 0);

  // --- blocked irreversible checkpoints (decision 18, position 1; decision 19: renders only
  // what CheckpointRaised.blocking and kind === 'irreversible' already recorded). ---
  const blockedIrreversible: BlockedCheckpoint[] = [];
  for (const l of qualifying) {
    const summaries = new Map<CheckpointId, string>();
    for (const e of l.events) {
      if (e.type === 'CheckpointRaised') {
        summaries.set(e.data.checkpoint, e.data.summary);
      }
    }
    for (const cp of Object.values(l.state.checkpoints)) {
      if (cp.kind === 'irreversible' && cp.blocking && cp.status === 'open') {
        blockedIrreversible.push({
          itemId: l.itemId,
          checkpointId: cp.id,
          kind: cp.kind,
          stage: cp.stage,
          summary: summaries.get(cp.id) ?? '',
          raisedAt: cp.raisedAt,
        });
      }
    }
  }
  blockedIrreversible.sort(
    (a, b) =>
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

  // --- unresolved assumptions, deepest first (decision 18, position 3). No Phase 4 producer
  // links a checkpoint to an assumption id, so "unresolved" is every recorded assumption. ---
  const unresolvedAssumptions: AssumptionEntry[] = [];
  for (const l of qualifying) {
    for (const a of l.state.assumptions) {
      unresolvedAssumptions.push({
        itemId: l.itemId,
        assumptionId: a.id,
        question: a.question,
        chosen: a.chosen,
        alternatives: a.alternatives,
        affects: a.affects,
        depth: a.depth,
        at: a.at,
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

  // --- drift in touched areas first (decision 18, position 5): quarantined claims and
  // ClaimSet.contested (decision 5), never state.drift's raw event log directly. ---
  const drift: DriftEntry[] = [];
  for (const l of qualifying) {
    const driftEventArea = new Map<EventId, string | null>();
    for (const e of l.events) {
      if (e.type === 'DriftDetected') {
        driftEventArea.set(e.event_id, e.data.area);
      }
    }
    const acceptedTaskComponents = new Set<string>();
    if (l.state.tasks !== null) {
      for (const record of Object.values(l.state.tasks.records)) {
        if (record.status !== 'accepted') {
          continue;
        }
        const taskClaim = findTaskClaim(l.claimSet, record.taskId);
        if (taskClaim !== null) {
          for (const c of taskClaim.trace.componentIds) {
            acceptedTaskComponents.add(c);
          }
        }
      }
    }
    const touchedFor = (componentIds: readonly string[]): boolean =>
      componentIds.some((c) => acceptedTaskComponents.has(c));

    for (const claim of l.claimSet.claims) {
      if (claim.status !== 'quarantined' || claim.quarantine === null) {
        continue;
      }
      drift.push({
        itemId: l.itemId,
        claimId: claim.id,
        resolution: 'claim-quarantined',
        expected: claim.quarantine.expected,
        observed: claim.quarantine.observed,
        area: driftEventArea.get(claim.quarantine.byEventId) ?? null,
        touched: touchedFor(claim.trace.componentIds),
        wikiLink: wikiLinkFor(l.itemId, claim),
      });
    }
    for (const c of l.claimSet.contested) {
      const claim = l.claimSet.byId[c.claimId];
      drift.push({
        itemId: l.itemId,
        claimId: c.claimId,
        resolution: c.outcome,
        expected: c.expected,
        observed: c.observed,
        area: driftEventArea.get(c.byEventId) ?? null,
        touched: claim !== undefined ? touchedFor(claim.trace.componentIds) : false,
        wikiLink: claim !== undefined ? wikiLinkFor(l.itemId, claim) : null,
      });
    }
  }
  drift.sort(
    (a, b) =>
      (b.touched ? 1 : 0) - (a.touched ? 1 : 0) ||
      defaultCompare(a.itemId, b.itemId) ||
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
  | 'labelYes'
  | 'labelNo'
  | 'labelFilesTouched'
  | 'labelCheckpointCommit'
  | 'labelFinalPatch'
  | 'labelDecisionChain'
  | 'labelUpdated'
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
    labelYes: 'yes',
    labelNo: 'no',
    labelFilesTouched: 'files touched',
    labelCheckpointCommit: 'checkpoint commit',
    labelFinalPatch: 'final patch',
    labelDecisionChain: 'decision chain',
    labelUpdated: 'updated',
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
    labelYes: 'oui',
    labelNo: 'non',
    labelFilesTouched: 'fichiers touchés',
    labelCheckpointCommit: 'commit du point de contrôle',
    labelFinalPatch: 'correctif final',
    labelDecisionChain: 'chaîne de décision',
    labelUpdated: 'mis à jour',
    driftClaimNotFound: 'affirmation introuvable',
    resolutionClaimQuarantined: 'affirmation mise en quarantaine',
    resolutionObservationQuarantined: 'observation mise en quarantaine',
    resolutionTie: 'égalité',
    resolutionUnknownClaim: 'affirmation inconnue',
  },
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
      parts.push(
        `- [${cp.itemId}] ${cp.checkpointId} (${s.labelStage}: ${cp.stage}) — ${cp.summary} — ${s.labelRaised}: ${cp.raisedAt}`,
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
      parts.push(
        `- [${a.itemId}] ${a.assumptionId} (${s.labelDepth}: ${a.depth}) ${a.question} → ${a.chosen}${alt}${aff}`,
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
      parts.push(
        `- [${d.itemId}] ${d.claimId}${note} — ${resolutionLabel(d.resolution, s)} — ${s.labelExpected}: ${d.expected} / ${s.labelObserved}: ${d.observed}${areaPart} — ${s.labelTouched}: ${d.touched ? s.labelYes : s.labelNo}${linkPart}`,
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
