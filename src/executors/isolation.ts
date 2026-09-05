import { execFile } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertNever } from '../core/events.js';
import type { TargetMode } from '../core/events.js';
import { sha256Hex } from '../core/hash.js';
import type { WorkItemId } from '../core/ids.js';
import { NotImplementedError, WorkspaceError } from '../errors.js';

const execFileAsync = promisify(execFile);

export const MIENGU_WORKSPACE_PREFIX = 'miengu';

export interface PreparedWorkspace {
  mode: TargetMode;
  targetRepo: string;
  workdir: string;
  baseRef: string;
  baseCommit: string;
}

export interface CaptureResult {
  diff: string;
  diffSha256: string;
  /**
   * sha256 over every untracked file's path AND bytes.
   *
   * `diffSha256` covers tracked files only (`git diff HEAD`) and `untracked` carries names
   * only (`git ls-files --others`), so a rewrite of an existing untracked file changes
   * neither. Untracked is precisely the category the Test Author creates, so without this a
   * read-only stage could rewrite a frozen test undetected. Sandbox enforcement compares
   * this alongside `diffSha256`.
   */
  untrackedSha256: string;
  filesTouched: readonly string[];
  untracked: readonly string[];
  insertions: number;
  deletions: number;
  committedDuringRun: boolean;
  headCommit: string;
}

export interface WorkspaceProvider {
  readonly mode: TargetMode;
  /**
   * Reverts tracked modifications and deletes any untracked file NOT named in
   * `keepUntracked`, restoring the workspace toward a known-good capture.
   *
   * Used when a `read-only` stage is caught modifying the workspace. Without it the illegal
   * write stays on disk and becomes the baseline every later comparison is made against, so
   * the control is bypassable in one retry. `restoredFully` is `false` when a pre-existing
   * untracked file's BYTES changed — git cannot restore content it never tracked, and the
   * caller must say so rather than imply a clean revert.
   */
  restore(
    ws: PreparedWorkspace,
    o: { keepUntracked: readonly string[]; expectUntrackedSha256: string },
  ): Promise<{ restoredFully: boolean }>;
  prepare(i: {
    itemId: WorkItemId;
    targetRepo: string;
    baseRef: string;
    workspacesDir: string;
    name: string;
  }): Promise<PreparedWorkspace>;
  capture(ws: PreparedWorkspace): Promise<CaptureResult>;
  discard(ws: PreparedWorkspace, o: { retain: boolean }): Promise<void>;
}

function isExecFileError(err: unknown): err is { stderr?: string } {
  return err instanceof Error && 'stderr' in err;
}

/** Runs `git -C <cwd> <args>` via `execFile` with array args. Never `shell: true`. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
    return stdout;
  } catch (err) {
    const stderr = isExecFileError(err) ? (err.stderr ?? '') : '';
    throw new WorkspaceError(`git ${args.join(' ')} failed in ${cwd}`, {
      cwd,
      args,
      stderr,
    });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseNumstat(numstat: string): {
  filesTouched: string[];
  insertions: number;
  deletions: number;
} {
  const filesTouched: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const [insPart, delPart, path] = line.split('\t');
    if (path === undefined) {
      continue;
    }
    filesTouched.push(path);
    if (insPart !== undefined && insPart !== '-') {
      insertions += Number.parseInt(insPart, 10);
    }
    if (delPart !== undefined && delPart !== '-') {
      deletions += Number.parseInt(delPart, 10);
    }
  }
  return { filesTouched, insertions, deletions };
}

function createWorktreeProvider(): WorkspaceProvider {
  return {
    mode: 'worktree',

    async prepare(i) {
      const inside = (await git(i.targetRepo, ['rev-parse', '--is-inside-work-tree'])).trim();
      if (inside !== 'true') {
        throw new WorkspaceError(`target repo is not a git working tree: ${i.targetRepo}`, {
          targetRepo: i.targetRepo,
        });
      }

      let baseCommit: string;
      try {
        baseCommit = (
          await git(i.targetRepo, ['rev-parse', '--verify', `${i.baseRef}^{commit}`])
        ).trim();
      } catch {
        throw new WorkspaceError(`baseRef is not resolvable: ${i.baseRef}`, {
          targetRepo: i.targetRepo,
          baseRef: i.baseRef,
        });
      }

      const workdir = join(i.workspacesDir, i.name);
      if (await pathExists(workdir)) {
        throw new WorkspaceError(`workspace workdir already exists: ${workdir}`, { workdir });
      }

      await git(i.targetRepo, ['worktree', 'add', '--detach', workdir, baseCommit]);

      return {
        mode: 'worktree',
        targetRepo: i.targetRepo,
        workdir,
        baseRef: i.baseRef,
        baseCommit,
      };
    },

    async capture(ws) {
      const headCommit = (await git(ws.workdir, ['rev-parse', 'HEAD'])).trim();
      const diff = await git(ws.workdir, ['diff', '--no-color', 'HEAD']);
      const numstat = await git(ws.workdir, ['diff', '--numstat', 'HEAD']);
      const untrackedOutput = await git(ws.workdir, [
        'ls-files',
        '--others',
        '--exclude-standard',
      ]);
      const { filesTouched, insertions, deletions } = parseNumstat(numstat);
      const untracked = untrackedOutput.split('\n').filter((line) => line.length > 0);

      // Sorted so the hash is order-independent; `\u0000` separates path from bytes so a
      // path/content boundary cannot be forged by a crafted filename.
      const untrackedParts: string[] = [];
      for (const relativePath of [...untracked].sort()) {
        let bytes: string;
        try {
          bytes = await readFile(join(ws.workdir, relativePath), 'utf8');
        } catch {
          bytes = '';
        }
        untrackedParts.push(`${relativePath}\u0000${bytes}`);
      }

      return {
        diff,
        diffSha256: sha256Hex(diff),
        untrackedSha256: sha256Hex(untrackedParts.join('\u0000\u0000')),
        filesTouched,
        untracked,
        insertions,
        deletions,
        committedDuringRun: headCommit !== ws.baseCommit,
        headCommit,
      };
    },

    async restore(ws, o) {
      await git(ws.workdir, ['checkout', '--', '.']);

      const keep = new Set(o.keepUntracked);
      const untrackedOutput = await git(ws.workdir, [
        'ls-files',
        '--others',
        '--exclude-standard',
      ]);
      for (const relativePath of untrackedOutput.split('\n').filter((l) => l.length > 0)) {
        if (!keep.has(relativePath)) {
          await rm(join(ws.workdir, relativePath), { force: true });
        }
      }

      // A kept untracked file whose bytes were rewritten cannot be restored from git — it was
      // never tracked. Report it instead of pretending the revert was complete.
      const after = await this.capture(ws);
      return { restoredFully: after.untrackedSha256 === o.expectUntrackedSha256 };
    },

    async discard(ws, o) {
      if (o.retain) {
        return;
      }
      await git(ws.targetRepo, ['worktree', 'remove', '--force', ws.workdir]);
    },
  };
}

// 'clone' arm exists so adding it later is one new provider factory, not a signature change.
export function createWorkspaceProvider(mode: TargetMode): WorkspaceProvider {
  switch (mode) {
    case 'worktree':
      return createWorktreeProvider();
    case 'clone':
      throw new NotImplementedError('target.mode=clone', 1);
    default:
      return assertNever(mode);
  }
}
