import { sha256Canonical } from '../core/hash.js';
import type {
  BrownfieldEvidenceRecordedData,
  BrownfieldFactSchema,
  BrownfieldOmissionSchema,
  BrownfieldPredicateEvaluatedData,
  BrownfieldPredicateProposedData,
  BrownfieldScopeSchema,
} from '../core/events.js';
import type { EventId } from '../core/ids.js';
import type { ClaimId, ComponentId, WorkItemId } from '../core/ids.js';
import type { AppendInput } from '../core/log.js';
import type { MienguEvent, Stage } from '../core/events.js';
import type { ArchitecturePlan, TaskGraph } from '../contracts/index.js';
import type { Claim } from '../wiki/records.js';
import type { z } from 'zod';

export type BrownfieldFact = z.infer<typeof BrownfieldFactSchema>;
export type BrownfieldOmission = z.infer<typeof BrownfieldOmissionSchema>;
export type BrownfieldScope = z.infer<typeof BrownfieldScopeSchema>;

/** Identity for the immutable collector result; raw attachment location is deliberately absent. */
export function evidenceKey(data: z.infer<typeof BrownfieldEvidenceRecordedData>): string {
  return sha256Canonical({
    target_repo_sha256: data.target_repo_sha256,
    target_commit: data.scope.target_commit,
    ladder_tier: data.ladder_tier,
    scope_sha256: data.scope.sha256,
    collector_version: data.collector_version,
  });
}

/** The durable, deterministic result of applying the tier-0 graph to declared path seeds. */
export interface SelectedNeighborhood {
  readonly roots: readonly string[];
  readonly paths: readonly string[];
  readonly rejectedFrontier: readonly string[];
  readonly dependencyDepth: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
}

/** All inputs are already observed facts. Selection does not read the worktree. */
export interface NeighborhoodInput {
  readonly targetCommit: string;
  readonly treePaths: readonly string[];
  readonly activeTaskExpectedPaths: readonly string[];
  readonly activeTaskComponentPaths: readonly string[];
  readonly activeTaskGraphPaths: readonly string[];
  readonly architectureComponentPaths: readonly string[];
  readonly entrypoints: readonly string[];
  /** Phase 6 decision 23: path targets of pending (unevaluated) `BrownfieldPredicateProposed`
   *  events for this base commit. Seeded at lowest precedence so a proposal's targets are
   *  always inside the neighborhood a later loop collects and evaluates against. */
  readonly pendingPredicatePaths?: readonly string[];
  readonly dependencyEdges: readonly DependencyEdge[];
  /** Observed tests associated with a source path, represented as source-to-test edges. */
  readonly associatedTests: readonly DependencyEdge[];
  readonly maxFilesPerScope: number;
  readonly maxDependencyDepth: number;
}

export interface CollectorLimits {
  readonly maxTreeEntries: number;
  readonly maxFileBytes: number;
  readonly maxTestExcerptBytes: number;
  readonly maxGitCommits: number;
  readonly maxFilesPerCommit: number;
}

export interface CollectorInput {
  readonly targetRoot: string;
  readonly targetCommit: string;
  readonly storeDir: string | null;
  readonly workspaceMetadataDirs: readonly string[];
  readonly limits: CollectorLimits;
}

export interface ScopedCollectorInput extends CollectorInput {
  readonly scope: SelectedNeighborhood;
  readonly configuredTestCommand: string | null;
  readonly dependencyEdges: readonly DependencyEdge[];
}

export interface CollectedEvidence {
  readonly facts: readonly BrownfieldFact[];
  readonly omissions: readonly BrownfieldOmission[];
  readonly coverage: 'complete' | 'partial';
  /** Sorted regular-file paths from the tier-0 tree; later tiers validate their hints against it. */
  readonly treePaths: readonly string[];
  /** Canonical, normalized materials suitable for the content-addressed raw attachment. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface BrownfieldCollector {
  collectSkeleton(input: CollectorInput): Promise<CollectedEvidence>;
  collectGit(input: ScopedCollectorInput): Promise<CollectedEvidence>;
  collectTests(input: ScopedCollectorInput): Promise<CollectedEvidence>;
}

export interface PredicateEvaluationInput {
  readonly targetRoot: string;
  readonly targetCommit: string;
  readonly proposalEventId: EventId;
  readonly proposal: z.infer<typeof BrownfieldPredicateProposedData>;
  readonly policy: PredicatePolicy;
  readonly signal: AbortSignal | null;
  readonly evidenceDir: string;
}

export interface PredicateEvaluation {
  readonly data: z.infer<typeof BrownfieldPredicateEvaluatedData>;
}

export interface PredicateRunner {
  evaluate(input: PredicateEvaluationInput): Promise<PredicateEvaluation>;
}

/** A safely readable sibling log. Corrupt siblings are reported separately and never become facts. */
export interface BrownfieldStoreItem {
  readonly itemId: WorkItemId;
  readonly events: readonly MienguEvent[];
}

export interface BrownfieldCorruptSibling {
  readonly itemId: WorkItemId;
  readonly error: string;
}

/** The deliberately small coordinator boundary used by the run lifecycle. */
export interface EnsureBrownfieldInput {
  readonly enabled: boolean;
  readonly stage: Stage;
  readonly itemId: WorkItemId;
  readonly events: readonly MienguEvent[];
  readonly targetRoot: string;
  /** Excluded from tier-0 traversal when nested beneath the target repository. */
  readonly storeDir: string | null;
  readonly workspaceMetadataDirs: readonly string[];
  /** Always the original WorkspacePrepared base commit, never an accepted task commit. */
  readonly targetCommit: string;
  readonly targetRepoSha256: string;
  readonly evidenceDir: string;
  readonly collectorVersion: number;
  readonly limits: CollectorLimits & Pick<NeighborhoodInput, 'maxFilesPerScope' | 'maxDependencyDepth'>;
  readonly configuredTestCommand: string | null;
  readonly dependencyEdges: readonly DependencyEdge[];
  readonly architecturePlan: ArchitecturePlan | null;
  readonly taskGraph: TaskGraph | null;
  readonly activeTaskId: string | null;
  readonly collector: BrownfieldCollector;
  readonly predicateRunner: PredicateRunner;
  readonly predicatePolicy: PredicatePolicy;
  readonly signal: AbortSignal | null;
  /** Appends to and folds the observing item's log. */
  readonly append: (input: AppendInput) => Promise<MienguEvent>;
  /** Must exclude the observing item only when it cannot be read; corrupt siblings are separate. */
  readonly readStore: () => Promise<{
    readonly items: readonly BrownfieldStoreItem[];
    readonly corrupt: readonly BrownfieldCorruptSibling[];
  }>;
}

export interface EnsureBrownfieldResult {
  readonly evidence: readonly MienguEvent[];
  readonly evaluations: readonly MienguEvent[];
  /** Every comparable candidate was persisted or deduplicated before this filter is applied. */
  readonly drift: readonly DriftCandidate[];
  readonly touchedDrift: readonly DriftCandidate[];
  readonly corruptSiblings: readonly BrownfieldCorruptSibling[];
}

/** Deliberately independent from configuration schemas so collectors remain injectable. */
export interface PredicatePolicy {
  readonly maxPredicatesPerScope: number;
  readonly maxWallSeconds: number;
  readonly maxOutputBytes: number;
  readonly commands: Readonly<Record<string, { readonly argv: readonly string[] }>>;
  readonly sandbox: { readonly bin: string; readonly argvPrefix: readonly string[] } | null;
}

/** A closed, tool-derived value that may be compared against an eligible wiki claim.
 *  `sourceEventId`, when present, is the evidence or evaluation event that produced this
 *  observation; it is carried onto any resulting candidate for drift provenance. */
export type DriftObservation =
  | {
      readonly kind: 'stack-fact';
      readonly key: string;
      readonly value: unknown;
      readonly sourceEventId?: EventId;
    }
  | {
      readonly kind: 'path-exists';
      readonly path: string;
      readonly exists: boolean;
      readonly componentIds?: readonly ComponentId[];
      readonly sourceEventId?: EventId;
    }
  | {
      readonly kind: 'predicate';
      readonly claimItem: WorkItemId;
      readonly claim: ClaimId;
      readonly outcome: 'confirmed' | 'refuted' | 'inconclusive';
      readonly expected: unknown;
      readonly observed: unknown;
      readonly area?: string | null;
      readonly paths?: readonly string[];
      readonly componentIds?: readonly ComponentId[];
      readonly sourceEventId?: EventId;
    };

export interface DriftCandidate {
  readonly claimItem: WorkItemId;
  readonly claim: ClaimId;
  readonly expected: string;
  readonly observed: string;
  readonly area: string | null;
  readonly targetComponentIds: readonly ComponentId[];
  readonly targetPaths: readonly string[];
  readonly observedComponentIds: readonly ComponentId[];
  readonly observedPaths: readonly string[];
  /** The evidence or evaluation event that produced this candidate, for causal provenance;
   *  null only when the originating observation carried no source identity. Deliberately
   *  excluded from the durable dedupe tuple and from `DriftDetected` report data. */
  readonly sourceEventId: EventId | null;
}

export interface DriftComparisonInput {
  readonly claims: readonly Claim[];
  readonly observations: readonly DriftObservation[];
}

export interface TouchedInput {
  readonly candidate: DriftCandidate;
  readonly relevantComponentIds: readonly ComponentId[];
  readonly selectedScopePaths: readonly string[];
}

export { compareClaims, dedupeDrift, isTouched } from '../integrator/drift.js';
