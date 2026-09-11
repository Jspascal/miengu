import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { collectGit } from '../../src/brownfield/git.js';
import type { ScopedCollectorInput } from '../../src/brownfield/types.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function command(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout;
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'miengu-brownfield-git-'));
  roots.push(root);
  await command(root, ['init', '--initial-branch=main']);
  await command(root, ['config', 'user.name', 'Test']);
  await command(root, ['config', 'user.email', 'test@example.com']);
  return root;
}

async function commit(root: string, subject: string): Promise<void> {
  await command(root, ['add', '-A']);
  await command(root, ['commit', '-m', subject]);
}

function input(root: string, paths: readonly string[], maxFilesPerCommit = 50): ScopedCollectorInput {
  return {
    targetRoot: root, targetCommit: 'HEAD', storeDir: null, workspaceMetadataDirs: [],
    limits: { maxTreeEntries: 50, maxFileBytes: 1024, maxTestExcerptBytes: 128, maxGitCommits: 20, maxFilesPerCommit },
    scope: { roots: paths, paths, rejectedFrontier: [], dependencyDepth: 0, truncated: false, sha256: 'a'.repeat(64) },
    configuredTestCommand: null, dependencyEdges: [],
  };
}

describe('collectGit', () => {
  it('records path-scoped vocabulary, churn, and lexical unordered co-change with spaces', async () => {
    const root = await repo();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a file.ts'), 'one\n');
    await writeFile(join(root, 'src', 'b.ts'), 'one\n');
    await commit(root, 'add initial files');
    await writeFile(join(root, 'src', 'a file.ts'), 'one\ntwo\n');
    await writeFile(join(root, 'src', 'b.ts'), 'one\ntwo\n');
    await commit(root, 'Fix parser spacing');

    const evidence = await collectGit(input(root, ['src/a file.ts', 'src/b.ts']));
    expect(evidence.coverage).toBe('complete');
    expect(evidence.facts).toContainEqual({ kind: 'git-vocabulary', token: 'fix', count: 1 });
    expect(evidence.facts).toContainEqual({ kind: 'git-churn', path: 'src/a file.ts', commits: 2, changed_lines: 2 });
    expect(evidence.facts).toContainEqual({ kind: 'git-cochange', left: 'src/a file.ts', right: 'src/b.ts', commits: 2 });
  });

  it('keeps merge vocabulary but never treats a merge as co-change', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.ts'), 'a\n');
    await commit(root, 'initial');
    await command(root, ['checkout', '-b', 'feature']);
    await writeFile(join(root, 'b.ts'), 'b\n');
    await commit(root, 'feature words');
    await command(root, ['checkout', 'main']);
    await writeFile(join(root, 'a.ts'), 'main\n');
    await commit(root, 'main words');
    await command(root, ['merge', '--no-ff', 'feature', '-m', 'merge feature vocabulary']);

    const evidence = await collectGit(input(root, ['a.ts', 'b.ts']));
    expect(evidence.facts).toContainEqual({ kind: 'git-vocabulary', token: 'merge', count: 1 });
    expect(evidence.facts.filter((fact) => fact.kind === 'git-cochange')).toHaveLength(0);
  });

  it('omits co-change from commits wider than the configured bound', async () => {
    const root = await repo();
    for (const path of ['a.ts', 'b.ts', 'outside.ts']) await writeFile(join(root, path), path);
    await commit(root, 'wide change');
    const evidence = await collectGit(input(root, ['a.ts', 'b.ts'], 2));
    expect(evidence.omissions).toContainEqual(expect.objectContaining({ code: 'commit-too-wide' }));
    expect(evidence.facts.filter((fact) => fact.kind === 'git-cochange')).toHaveLength(0);
  });

  it('marks vocabulary partial and emits a stable truncation omission when the token cap drops tokens', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.ts'), 'a\n');
    await commit(root, 'alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    const base = input(root, ['a.ts']);
    const evidence = await collectGit({ ...base, limits: { ...base.limits, maxGitCommits: 1 } });
    expect(evidence.coverage).toBe('partial');
    expect(evidence.omissions).toContainEqual({ subject: null, code: 'output-truncated' });
    expect(evidence.facts.filter((fact) => fact.kind === 'git-vocabulary')).toHaveLength(8);
  });

  it('records partial evidence for non-git, missing objects, and shallow histories', async () => {
    const nonGit = await mkdtemp(join(tmpdir(), 'miengu-brownfield-nongit-'));
    roots.push(nonGit);
    expect((await collectGit(input(nonGit, ['a.ts']))).omissions).toContainEqual({ subject: null, code: 'not-git' });

    const root = await repo();
    await writeFile(join(root, 'a.ts'), 'a');
    await commit(root, 'initial');
    const missing = await collectGit({ ...input(root, ['a.ts']), targetCommit: 'does-not-exist' });
    expect(missing.omissions).toContainEqual({ subject: 'does-not-exist', code: 'git-object-missing' });

    const clone = await mkdtemp(join(tmpdir(), 'miengu-brownfield-shallow-'));
    roots.push(clone);
    await execFileAsync('git', ['clone', '--depth=1', `file://${root}`, clone]);
    const shallow = await collectGit(input(clone, ['a.ts']));
    expect(shallow.omissions).toContainEqual({ subject: null, code: 'shallow-history' });
  });

  it('treats an empty selected scope as complete empty evidence', async () => {
    const root = await repo();
    expect(await collectGit(input(root, []))).toMatchObject({ coverage: 'complete', facts: [], omissions: [] });
  });
});
