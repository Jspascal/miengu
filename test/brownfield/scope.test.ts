import { describe, expect, it } from 'vitest';
import { selectNeighborhood } from '../../src/brownfield/scope.js';

const BASE = {
  targetCommit: 'abc123',
  treePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/a.test.ts'],
  activeTaskExpectedPaths: ['src/a.ts'],
  activeTaskComponentPaths: [],
  activeTaskGraphPaths: [],
  architectureComponentPaths: [],
  entrypoints: [],
  dependencyEdges: [
    { from: 'src/a.ts', to: 'src/b.ts' },
    { from: 'src/b.ts', to: 'src/c.ts' },
  ],
  associatedTests: [{ from: 'src/a.ts', to: 'test/a.test.ts' }],
  maxFilesPerScope: 10,
  maxDependencyDepth: 2,
} as const;

describe('selectNeighborhood', () => {
  it('uses seed precedence and lexical breadth-first expansion in both dependency directions', () => {
    const scope = selectNeighborhood({
      ...BASE,
      activeTaskExpectedPaths: ['src/b.ts'],
      activeTaskComponentPaths: ['src/a.ts'],
      maxFilesPerScope: 2,
    });

    expect(scope.roots).toEqual(['src/b.ts', 'src/a.ts']);
    expect(scope.paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(scope.rejectedFrontier).toEqual(['src/c.ts', 'test/a.test.ts']);
    expect(scope.truncated).toBe(true);
  });

  it('expands directory seeds only against the tier-0 tree and rejects globs and escaping hints', () => {
    const scope = selectNeighborhood({
      ...BASE,
      activeTaskExpectedPaths: ['src/', '../secret', 'src/*.ts'],
      maxDependencyDepth: 0,
    });

    expect(scope.roots).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(scope.paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(scope.rejectedFrontier).toEqual(['test/a.test.ts']);
  });

  it('is stable regardless of observed edge and tree order, and includes limits in its hash', () => {
    const first = selectNeighborhood(BASE);
    const second = selectNeighborhood({
      ...BASE,
      treePaths: [...BASE.treePaths].reverse(),
      dependencyEdges: [...BASE.dependencyEdges].reverse(),
    });
    const changedLimit = selectNeighborhood({ ...BASE, maxDependencyDepth: 1 });

    expect(second).toEqual(first);
    expect(changedLimit.sha256).not.toBe(first.sha256);
  });
});
