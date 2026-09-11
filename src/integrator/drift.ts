import { canonicalJson } from '../core/canonical.js';
import type { MienguEvent } from '../core/events.js';
import type { ClaimId, ComponentId, EventId, WorkItemId } from '../core/ids.js';
import type { Claim } from '../wiki/records.js';
import type {
  DriftCandidate,
  DriftComparisonInput,
  DriftObservation,
  TouchedInput,
} from '../brownfield/types.js';

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function oneLine(value: unknown): string {
  return canonicalJson(value).replace(/[\r\n]/g, '');
}

/** A repository-relative POSIX path, or null when the input cannot describe scoped code. */
function normalizedPath(value: string): string | null {
  const path = value.replace(/\\/g, '/');
  if (path.length === 0 || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return null;
  }
  return path;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function claimPaths(claim: Claim | undefined): string[] {
  return claim === undefined ? [] : sortedUnique(claim.trace.paths.flatMap((path) => {
    const normalized = normalizedPath(path);
    return normalized === null ? [] : [normalized];
  }));
}

function claimComponents(claim: Claim | undefined): ComponentId[] {
  return claim === undefined ? [] : sortedUnique(claim.trace.componentIds) as ComponentId[];
}

function areaFor(
  components: readonly ComponentId[],
  paths: readonly string[],
  fallback: string | null | undefined,
): string | null {
  const component = sortedUnique(components)[0];
  if (component !== undefined) return component;
  const path = sortedUnique(paths)[0];
  if (path !== undefined) return path;
  if (fallback === null || fallback === undefined) return null;
  const normalized = normalizedPath(fallback);
  return normalized ?? (fallback.startsWith('component-') ? fallback : null);
}

function candidate(
  claimItem: WorkItemId,
  claim: ClaimId,
  expected: unknown,
  observed: unknown,
  target: Claim | undefined,
  observedComponents: readonly ComponentId[] = [],
  observedPaths: readonly string[] = [],
  fallbackArea?: string | null,
  sourceEventId: EventId | null = null,
): DriftCandidate | null {
  const expectedText = oneLine(expected);
  const observedText = oneLine(observed);
  if (expectedText === observedText) return null;
  const targetComponentIds = claimComponents(target);
  const targetPaths = claimPaths(target);
  const normalizedObservedPaths = sortedUnique(observedPaths.flatMap((path) => {
    const normalized = normalizedPath(path);
    return normalized === null ? [] : [normalized];
  }));
  const normalizedObservedComponents = sortedUnique(observedComponents) as ComponentId[];
  return {
    claimItem,
    claim,
    expected: expectedText,
    observed: observedText,
    area: areaFor(
      [...targetComponentIds, ...normalizedObservedComponents],
      [...targetPaths, ...normalizedObservedPaths],
      fallbackArea,
    ),
    targetComponentIds,
    targetPaths,
    observedComponentIds: normalizedObservedComponents,
    observedPaths: normalizedObservedPaths,
    sourceEventId,
  };
}

function qualifiedKey(item: WorkItemId, claim: ClaimId): string {
  return `${item}\x00${claim}`;
}

function isPathClaim(claim: Claim): boolean {
  return claim.kind === 'component' || claim.kind === 'task' || claim.kind === 'test-case' || claim.kind === 'file';
}

/**
 * Compares only the closed fact families approved for drift. Missing observations deliberately
 * yield no candidate: absence of evidence is not a contradiction.
 */
export function compareClaims(input: DriftComparisonInput): readonly DriftCandidate[] {
  const claimsByKey = new Map<string, Claim>();
  for (const claim of input.claims) claimsByKey.set(qualifiedKey(claim.itemId, claim.id), claim);

  const out: DriftCandidate[] = [];
  for (const observation of input.observations) {
    if (observation.kind === 'stack-fact') {
      for (const claim of input.claims) {
        if (claim.kind !== 'stack-fact' || claim.subject !== observation.key) continue;
        const drift = candidate(claim.itemId, claim.id, claim.statement, observation.value, claim, [], [], undefined, observation.sourceEventId ?? null);
        if (drift !== null) out.push(drift);
      }
      continue;
    }
    if (observation.kind === 'path-exists') {
      if (observation.exists) continue;
      const path = normalizedPath(observation.path);
      if (path === null) continue;
      for (const claim of input.claims) {
        if (!isPathClaim(claim) || !claimPaths(claim).includes(path)) continue;
        const drift = candidate(claim.itemId, claim.id, true, false, claim, observation.componentIds, [path], undefined, observation.sourceEventId ?? null);
        if (drift !== null) out.push(drift);
      }
      continue;
    }
    if (observation.outcome === 'inconclusive') continue;
    const target = claimsByKey.get(qualifiedKey(observation.claimItem, observation.claim));
    const drift = candidate(
      observation.claimItem,
      observation.claim,
      observation.expected,
      observation.observed,
      target,
      observation.componentIds,
      observation.paths,
      observation.area,
      observation.sourceEventId ?? null,
    );
    if (drift !== null) out.push(drift);
  }
  return out;
}

/** True only for a traceable overlap; null/untraced drift never enters a role pack. */
export function isTouched(input: TouchedInput): boolean {
  const relevantComponents = new Set(input.relevantComponentIds);
  if ([...input.candidate.targetComponentIds, ...input.candidate.observedComponentIds]
    .some((component) => relevantComponents.has(component))) return true;

  const scope = new Set(input.selectedScopePaths.flatMap((path) => {
    const normalized = normalizedPath(path);
    return normalized === null ? [] : [normalized];
  }));
  return [...input.candidate.targetPaths, ...input.candidate.observedPaths]
    .some((path) => scope.has(path));
}

/**
 * Removes only candidates whose durable tuple was already observed in this observer's log.
 * History remains untouched; a different observed value intentionally produces a new event.
 */
export function dedupeDrift(
  events: readonly MienguEvent[],
  candidates: readonly DriftCandidate[],
): readonly DriftCandidate[] {
  const known = new Set<string>();
  for (const event of events) {
    if (event.type !== 'DriftDetected') continue;
    known.add(`${event.data.claim_item}\x00${event.data.claim}\x00${event.data.expected}\x00${event.data.observed}\x00${event.data.area ?? ''}`);
  }
  const out: DriftCandidate[] = [];
  for (const value of candidates) {
    const key = `${value.claimItem}\x00${value.claim}\x00${value.expected}\x00${value.observed}\x00${value.area ?? ''}`;
    if (known.has(key)) continue;
    known.add(key);
    out.push(value);
  }
  return out;
}

export type { DriftCandidate, DriftComparisonInput, DriftObservation, TouchedInput };
