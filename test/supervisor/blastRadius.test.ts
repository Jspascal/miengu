import { describe, it, expect } from 'vitest';
import {
  classifyBlastRadius,
  matchesGlob,
} from '../../src/supervisor/blastRadius.js';
import type {
  BlastRadiusInput,
  BlastRadiusPolicy,
  BlastRadiusTrigger,
  TriggerSeverity,
} from '../../src/supervisor/blastRadius.js';
import { canonicalJson } from '../../src/core/canonical.js';

const DEFAULT_SEVERITY: Readonly<Record<BlastRadiusTrigger, TriggerSeverity>> = {
  'migration-or-schema': 'blocking',
  'sensitive-surface': 'blocking',
  'external-contract': 'blocking',
  'protected-surface': 'blocking',
  'dependency-manifest': 'blocking',
  'diff-size': 'advisory',
};

const DEFAULT_POLICY: BlastRadiusPolicy = {
  migrationOrSchemaPaths: [],
  sensitivePaths: [],
  externalContractPaths: [],
  protectedPaths: [],
  dependencyManifestPaths: [],
  maxDiffLines: 400,
  maxFilesTouched: 20,
  severity: DEFAULT_SEVERITY,
};

function policy(overrides: Partial<BlastRadiusPolicy> & { severity?: Partial<BlastRadiusPolicy['severity']> } = {}): BlastRadiusPolicy {
  return {
    ...DEFAULT_POLICY,
    ...overrides,
    severity: { ...DEFAULT_POLICY.severity, ...(overrides.severity ?? {}) },
  };
}

function input(overrides: Partial<BlastRadiusInput> = {}): BlastRadiusInput {
  return { paths: [], untracked: [], insertions: 0, deletions: 0, ...overrides };
}

describe('classifyBlastRadius — one row per binding decision 5 trigger', () => {
  it('migration-or-schema fires on a matching path and not otherwise', () => {
    const fired = classifyBlastRadius(
      input({ paths: ['db/migrations/001.sql'] }),
      policy({ migrationOrSchemaPaths: ['**/migrations/**'] }),
    );
    expect(fired.fired).toEqual([
      { trigger: 'migration-or-schema', severity: 'blocking', paths: ['db/migrations/001.sql'] },
    ]);
    expect(fired.blocking).toBe(true);

    const notFired = classifyBlastRadius(input({ paths: ['db/migrations/001.sql'] }), DEFAULT_POLICY);
    expect(notFired.fired).toEqual([]);
    expect(notFired.blocking).toBe(false);
  });

  it('sensitive-surface fires on a matching path and not otherwise', () => {
    const fired = classifyBlastRadius(
      input({ paths: ['src/auth/login.ts'] }),
      policy({ sensitivePaths: ['**/auth/**'] }),
    );
    expect(fired.fired.map((f) => f.trigger)).toEqual(['sensitive-surface']);

    const notFired = classifyBlastRadius(input({ paths: ['src/other/login.ts'] }), policy({ sensitivePaths: ['**/auth/**'] }));
    expect(notFired.fired).toEqual([]);
  });

  it('external-contract fires on a matching path and not otherwise', () => {
    const fired = classifyBlastRadius(
      input({ paths: ['api/openapi.v1.yml'] }),
      policy({ externalContractPaths: ['**/openapi*.y*ml'] }),
    );
    expect(fired.fired.map((f) => f.trigger)).toEqual(['external-contract']);

    const notFired = classifyBlastRadius(input({ paths: ['api/readme.md'] }), policy({ externalContractPaths: ['**/openapi*.y*ml'] }));
    expect(notFired.fired).toEqual([]);
  });

  it('dependency-manifest fires on a matching path and not otherwise', () => {
    const fired = classifyBlastRadius(
      input({ paths: ['package.json'] }),
      policy({ dependencyManifestPaths: ['package.json'] }),
    );
    expect(fired.fired.map((f) => f.trigger)).toEqual(['dependency-manifest']);

    const notFired = classifyBlastRadius(input({ paths: ['other.json'] }), policy({ dependencyManifestPaths: ['package.json'] }));
    expect(notFired.fired).toEqual([]);
  });

  it('protected-surface fires on a tracked matching path and ignores untracked paths', () => {
    const trackedFired = classifyBlastRadius(
      input({ paths: ['src/index.ts'], untracked: [] }),
      policy({ protectedPaths: ['**/index.ts'] }),
    );
    expect(trackedFired.fired.map((f) => f.trigger)).toEqual(['protected-surface']);

    const untrackedIgnored = classifyBlastRadius(
      input({ paths: ['src/index.ts'], untracked: ['src/index.ts'] }),
      policy({ protectedPaths: ['**/index.ts'] }),
    );
    expect(untrackedIgnored.fired).toEqual([]);
  });

  it('diff-size fires on either clause independently and neither alone when both are under the limit', () => {
    const overLines = classifyBlastRadius(
      input({ insertions: 300, deletions: 200 }),
      policy({ maxDiffLines: 400 }),
    );
    expect(overLines.fired).toEqual([{ trigger: 'diff-size', severity: 'advisory', paths: [] }]);
    expect(overLines.blocking).toBe(false);

    const overFiles = classifyBlastRadius(
      input({ paths: Array.from({ length: 21 }, (_, i) => `f${String(i)}.ts`) }),
      policy({ maxFilesTouched: 20 }),
    );
    expect(overFiles.fired.map((f) => f.trigger)).toEqual(['diff-size']);

    const underBoth = classifyBlastRadius(
      input({ insertions: 1, deletions: 1, paths: ['a.ts'] }),
      DEFAULT_POLICY,
    );
    expect(underBoth.fired).toEqual([]);
  });

  it('an empty diff fires nothing', () => {
    const verdict = classifyBlastRadius(input(), DEFAULT_POLICY);
    expect(verdict.fired).toEqual([]);
    expect(verdict.blocking).toBe(false);
  });
});

describe('classifyBlastRadius — severity', () => {
  it('off never appears in fired and never blocks', () => {
    const verdict = classifyBlastRadius(
      input({ paths: ['db/migrations/001.sql'] }),
      policy({ migrationOrSchemaPaths: ['**/migrations/**'], severity: { 'migration-or-schema': 'off' } }),
    );
    expect(verdict.fired).toEqual([]);
    expect(verdict.blocking).toBe(false);
  });

  it('a severity override changes blocking', () => {
    const advisoryByDefault = classifyBlastRadius(input({ insertions: 500 }), policy({ maxDiffLines: 400 }));
    expect(advisoryByDefault.blocking).toBe(false);

    const overriddenToBlocking = classifyBlastRadius(
      input({ insertions: 500 }),
      policy({ maxDiffLines: 400, severity: { 'diff-size': 'blocking' } }),
    );
    expect(overriddenToBlocking.blocking).toBe(true);
  });
});

describe('matchesGlob — normative glob subset table', () => {
  const rows: readonly [pattern: string, path: string, expected: boolean][] = [
    ['**/foo.ts', 'foo.ts', true],
    ['**/foo.ts', 'a/foo.ts', true],
    ['**/foo.ts', 'a/b/foo.ts', true],
    ['a/**/foo.ts', 'a/foo.ts', true],
    ['a/**/foo.ts', 'a/b/foo.ts', true],
    ['a/**/foo.ts', 'a/b/c/foo.ts', true],
    ['a/**', 'a', true],
    ['a/**', 'a/b', true],
    ['a/**', 'a/b/c', true],
    ['a/b/**', 'a/b', true],
    ['*.ts', 'foo.ts', true],
    ['fo*.ts', 'foo.ts', true],
    ['*.ts', 'foo.js', false],
    ['foo.ts', 'foo.ts', true],
    ['foo.ts', 'bar.ts', false],
    ['a/b/c.ts', 'a/b', false],
    ['a/b', 'a/b/c', false],
    ['**', 'a/b/c', true],
    ['src/*/index.ts', 'src/components/index.ts', true],
    ['src/*/index.ts', 'src/a/b/index.ts', false],
    ['**/auth/**', 'src/auth/handler.ts', true],
    ['**/*.sql', 'db/schema.sql', true],
    ['Package.json', 'package.json', false],
    ['**/migrations/**', 'db/migrations/001.sql', true],
  ];

  for (const [pattern, path, expected] of rows) {
    it(`matchesGlob(${JSON.stringify(path)}, ${JSON.stringify(pattern)}) === ${String(expected)}`, () => {
      expect(matchesGlob(path, pattern)).toBe(expected);
    });
  }

  it('returns false, never throws, for every V11-rejected pattern shape', () => {
    const malformed = ['/leading-slash', 'has\\backslash', 'empty//segment', ''];
    for (const pattern of malformed) {
      expect(() => matchesGlob('src/index.ts', pattern)).not.toThrow();
      expect(matchesGlob('src/index.ts', pattern)).toBe(false);
    }
  });
});

describe('classifyBlastRadius — determinism', () => {
  it('two calls on the same input are byte-identical under canonicalJson', () => {
    const i = input({ paths: ['db/migrations/001.sql', 'src/auth/x.ts'], insertions: 10, deletions: 5 });
    const p = policy({ migrationOrSchemaPaths: ['**/migrations/**'], sensitivePaths: ['**/auth/**'] });
    const first = classifyBlastRadius(i, p);
    const second = classifyBlastRadius(i, p);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });
});
