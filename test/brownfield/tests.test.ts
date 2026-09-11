import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '../../src/core/hash.js';
import { collectTests } from '../../src/brownfield/tests.js';
import type { ScopedCollectorInput } from '../../src/brownfield/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function input(root: string, paths: readonly string[], o: {
  configuredTestCommand?: string | null;
  dependencyEdges?: readonly { readonly from: string; readonly to: string }[];
} = {}): ScopedCollectorInput {
  return {
    targetRoot: root, targetCommit: 'HEAD', storeDir: null, workspaceMetadataDirs: [],
    limits: { maxTreeEntries: 50, maxFileBytes: 100, maxTestExcerptBytes: 12, maxGitCommits: 20, maxFilesPerCommit: 50 },
    scope: { roots: paths, paths, rejectedFrontier: [], dependencyDepth: 0, truncated: false, sha256: 'a'.repeat(64) },
    configuredTestCommand: o.configuredTestCommand ?? null,
    dependencyEdges: o.dependencyEdges ?? [],
  };
}

describe('collectTests', () => {
  it('records mechanically extractable identifiers, hashes, bytes, and bounded verbatim excerpts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-brownfield-tests-'));
    roots.push(root);
    await mkdir(join(root, 'test'), { recursive: true });
    const source = "describe('space suite', () => test('works with spaces', () => {}));\n";
    await writeFile(join(root, 'test', 'space name.test.ts'), source);
    const evidence = await collectTests(input(root, ['test/space name.test.ts']));
    expect(evidence.facts).toContainEqual({ kind: 'test-spec', path: 'test/space name.test.ts', test_id: 'works with spaces', source_sha256: sha256Hex(source), bytes: Buffer.byteLength(source), excerpt: source.slice(0, 12) });
    expect(evidence.facts).toContainEqual(expect.objectContaining({ kind: 'test-spec', test_id: 'space suite' }));
  });

  it('makes binary, oversized, unsupported, absent, and unparseable candidates explicit omissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-brownfield-tests-'));
    roots.push(root);
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'test', 'binary.test.ts'), Buffer.from([0, 1]));
    await writeFile(join(root, 'test', 'large.test.ts'), 'x'.repeat(101));
    await writeFile(join(root, 'test', 'unsupported.test.py'), 'def test_x(): pass');
    await writeFile(join(root, 'test', 'empty.test.ts'), 'export {};');
    const evidence = await collectTests(input(root, ['test/binary.test.ts', 'test/large.test.ts', 'test/unsupported.test.py', 'test/empty.test.ts', 'test/missing.test.ts']));
    expect(evidence.coverage).toBe('partial');
    expect(evidence.omissions).toEqual(expect.arrayContaining([
      { subject: 'test/binary.test.ts', code: 'binary-file' },
      { subject: 'test/large.test.ts', code: 'file-too-large' },
      { subject: 'test/unsupported.test.py', code: 'unsupported-test-syntax' },
      { subject: 'test/empty.test.ts', code: 'unsupported-test-syntax' },
      { subject: 'test/missing.test.ts', code: 'path-missing' },
    ]));
  });

  it('rejects a symlinked evidence path and a path escaping the target root through a symlinked parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-brownfield-tests-'));
    roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), 'miengu-brownfield-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.test.ts'), "it('leaked secret', () => {});\n");
    await mkdir(join(root, 'test'), { recursive: true });
    await mkdir(join(root, 'nested'), { recursive: true });
    await symlink(join(outside, 'secret.test.ts'), join(root, 'test', 'link.test.ts'));
    await symlink(outside, join(root, 'nested', 'escape'));
    const evidence = await collectTests(input(root, ['test/link.test.ts', 'nested/escape/secret.test.ts']));
    expect(evidence.coverage).toBe('partial');
    expect(evidence.facts).toEqual([]);
    expect(evidence.omissions).toEqual(expect.arrayContaining([
      { subject: 'test/link.test.ts', code: 'path-invalid' },
      { subject: 'nested/escape/secret.test.ts', code: 'path-invalid' },
    ]));
  });

  it('returns complete empty evidence when no selected path is a test', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-brownfield-tests-'));
    roots.push(root);
    expect(await collectTests(input(root, ['src/app.ts']))).toMatchObject({ coverage: 'complete', facts: [], omissions: [] });
  });

  it('discovers selected, non-conventional test paths from the declared test command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-brownfield-tests-'));
    roots.push(root);
    await mkdir(join(root, 'checks'), { recursive: true });
    await writeFile(join(root, 'checks', 'command case.ts'), "test('declared command', () => {});\n");
    const evidence = await collectTests(input(root, ['checks/command case.ts'], { configuredTestCommand: 'node "checks/command case.ts"' }));
    expect(evidence.facts).toContainEqual(expect.objectContaining({ kind: 'test-spec', path: 'checks/command case.ts', test_id: 'declared command' }));
    expect(evidence.raw).toMatchObject({ command_candidates: ['checks/command case.ts'] });
  });

  it('discovers selected, non-conventional test paths from observed edges touching the scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-brownfield-tests-'));
    roots.push(root);
    await mkdir(join(root, 'checks'), { recursive: true });
    await writeFile(join(root, 'src.ts'), 'export {};');
    await writeFile(join(root, 'checks', 'edge.ts'), "it('edge test', () => {});\n");
    const evidence = await collectTests(input(root, ['src.ts'], {
      dependencyEdges: [{ from: 'src.ts', to: 'checks/edge.ts' }],
    }));
    expect(evidence.facts).toContainEqual(expect.objectContaining({ kind: 'test-spec', path: 'checks/edge.ts', test_id: 'edge test' }));
    expect(evidence.raw).toMatchObject({ edge_candidates: ['checks/edge.ts'] });
  });
});
