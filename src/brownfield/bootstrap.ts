import { sha256Canonical } from '../core/hash.js';
import type { AppendInput, } from '../core/log.js';
import type { MienguEvent, Stage } from '../core/events.js';
import type { Claim } from '../wiki/records.js';
import { deriveStoreClaimSets } from '../wiki/records.js';
import { compareClaims, dedupeDrift, isTouched } from '../integrator/drift.js';
import { writeBrownfieldEvidence } from './evidence.js';
import { selectNeighborhood } from './scope.js';
import { evidenceKey } from './types.js';
import type {
  BrownfieldFact,
  BrownfieldScope,
  DriftObservation,
  EnsureBrownfieldInput,
  EnsureBrownfieldResult,
  SelectedNeighborhood,
} from './types.js';

const SYSTEM_ACTOR = { kind: 'system' as const, id: null };

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tierForStage(stage: Stage): readonly ('mechanical-skeleton' | 'git-archaeology' | 'tests-as-spec')[] {
  switch (stage) {
    case 'analysis':
    case 'architecture': return ['mechanical-skeleton'];
    case 'planning': return ['mechanical-skeleton', 'git-archaeology', 'tests-as-spec'];
    case 'test-authoring': return ['mechanical-skeleton', 'tests-as-spec'];
    case 'implementation':
    case 'review': return ['mechanical-skeleton', 'git-archaeology', 'tests-as-spec'];
    default: return [];
  }
}

function skeletonScope(targetCommit: string, treePaths: readonly string[], maxFiles: number): BrownfieldScope {
  const paths = [...new Set(treePaths)].sort(lexical);
  return {
    target_commit: targetCommit,
    roots: [],
    paths,
    dependency_depth: 0,
    max_files: maxFiles,
    truncated: false,
    sha256: sha256Canonical({ target_commit: targetCommit, roots: [], paths, dependency_depth: 0, max_files: maxFiles }),
  };
}

function scopeFrom(selected: SelectedNeighborhood, targetCommit: string, maxFiles: number): BrownfieldScope {
  return {
    target_commit: targetCommit,
    roots: [...selected.roots],
    paths: [...selected.paths],
    dependency_depth: selected.dependencyDepth,
    max_files: maxFiles,
    truncated: selected.truncated,
    sha256: selected.sha256,
  };
}

function factsOf(events: readonly MienguEvent[], tier: 'mechanical-skeleton'): readonly BrownfieldFact[] {
  return events.filter((event): event is Extract<MienguEvent, { type: 'BrownfieldEvidenceRecorded' }> =>
    event.type === 'BrownfieldEvidenceRecorded' && event.data.ladder_tier === tier,
  ).flatMap((event) => event.data.facts);
}

function pathsAndEdges(facts: readonly BrownfieldFact[]): { readonly treePaths: readonly string[]; readonly edges: readonly { readonly from: string; readonly to: string }[]; readonly entrypoints: readonly string[] } {
  const treePaths: string[] = [];
  const edges: { from: string; to: string }[] = [];
  const entrypoints: string[] = [];
  for (const fact of facts) {
    if (fact.kind === 'file') treePaths.push(fact.path);
    if (fact.kind === 'dependency-edge') edges.push({ from: fact.from, to: fact.to });
    if (fact.kind === 'entrypoint') entrypoints.push(fact.path);
  }
  return { treePaths: treePaths.sort(lexical), edges: edges.sort((a, b) => lexical(`${a.from}\0${a.to}`, `${b.from}\0${b.to}`)), entrypoints: entrypoints.sort(lexical) };
}

function taskPaths(input: EnsureBrownfieldInput): { readonly expected: readonly string[]; readonly components: readonly string[]; readonly graph: readonly string[] } {
  const graph = input.taskGraph;
  if (graph === null || input.activeTaskId === null) return { expected: [], components: [], graph: [] };
  const active = graph.tasks.find((task) => task.task_id === input.activeTaskId);
  const componentIds = new Set(active?.component_ids ?? []);
  return {
    expected: active?.expected_paths ?? [],
    components: input.architecturePlan?.components.filter((component) => componentIds.has(component.component_id)).flatMap((component) => component.paths) ?? [],
    graph: graph.tasks.flatMap((task) => task.expected_paths),
  };
}

function allArchitecturePaths(input: EnsureBrownfieldInput): readonly string[] {
  return input.architecturePlan?.components.flatMap((component) => component.paths) ?? [];
}

function hasEvidence(events: readonly MienguEvent[], data: Parameters<typeof evidenceKey>[0]): boolean {
  const key = evidenceKey(data);
  return events.some((event) => event.type === 'BrownfieldEvidenceRecorded' && evidenceKey(event.data) === key);
}

function relevantComponents(input: EnsureBrownfieldInput): readonly import('../core/ids.js').ComponentId[] {
  if (input.taskGraph === null || input.activeTaskId === null) return [];
  return input.taskGraph.tasks.find((task) => task.task_id === input.activeTaskId)?.component_ids ?? [];
}

/** Reject questions about material the ladder can establish mechanically; only intent reaches a human. */
export function isIntentQuestion(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (normalized.length === 0) return false;
  // Desired product behaviour is author intent even when it mentions behaviour or commands.
  if (/\b(?:should|must|intended|permitted|allowed|expected|business)\b/.test(normalized)) return true;
  return !/(?:\bpath\b|\bfile\b|\bdirectory\b|\bframework\b|\bcommand\b|\bdependency\b|\btest(?:s|ing)?\b|\bcurrent\b|\bexist(?:s|ence)?\b|\bbehavio(?:u)?r\b|\bpackage\.json\b|\bsrc\/)/.test(normalized);
}

function predicateObservations(events: readonly MienguEvent[]): readonly DriftObservation[] {
  const proposals = new Map(events.filter((event): event is Extract<MienguEvent, { type: 'BrownfieldPredicateProposed' }> => event.type === 'BrownfieldPredicateProposed').map((event) => [event.event_id, event]));
  const out: DriftObservation[] = [];
  for (const event of events) {
    if (event.type !== 'BrownfieldPredicateEvaluated' || event.data.outcome === 'inconclusive') continue;
    const proposal = proposals.get(event.data.proposal_event_id);
    if (proposal?.data.subject === null || proposal === undefined) continue;
    out.push({ kind: 'predicate', claimItem: proposal.data.subject.claim_item, claim: proposal.data.subject.claim, outcome: event.data.outcome, expected: event.data.expected, observed: event.data.observed, area: proposal.data.area, sourceEventId: event.event_id });
  }
  return out;
}

type ProposedEvent = Extract<MienguEvent, { type: 'BrownfieldPredicateProposed' }>;

function scopeIdentityKey(targetCommit: string, scopeSha256: string): string {
  return JSON.stringify([targetCommit, scopeSha256]);
}

/** The path targets a closed predicate reads. A `declared-command-exits` predicate names a
 *  config key, never a path, so it contributes no seed. */
function predicatePathSeeds(predicate: ProposedEvent['data']['predicate']): readonly string[] {
  switch (predicate.kind) {
    case 'path-exists':
    case 'json-pointer-equals':
    case 'text-includes':
      return [predicate.path];
    case 'dependency-edge-exists':
      return [predicate.from, predicate.to];
    case 'declared-command-exits':
      return [];
  }
}

/** Proposals for this base commit with no evaluation yet, in deterministic event order. */
function pendingProposalsFor(events: readonly MienguEvent[], targetCommit: string): readonly ProposedEvent[] {
  const evaluated = new Set(
    events
      .filter((event): event is Extract<MienguEvent, { type: 'BrownfieldPredicateEvaluated' }> => event.type === 'BrownfieldPredicateEvaluated')
      .map((event) => event.data.proposal_event_id),
  );
  return events
    .filter((event): event is ProposedEvent =>
      event.type === 'BrownfieldPredicateProposed' &&
      event.data.target_commit === targetCommit &&
      !evaluated.has(event.event_id),
    )
    .slice()
    .sort((left, right) => (left.seq - right.seq) || lexical(left.event_id, right.event_id));
}

/** `(target_commit, scope_sha256)` identities that a real evidence record can reconstruct;
 *  a proposal is only evaluable when its stamped scope identity is one of these. */
function reconstructableScopeIdentities(events: readonly MienguEvent[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const event of events) {
    if (event.type === 'BrownfieldEvidenceRecorded') {
      out.add(scopeIdentityKey(event.data.scope.target_commit, event.data.scope.sha256));
    }
  }
  return out;
}

function evidenceObservations(events: readonly MienguEvent[]): readonly DriftObservation[] {
  const out: DriftObservation[] = [];
  for (const event of events) {
    if (event.type !== 'BrownfieldEvidenceRecorded') continue;
    for (const fact of event.data.facts) {
      if (fact.kind === 'file') out.push({ kind: 'path-exists', path: fact.path, exists: true, sourceEventId: event.event_id });
    }
  }
  return out;
}

async function append(input: EnsureBrownfieldInput, draft: Omit<AppendInput, 'actor'>): Promise<MienguEvent> {
  return input.append({ ...draft, actor: SYSTEM_ACTOR });
}

/**
 * Ensures only the evidence appropriate for the current lifecycle boundary.  It performs no
 * workspace preparation and never substitutes a later task checkpoint for targetCommit.
 */
export async function ensureBrownfieldEvidence(input: EnsureBrownfieldInput): Promise<EnsureBrownfieldResult> {
  const empty: EnsureBrownfieldResult = { evidence: [], evaluations: [], drift: [], touchedDrift: [], corruptSiblings: [] };
  if (!input.enabled) return empty;

  const required = tierForStage(input.stage);
  if (required.length === 0) return empty;
  const evidence: MienguEvent[] = [];
  const evaluationEvents: MienguEvent[] = [];
  const current = [...input.events];
  let skeletonFacts = factsOf(current, 'mechanical-skeleton');
  let graph = pathsAndEdges(skeletonFacts);

  if (required.includes('mechanical-skeleton')) {
    const initial = skeletonScope(input.targetCommit, [], input.limits.maxFilesPerScope);
    const probe = {
      ladder_tier: 'mechanical-skeleton' as const, collector_version: input.collectorVersion,
      target_repo_sha256: input.targetRepoSha256, scope: initial, coverage: 'complete' as const, facts: [], omissions: [], evidence: { sha256: '0'.repeat(64), path: '', bytes: 0 },
    };
    // A skeleton key is discovered only after collection because its durable scope contains its tree.
    if (!current.some((event) => event.type === 'BrownfieldEvidenceRecorded' && event.data.ladder_tier === 'mechanical-skeleton' && event.data.target_repo_sha256 === input.targetRepoSha256 && event.data.scope.target_commit === input.targetCommit && event.data.collector_version === input.collectorVersion)) {
      const collected = await input.collector.collectSkeleton({ targetRoot: input.targetRoot, targetCommit: input.targetCommit, storeDir: input.storeDir, workspaceMetadataDirs: input.workspaceMetadataDirs, limits: input.limits });
      const scope = skeletonScope(input.targetCommit, collected.treePaths, input.limits.maxFilesPerScope);
      const raw = await writeBrownfieldEvidence(input.evidenceDir, collected.raw);
      const data = { ...probe, scope, coverage: collected.coverage, facts: [...collected.facts], omissions: [...collected.omissions], evidence: raw };
      if (!hasEvidence(current, data)) {
        const event = await append(input, { type: 'BrownfieldEvidenceRecorded', data, causationId: null });
        evidence.push(event); current.push(event);
      }
    }
    skeletonFacts = factsOf(current, 'mechanical-skeleton');
    graph = pathsAndEdges(skeletonFacts);
  }

  const task = taskPaths(input);
  const pending = pendingProposalsFor(current, input.targetCommit);
  const pendingPredicatePaths = [...new Set(pending.flatMap((event) => predicatePathSeeds(event.data.predicate)))].sort(lexical);
  const selected = selectNeighborhood({
    targetCommit: input.targetCommit, treePaths: graph.treePaths,
    activeTaskExpectedPaths: task.expected, activeTaskComponentPaths: task.components,
    activeTaskGraphPaths: task.graph, architectureComponentPaths: allArchitecturePaths(input),
    entrypoints: graph.entrypoints, pendingPredicatePaths,
    dependencyEdges: [...graph.edges, ...input.dependencyEdges], associatedTests: [],
    maxFilesPerScope: input.limits.maxFilesPerScope, maxDependencyDepth: input.limits.maxDependencyDepth,
  });
  const scope = scopeFrom(selected, input.targetCommit, input.limits.maxFilesPerScope);
  const scopedInput = { targetRoot: input.targetRoot, targetCommit: input.targetCommit, storeDir: input.storeDir, workspaceMetadataDirs: input.workspaceMetadataDirs, limits: input.limits, scope: selected, configuredTestCommand: input.configuredTestCommand, dependencyEdges: [...graph.edges, ...input.dependencyEdges] };
  for (const tier of required.filter((value) => value !== 'mechanical-skeleton')) {
    const candidate = { ladder_tier: tier, collector_version: input.collectorVersion, target_repo_sha256: input.targetRepoSha256, scope, coverage: 'complete' as const, facts: [], omissions: [], evidence: { sha256: '0'.repeat(64), path: '', bytes: 0 } };
    if (hasEvidence(current, candidate)) continue;
    const collected = tier === 'git-archaeology' ? await input.collector.collectGit(scopedInput) : await input.collector.collectTests(scopedInput);
    const raw = await writeBrownfieldEvidence(input.evidenceDir, collected.raw);
    const event = await append(input, { type: 'BrownfieldEvidenceRecorded', data: { ...candidate, coverage: collected.coverage, facts: [...collected.facts], omissions: [...collected.omissions], evidence: raw }, causationId: null });
    evidence.push(event); current.push(event);
  }

  // From planning onward a pending proposal is evaluated exactly once, matched by its own
  // stamped scope identity (reconstructable from a real evidence record) — never by widening
  // to commit-only. Distinct scopes are handled deterministically in event order with each
  // evaluation causally paired to its proposal and capped per scope by maxPredicatesPerScope.
  if (input.stage === 'planning' || input.stage === 'test-authoring' || input.stage === 'implementation' || input.stage === 'review') {
    const identities = reconstructableScopeIdentities(current);
    const evaluated = new Set(
      current
        .filter((event): event is Extract<MienguEvent, { type: 'BrownfieldPredicateEvaluated' }> =>
          event.type === 'BrownfieldPredicateEvaluated',
        )
        .map((event) => event.data.proposal_event_id),
    );
    const perScope = new Map<string, number>();
    const proposals = current
      .filter((event): event is ProposedEvent =>
        event.type === 'BrownfieldPredicateProposed' && event.data.target_commit === input.targetCommit,
      )
      .slice()
      .sort((left, right) => (left.seq - right.seq) || lexical(left.event_id, right.event_id));
    for (const proposal of proposals) {
      const identityKey = scopeIdentityKey(proposal.data.target_commit, proposal.data.scope_sha256);
      if (!identities.has(identityKey)) continue;
      const used = perScope.get(identityKey) ?? 0;
      if (used >= input.predicatePolicy.maxPredicatesPerScope) continue;
      perScope.set(identityKey, used + 1);
      if (evaluated.has(proposal.event_id)) continue;
      const evaluatedResult = await input.predicateRunner.evaluate({ targetRoot: input.targetRoot, targetCommit: input.targetCommit, proposalEventId: proposal.event_id, proposal: proposal.data, policy: input.predicatePolicy, signal: input.signal, evidenceDir: input.evidenceDir });
      const event = await append(input, { type: 'BrownfieldPredicateEvaluated', data: evaluatedResult.data, causationId: proposal.event_id });
      evaluationEvents.push(event); current.push(event);
    }
  }

  const store = await input.readStore();
  const items = store.items.some((item) => item.itemId === input.itemId) ? store.items.map((item) => item.itemId === input.itemId ? { ...item, events: current } : item) : [...store.items, { itemId: input.itemId, events: current }];
  const claimSets = deriveStoreClaimSets(items);
  const claims: Claim[] = [...claimSets.values()].flatMap((set) => set.claims);
  // Tuple dedupe governs persistence only. Exposure is recomputed over every comparable
  // candidate for the current neighborhood -- existing qualified drift plus newly detected
  // drift -- so a drift first recorded while untouched can still enter a later relevant role
  // pack once its target area intersects the selected scope.
  const comparable = dedupeDrift([], compareClaims({ claims, observations: [...evidenceObservations(current), ...predicateObservations(current)] }));
  for (const drift of dedupeDrift(current, comparable)) {
    // Provenance points at the exact evidence or evaluation event that produced this
    // candidate's observation, never merely the first such event in the batch.
    const event = await append(input, { type: 'DriftDetected', data: { claim_item: drift.claimItem, claim: drift.claim, expected: drift.expected, observed: drift.observed, area: drift.area }, causationId: drift.sourceEventId });
    current.push(event);
  }
  const touchedDrift = comparable.filter((candidate) => isTouched({ candidate, relevantComponentIds: relevantComponents(input), selectedScopePaths: selected.paths }));
  return { evidence, evaluations: evaluationEvents, drift: comparable, touchedDrift, corruptSiblings: store.corrupt };
}
