import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorkspaceProvider } from '../../src/executors/isolation.js';
import { NotImplementedError } from '../../src/errors.js';
import { WorkItemIdSchema } from '../../src/core/ids.js';
import type { WorkItemId } from '../../src/core/ids.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

const itemId: WorkItemId = WorkItemIdSchema.parse('wi-example-abc123');

let targetRepo: string;
let workspacesDir: string;

beforeEach(async () => {
  targetRepo = await mkdtemp(join(tmpdir(), 'miengu-target-'));
  await git(targetRepo, ['init', '--initial-branch=main']);
  await git(targetRepo, ['config', 'user.email', 'test@example.com']);
  await git(targetRepo, ['config', 'user.name', 'Test']);
  await writeFile(join(targetRepo, '.gitignore'), '*.ignored\n');
  await writeFile(join(targetRepo, 'README.md'), 'hello\n');
  await git(targetRepo, ['add', '.gitignore', 'README.md']);
  await git(targetRepo, ['commit', '-m', 'initial']);
  workspacesDir = await mkdtemp(join(tmpdir(), 'miengu-workspaces-'));
});

afterEach(async () => {
  await rm(targetRepo, { recursive: true, force: true });
  await rm(workspacesDir, { recursive: true, force: true });
});

describe('WorktreeProvider', () => {
  it('prepares a worktree, captures a tracked modification and untracked file, discards cleanly', async () => {
    const provider = createWorkspaceProvider('worktree');
    const ws = await provider.prepare({
      itemId,
      targetRepo,
      baseRef: 'HEAD',
      workspacesDir,
      name: 'run-1',
    });

    await writeFile(join(ws.workdir, 'README.md'), 'hello\nmodified\n');
    await writeFile(join(ws.workdir, 'new-file.txt'), 'new\n');
    await writeFile(join(ws.workdir, 'ignored.ignored'), 'ignored\n');

    const capture = await provider.capture(ws);
    expect(capture.committedDuringRun).toBe(false);
    expect(capture.filesTouched).toEqual(['README.md']);
    expect(capture.untracked).toEqual(['ignored.ignored', 'new-file.txt']);
    expect(capture.insertions).toBeGreaterThan(0);
    expect(capture.diff).toContain('README.md');
    expect(capture.diffSha256).toMatch(/^[0-9a-f]{64}$/);

    const commitCountBefore = (await git(targetRepo, ['rev-list', '--count', 'HEAD'])).trim();

    await provider.discard(ws, { retain: false });

    const worktreeList = await git(targetRepo, ['worktree', 'list']);
    expect(worktreeList.trim().split('\n')).toHaveLength(1);
    const commitCountAfter = (await git(targetRepo, ['rev-list', '--count', 'HEAD'])).trim();
    expect(commitCountAfter).toBe(commitCountBefore);
  });

  it('reports committedDuringRun when the executor commits inside the worktree', async () => {
    const provider = createWorkspaceProvider('worktree');
    const ws = await provider.prepare({
      itemId,
      targetRepo,
      baseRef: 'HEAD',
      workspacesDir,
      name: 'run-2',
    });

    const invocationStart = await provider.capture(ws);
    await writeFile(join(ws.workdir, 'README.md'), 'hello\nmodified\n');
    await git(ws.workdir, ['add', 'README.md']);
    await git(ws.workdir, ['commit', '-m', 'a commit made inside the worktree']);

    const capture = await provider.capture(ws, { beforeHeadCommit: invocationStart.headCommit });
    expect(capture.committedDuringRun).toBe(true);

    const commitCountBefore = (await git(targetRepo, ['rev-list', '--count', 'HEAD'])).trim();
    await provider.discard(ws, { retain: false });
    const commitCountAfter = (await git(targetRepo, ['rev-list', '--count', 'HEAD'])).trim();
    expect(commitCountAfter).toBe(commitCountBefore);
  });

  it('does not mistake a prior detached supervisor checkpoint for an executor commit', async () => {
    const provider = createWorkspaceProvider('worktree');
    const ws = await provider.prepare({ itemId, targetRepo, baseRef: 'HEAD', workspacesDir, name: 'run-checkpoint' });
    const targetSha = (await git(targetRepo, ['rev-parse', 'main'])).trim();

    await provider.checkpoint(ws);
    const invocationStart = await provider.capture(ws);
    const capture = await provider.capture(ws, { beforeHeadCommit: invocationStart.headCommit });

    expect(capture.committedDuringRun).toBe(false);
    expect((await git(targetRepo, ['rev-parse', 'main'])).trim()).toBe(targetSha);
    await provider.discard(ws, { retain: false });
  });

  it('restores a detached commit and removes nested ignored files without moving main', async () => {
    const provider = createWorkspaceProvider('worktree');
    const ws = await provider.prepare({ itemId, targetRepo, baseRef: 'HEAD', workspacesDir, name: 'run-restore' });
    const targetSha = (await git(targetRepo, ['rev-parse', 'main'])).trim();

    await writeFile(join(ws.workdir, 'README.md'), 'changed\n');
    await git(ws.workdir, ['add', 'README.md']);
    await git(ws.workdir, ['commit', '-m', 'executor commit']);
    await mkdir(join(ws.workdir, 'nested'), { recursive: true });
    await writeFile(join(ws.workdir, 'nested', 'scratch.ignored'), 'scratch\n');

    await provider.restoreDetached(ws, ws.baseCommit);
    expect(await readFile(join(ws.workdir, 'README.md'), 'utf8')).toBe('hello\n');
    await expect(access(join(ws.workdir, 'nested', 'scratch.ignored'))).rejects.toThrow();
    expect((await git(targetRepo, ['rev-parse', 'main'])).trim()).toBe(targetSha);
    await provider.discard(ws, { retain: false });
  });

  it('restores the exact captured index, tracked tree, and untracked bytes after a staged write', async () => {
    const provider = createWorkspaceProvider('worktree');
    const ws = await provider.prepare({ itemId, targetRepo, baseRef: 'HEAD', workspacesDir, name: 'run-sandbox-restore' });

    await writeFile(join(ws.workdir, 'README.md'), 'legitimate baseline\n');
    await mkdir(join(ws.workdir, 'test'), { recursive: true });
    await writeFile(join(ws.workdir, 'test', 'frozen.test.ts'), 'frozen baseline\n');
    await writeFile(join(ws.workdir, 'baseline.ignored'), 'ignored baseline\n');
    const baseline = await provider.capture(ws);

    await writeFile(join(ws.workdir, 'README.md'), 'malicious staged rewrite\n');
    await git(ws.workdir, ['add', 'README.md']);
    await writeFile(join(ws.workdir, 'test', 'frozen.test.ts'), 'poisoned\n');
    await writeFile(join(ws.workdir, 'baseline.ignored'), 'poisoned ignored\n');

    await expect(provider.restore(ws, baseline)).resolves.toEqual({ restoredFully: true });
    expect(await readFile(join(ws.workdir, 'README.md'), 'utf8')).toBe('legitimate baseline\n');
    expect(await readFile(join(ws.workdir, 'test', 'frozen.test.ts'), 'utf8')).toBe('frozen baseline\n');
    expect(await readFile(join(ws.workdir, 'baseline.ignored'), 'utf8')).toBe('ignored baseline\n');
    expect((await git(ws.workdir, ['diff', '--cached', '--name-only'])).trim()).toBe('');

    await provider.discard(ws, { retain: false });
  });

  it('discard({retain:true}) leaves the worktree registered', async () => {
    const provider = createWorkspaceProvider('worktree');
    const ws = await provider.prepare({
      itemId,
      targetRepo,
      baseRef: 'HEAD',
      workspacesDir,
      name: 'run-retain',
    });

    await provider.discard(ws, { retain: true });

    const worktreeList = await git(targetRepo, ['worktree', 'list']);
    expect(worktreeList.trim().split('\n')).toHaveLength(2);

    // clean up manually so the temp dir removal in afterEach does not race the registered worktree
    await git(targetRepo, ['worktree', 'remove', '--force', ws.workdir]);
  });
});

describe('createWorkspaceProvider', () => {
  it("throws NotImplementedError with exit code 10 for mode 'clone'", () => {
    expect(() => createWorkspaceProvider('clone')).toThrow(NotImplementedError);
    try {
      createWorkspaceProvider('clone');
      expect.fail('expected createWorkspaceProvider to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect((error as NotImplementedError).exitCode).toBe(10);
    }
  });
});
