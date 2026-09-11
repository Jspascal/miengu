import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSkeleton } from '../../src/brownfield/skeleton.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'miengu-skeleton-'));
  dirs.push(root);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.miengu'));
  await writeFile(join(root, 'src', 'main.ts'), 'export {}');
  await writeFile(join(root, '.git', 'config'), 'private');
  await writeFile(join(root, '.miengu', 'events.jsonl'), 'private');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    main: 'src/main.ts',
    dependencies: { express: '^1', zebra: '^1' },
    scripts: { test: 'vitest run', build: 'tsc' },
  }));
  await symlink('/tmp', join(root, 'escaping-link'));
  return root;
}

const limits = {
  maxTreeEntries: 20,
  maxFileBytes: 1024,
  maxTestExcerptBytes: 256,
  maxGitCommits: 10,
  maxFilesPerCommit: 10,
};

describe('collectSkeleton', () => {
  it('records mechanical Node manifest facts without entering metadata or symlinks', async () => {
    const targetRoot = await fixture();
    const result = await collectSkeleton({ targetRoot, targetCommit: 'abc', storeDir: '.miengu', workspaceMetadataDirs: [], limits });

    expect(result.treePaths).toEqual(['package.json', 'src/main.ts']);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manifest', path: 'package.json', ecosystem: 'node' }),
      { kind: 'dependency-edge', from: 'package.json', to: 'express' },
      { kind: 'framework', name: 'express', manifest_path: 'package.json' },
      { kind: 'entrypoint', path: 'src/main.ts', source: 'package.json:main' },
      { kind: 'test-command', name: 'test', command: 'vitest run', manifest_path: 'package.json' },
    ]));
    expect(result.omissions).toContainEqual({ subject: 'escaping-link', code: 'path-invalid' });
    expect(result.coverage).toBe('partial');
  });

  it('reports bounded enumeration as partial and keeps a deterministic prefix', async () => {
    const targetRoot = await fixture();
    // maxTreeEntries counts every inspected entry, so budget 2 covers `escaping-link` and `package.json`.
    const result = await collectSkeleton({
      targetRoot,
      targetCommit: 'abc',
      storeDir: null,
      workspaceMetadataDirs: [],
      limits: { ...limits, maxTreeEntries: 2 },
    });

    expect(result.coverage).toBe('partial');
    expect(result.omissions.some((omission) => omission.code === 'scope-truncated')).toBe(true);
    expect(result.treePaths).toEqual(['package.json']);
  });

  it('counts directory entries so a large empty tree truncates deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-skeleton-'));
    dirs.push(root);
    for (const name of ['d0', 'd1', 'd2', 'd3', 'd4']) await mkdir(join(root, name));

    const result = await collectSkeleton({
      targetRoot: root,
      targetCommit: 'abc',
      storeDir: null,
      workspaceMetadataDirs: [],
      limits: { ...limits, maxTreeEntries: 3 },
    });

    expect(result.coverage).toBe('partial');
    expect(result.omissions).toContainEqual({ subject: 'd3', code: 'scope-truncated' });
    expect(result.treePaths).toEqual([]);
    expect(result.facts).toEqual([]);
  });

  it('records an oversized file as file-too-large without hashing it or listing it', async () => {
    const targetRoot = await fixture();
    await writeFile(join(targetRoot, 'big.txt'), 'x'.repeat(limits.maxFileBytes + 1024));

    const result = await collectSkeleton({ targetRoot, targetCommit: 'abc', storeDir: '.miengu', workspaceMetadataDirs: [], limits });

    expect(result.omissions).toContainEqual({ subject: 'big.txt', code: 'file-too-large' });
    expect(result.facts.some((fact) => fact.kind === 'file' && fact.path === 'big.txt')).toBe(false);
    expect(result.treePaths).not.toContain('big.txt');
    expect(result.coverage).toBe('partial');
  });
});
