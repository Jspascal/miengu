import { sha256Canonical } from '../core/hash.js';
import type { DependencyEdge, NeighborhoodInput, SelectedNeighborhood } from './types.js';

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(path: string): string | null {
  const candidate = path.endsWith('/') ? path.slice(0, -1) : path;
  if (
    candidate.length === 0 ||
    candidate.startsWith('/') ||
    candidate.startsWith('\\') ||
    candidate.includes('\\') ||
    candidate.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    /[*?[\]{}]/.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(lexical);
}

function treeSet(paths: readonly string[]): Set<string> {
  return new Set(paths.map(normalizedPath).filter((path): path is string => path !== null));
}

function expandSeed(seed: string, tree: readonly string[], known: ReadonlySet<string>): readonly string[] {
  const normalized = normalizedPath(seed);
  if (normalized === null) return [];
  if (known.has(normalized)) return [normalized];
  const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
  return tree.filter((path) => path.startsWith(prefix));
}

function neighbors(path: string, edges: readonly DependencyEdge[]): string[] {
  const result: string[] = [];
  for (const edge of edges) {
    if (edge.from === path) result.push(edge.to);
    if (edge.to === path) result.push(edge.from);
  }
  return sortedUnique(result);
}

function acceptedAssociatedTests(path: string, edges: readonly DependencyEdge[], tree: ReadonlySet<string>): string[] {
  const tests: string[] = [];
  for (const edge of edges) {
    if (edge.from === path && tree.has(edge.to)) tests.push(edge.to);
    if (edge.to === path && tree.has(edge.from)) tests.push(edge.from);
  }
  return sortedUnique(tests);
}

/**
 * Pure lexical breadth-first selection over tier-0 observations.  Invalid paths and globs never
 * become roots, and every accepted path is a regular file in the observed tier-0 tree.
 */
export function selectNeighborhood(input: NeighborhoodInput): SelectedNeighborhood {
  const tree = sortedUnique(input.treePaths.map(normalizedPath).filter((path): path is string => path !== null));
  const known = treeSet(tree);
  const seedGroups = [
    input.activeTaskExpectedPaths,
    input.activeTaskComponentPaths,
    input.activeTaskGraphPaths,
    input.architectureComponentPaths,
    input.entrypoints,
    input.pendingPredicatePaths ?? [],
  ];
  const roots: string[] = [];
  const rootSet = new Set<string>();
  for (const seeds of seedGroups) {
    for (const path of sortedUnique(seeds.flatMap((seed) => expandSeed(seed, tree, known)))) {
      if (!rootSet.has(path)) {
        rootSet.add(path);
        roots.push(path);
      }
    }
  }
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const rejected = new Set<string>();
  let frontier = roots;
  let depth = 0;
  let truncated = false;

  function add(path: string): boolean {
    if (!known.has(path) || selectedSet.has(path)) return true;
    if (selected.length >= input.maxFilesPerScope) {
      rejected.add(path);
      truncated = true;
      return false;
    }
    selectedSet.add(path);
    selected.push(path);
    return true;
  }

  for (const root of roots) add(root);
  frontier = selected.slice().sort(lexical);

  while (frontier.length > 0 && depth < input.maxDependencyDepth) {
    const candidates = sortedUnique(frontier.flatMap((path) => [
      ...neighbors(path, input.dependencyEdges),
      ...acceptedAssociatedTests(path, input.associatedTests, known),
    ])).filter((path) => known.has(path) && !selectedSet.has(path));
    const next: string[] = [];
    for (const candidate of candidates) {
      if (add(candidate)) next.push(candidate);
    }
    frontier = next;
    depth += 1;
  }

  if (frontier.length > 0 && depth >= input.maxDependencyDepth) {
    for (const path of sortedUnique(frontier.flatMap((candidate) => [
      ...neighbors(candidate, input.dependencyEdges),
      ...acceptedAssociatedTests(candidate, input.associatedTests, known),
    ])).filter((path) => known.has(path) && !selectedSet.has(path))) {
      rejected.add(path);
      truncated = true;
    }
  }

  const paths = selected.sort(lexical);
  const rejectedFrontier = [...rejected].sort(lexical);
  return {
    roots,
    paths,
    rejectedFrontier,
    dependencyDepth: depth,
    truncated,
    sha256: sha256Canonical({
      target_commit: input.targetCommit,
      roots,
      paths,
      dependency_depth: depth,
      max_files: input.maxFilesPerScope,
      max_dependency_depth: input.maxDependencyDepth,
    }),
  };
}
