import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorkspaceProvider } from '../../src/executors/isolation.js';
import {
  captureFinalPatch,
  checkpointAcceptedTask,
  checkpointFrozenTests,
  rebuildWorkspace,
} from '../../src/integrator/merge.js';
import { WorkItemIdSchema, TaskIdSchema } from '../../src/core/ids.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const taskOne = TaskIdSchema.parse('task-example-1');
const taskTwo = TaskIdSchema.parse('task-example-2');

let targetRepo: string;
let workspacesDir: string;
let evidenceDir: string;

beforeEach(async () => {
  targetRepo = await mkdtemp(join(tmpdir(), 'miengu-integrator-target-'));
  await git(targetRepo, ['init', '--initial-branch=main']);
  await git(targetRepo, ['config', 'user.email', 'test@example.com']);
  await git(targetRepo, ['config', 'user.name', 'Test']);
  await writeFile(join(targetRepo, 'README.md'), 'base\n');
  await git(targetRepo, ['add', 'README.md']);
  await git(targetRepo, ['commit', '-m', 'initial']);
  workspacesDir = await mkdtemp(join(tmpdir(), 'miengu-integrator-workspaces-'));
  evidenceDir = await mkdtemp(join(tmpdir(), 'miengu-integrator-evidence-'));
});

afterEach(async () => {
  await rm(targetRepo, { recursive: true, force: true });
  await rm(workspacesDir, { recursive: true, force: true });
  await rm(evidenceDir, { recursive: true, force: true });
});

describe('detached integration checkpoints', () => {
  it('rebuilds retained accepted tasks in topological order, removes invalidated work, and preserves main', async () => {
    const workspace = createWorkspaceProvider('worktree');
    const prepared = await workspace.prepare({ itemId, targetRepo, baseRef: 'main', workspacesDir, name: 'integrate' });
    const targetSha = (await git(targetRepo, ['rev-parse', 'main'])).trim();

    await writeFile(join(prepared.workdir, 'frozen.test'), 'frozen\n');
    const frozenTests = await checkpointFrozenTests({ workspace, prepared, evidenceDir });
    await writeFile(join(prepared.workdir, 'one.txt'), 'one\n');
    const first = await checkpointAcceptedTask({ workspace, prepared, evidenceDir, taskId: taskOne, orderIndex: 1 });
    await writeFile(join(prepared.workdir, 'two.txt'), 'two\n');
    const second = await checkpointAcceptedTask({ workspace, prepared, evidenceDir, taskId: taskTwo, orderIndex: 2 });
    await writeFile(join(prepared.workdir, 'rollback.txt'), 'discard me\n');

    // Reverse the input to prove reconstruction follows declared topological order, not input order.
    const result = await rebuildWorkspace({
      workspace,
      prepared,
      originalBaseCommit: prepared.baseCommit,
      frozenTests,
      retainedTasks: [second, first],
      invalidatedTaskIds: [taskTwo],
    });

    expect(result.kind).toBe('rebuilt');
    if (result.kind !== 'rebuilt') return;
    expect(result.retainedTaskCommits.map((entry) => entry.taskId)).toEqual([taskOne]);
    expect(await readFile(join(prepared.workdir, 'frozen.test'), 'utf8')).toBe('frozen\n');
    expect(await readFile(join(prepared.workdir, 'one.txt'), 'utf8')).toBe('one\n');
    await expect(readFile(join(prepared.workdir, 'two.txt'))).rejects.toThrow();
    await expect(readFile(join(prepared.workdir, 'rollback.txt'))).rejects.toThrow();
    expect((await git(targetRepo, ['rev-parse', 'main'])).trim()).toBe(targetSha);

    const finalPatch = await captureFinalPatch({ workspace, prepared, originalBaseCommit: prepared.baseCommit, evidenceDir });
    const acceptedTree = (await git(prepared.workdir, ['rev-parse', 'HEAD^{tree}'])).trim();
    await workspace.restoreDetached(prepared, prepared.baseCommit);
    await workspace.applyBinaryPatch(prepared, finalPatch.patch.path);
    expect(await readFile(join(prepared.workdir, 'frozen.test'), 'utf8')).toBe('frozen\n');
    expect(await readFile(join(prepared.workdir, 'one.txt'), 'utf8')).toBe('one\n');
    const reconstructedTree = (await git(prepared.workdir, ['write-tree'])).trim();
    expect(reconstructedTree).toBe(acceptedTree);
    expect((await git(targetRepo, ['rev-parse', 'main'])).trim()).toBe(targetSha);
    await workspace.discard(prepared, { retain: false });
  });

  it('uses bytewise task-id order when retained checkpoints share an order index', async () => {
    const workspace = createWorkspaceProvider('worktree');
    const prepared = await workspace.prepare({ itemId, targetRepo, baseRef: 'main', workspacesDir, name: 'equal-index' });
    await writeFile(join(prepared.workdir, 'frozen.test'), 'frozen\n');
    const frozenTests = await checkpointFrozenTests({ workspace, prepared, evidenceDir });
    await writeFile(join(prepared.workdir, 'one.txt'), 'one\n');
    const first = await checkpointAcceptedTask({ workspace, prepared, evidenceDir, taskId: taskOne, orderIndex: 0 });
    await writeFile(join(prepared.workdir, 'two.txt'), 'two\n');
    const second = await checkpointAcceptedTask({ workspace, prepared, evidenceDir, taskId: taskTwo, orderIndex: 0 });

    // The reverse input must reconstruct in bytewise ID order, independent of host locale.
    const result = await rebuildWorkspace({
      workspace,
      prepared,
      originalBaseCommit: prepared.baseCommit,
      frozenTests,
      retainedTasks: [second, first],
      invalidatedTaskIds: [],
    });

    expect(result).toMatchObject({
      kind: 'rebuilt',
      retainedTaskCommits: [{ taskId: taskOne }, { taskId: taskTwo }],
    });
    expect(await readFile(join(prepared.workdir, 'one.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(join(prepared.workdir, 'two.txt'), 'utf8')).toBe('two\n');
    await workspace.discard(prepared, { retain: false });
  });

  it('returns a Planner escalation and leaves the original base tree on a patch conflict', async () => {
    const workspace = createWorkspaceProvider('worktree');
    const prepared = await workspace.prepare({ itemId, targetRepo, baseRef: 'main', workspacesDir, name: 'conflict' });
    const targetSha = (await git(targetRepo, ['rev-parse', 'main'])).trim();
    await writeFile(join(prepared.workdir, 'frozen.test'), 'frozen\n');
    const frozenTests = await checkpointFrozenTests({ workspace, prepared, evidenceDir });
    const invalidPatchPath = join(evidenceDir, 'invalid.patch');
    await writeFile(invalidPatchPath, 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-not-base\n+bad\n');

    const result = await rebuildWorkspace({
      workspace,
      prepared,
      originalBaseCommit: prepared.baseCommit,
      frozenTests: { ...frozenTests, patch: { ...frozenTests.patch, path: invalidPatchPath } },
      retainedTasks: [],
      invalidatedTaskIds: [],
    });

    expect(result.kind).toBe('planner-escalation');
    expect(await readFile(join(prepared.workdir, 'README.md'), 'utf8')).toBe('base\n');
    expect((await git(prepared.workdir, ['status', '--porcelain'])).trim()).toBe('');
    expect((await git(targetRepo, ['rev-parse', 'main'])).trim()).toBe(targetSha);
    await workspace.discard(prepared, { retain: false });
  });
});
