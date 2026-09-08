import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../core/hash.js';
import type { TaskId } from '../core/ids.js';
import type { PreparedWorkspace, WorkspaceProvider } from '../executors/isolation.js';

/** Stable locale-independent bytewise ordering for persisted task-id tie breaks. */
function compareTaskIdsBytewise(a: TaskId, b: TaskId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Durable, content-addressed patch evidence. The path is absolute and never overwritten. */
export interface PatchEvidence {
  readonly sha256: string;
  readonly path: string;
  readonly bytes: number;
  readonly files: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
}

export interface WorkspaceCheckpoint {
  readonly parentCommit: string;
  readonly commit: string;
  readonly patch: PatchEvidence;
}

export interface AcceptedTaskCheckpoint extends WorkspaceCheckpoint {
  readonly taskId: TaskId;
  readonly orderIndex: number;
}

export type RebuildResult =
  | {
      readonly kind: 'rebuilt';
      readonly baseCommit: string;
      readonly frozenTestsCommit: string;
      readonly retainedTaskCommits: readonly { readonly taskId: TaskId; readonly commit: string }[];
    }
  | {
      readonly kind: 'planner-escalation';
      readonly baseCommit: string;
      readonly detail: string;
    };

async function persistPatch(
  evidenceDir: string,
  patch: Buffer,
  metadata: { readonly filesTouched: readonly string[]; readonly insertions: number; readonly deletions: number },
): Promise<PatchEvidence> {
  const sha256 = sha256Hex(patch);
  const path = join(evidenceDir, `${sha256}.patch`);
  await mkdir(evidenceDir, { recursive: true });
  try {
    await writeFile(path, patch, { flag: 'wx' });
  } catch (err: unknown) {
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') throw err;
    const existing = await readFile(path);
    if (!existing.equals(patch)) {
      throw new Error(`content-addressed patch collision: ${path}`);
    }
  }
  return {
    sha256,
    path,
    bytes: patch.byteLength,
    files: metadata.filesTouched,
    insertions: metadata.insertions,
    deletions: metadata.deletions,
  };
}

async function createCheckpoint(i: {
  readonly workspace: WorkspaceProvider;
  readonly prepared: PreparedWorkspace;
  readonly evidenceDir: string;
}): Promise<WorkspaceCheckpoint> {
  const checkpoint = await i.workspace.checkpoint(i.prepared);
  return {
    parentCommit: checkpoint.parentCommit,
    commit: checkpoint.commit,
    patch: await persistPatch(i.evidenceDir, checkpoint.patch.patch, checkpoint.patch),
  };
}

/** Freezes the current test tree on detached HEAD and preserves its replayable binary patch. */
export async function checkpointFrozenTests(i: {
  readonly workspace: WorkspaceProvider;
  readonly prepared: PreparedWorkspace;
  readonly evidenceDir: string;
}): Promise<WorkspaceCheckpoint> {
  return createCheckpoint(i);
}

/** Commits one accepted task on detached HEAD and retains its parent-relative binary patch. */
export async function checkpointAcceptedTask(i: {
  readonly workspace: WorkspaceProvider;
  readonly prepared: PreparedWorkspace;
  readonly evidenceDir: string;
  readonly taskId: TaskId;
  readonly orderIndex: number;
}): Promise<AcceptedTaskCheckpoint> {
  return { ...(await createCheckpoint(i)), taskId: i.taskId, orderIndex: i.orderIndex };
}

/**
 * Reconstructs the frozen-test checkpoint and retained accepted tasks from their patches.
 * Any apply failure is deliberately not resolved here: reset to the original detached base
 * and return the typed result that routes the supervisor to Planner.
 */
export async function rebuildWorkspace(i: {
  readonly workspace: WorkspaceProvider;
  readonly prepared: PreparedWorkspace;
  readonly originalBaseCommit: string;
  readonly frozenTests: WorkspaceCheckpoint;
  readonly retainedTasks: readonly AcceptedTaskCheckpoint[];
  readonly invalidatedTaskIds: readonly TaskId[];
}): Promise<RebuildResult> {
  const invalidated = new Set(i.invalidatedTaskIds);
  const retained = i.retainedTasks
    .filter((task) => !invalidated.has(task.taskId))
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || compareTaskIdsBytewise(a.taskId, b.taskId));
  try {
    await i.workspace.restoreDetached(i.prepared, i.originalBaseCommit);
    await i.workspace.applyBinaryPatch(i.prepared, i.frozenTests.patch.path);
    const frozen = await i.workspace.checkpoint(i.prepared);
    const retainedTaskCommits: { taskId: TaskId; commit: string }[] = [];
    for (const task of retained) {
      await i.workspace.applyBinaryPatch(i.prepared, task.patch.path);
      const checkpoint = await i.workspace.checkpoint(i.prepared);
      retainedTaskCommits.push({ taskId: task.taskId, commit: checkpoint.commit });
    }
    return {
      kind: 'rebuilt',
      baseCommit: i.originalBaseCommit,
      frozenTestsCommit: frozen.commit,
      retainedTaskCommits,
    };
  } catch (err) {
    await i.workspace.restoreDetached(i.prepared, i.originalBaseCommit);
    return {
      kind: 'planner-escalation',
      baseCommit: i.originalBaseCommit,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Captures the complete accepted tree as a binary patch from the immutable original base. */
export async function captureFinalPatch(i: {
  readonly workspace: WorkspaceProvider;
  readonly prepared: PreparedWorkspace;
  readonly originalBaseCommit: string;
  readonly evidenceDir: string;
}): Promise<{
  readonly originalBaseCommit: string;
  readonly acceptedHeadCommit: string;
  readonly patch: PatchEvidence;
}> {
  const acceptedHeadCommit = (await i.workspace.capture(i.prepared)).headCommit;
  const captured = await i.workspace.captureBinaryPatch(
    i.prepared,
    i.originalBaseCommit,
    acceptedHeadCommit,
  );
  return {
    originalBaseCommit: i.originalBaseCommit,
    acceptedHeadCommit,
    patch: await persistPatch(i.evidenceDir, captured.patch, captured),
  };
}
