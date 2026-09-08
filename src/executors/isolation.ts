import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { assertNever } from '../core/events.js';
import type { TargetMode } from '../core/events.js';
import { sha256Hex } from '../core/hash.js';
import type { WorkItemId } from '../core/ids.js';
import { NotImplementedError, WorkspaceError } from '../errors.js';

const execFileAsync = promisify(execFile);

export const MIENGU_WORKSPACE_PREFIX = 'miengu';
const SUPERVISOR_CHECKPOINT_MESSAGE = 'miengu supervisor checkpoint';
const SUPERVISOR_CHECKPOINT_DATE = '1970-01-01T00:00:00Z';

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
  /** Exact pre-invocation bytes used to restore untracked and ignored files. */
  untrackedFiles: readonly {
    readonly path: string;
    readonly contentsBase64: string;
  }[];
  /** Binary-safe patch from `headCommit` to the captured tracked working tree. */
  trackedPatchBase64: string;
  filesTouched: readonly string[];
  untracked: readonly string[];
  insertions: number;
  deletions: number;
  committedDuringRun: boolean;
  headCommit: string;
}

export interface BinaryPatchCapture {
  readonly patch: Buffer;
  readonly sha256: string;
  readonly filesTouched: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
}

export interface SupervisorCheckpoint {
  readonly parentCommit: string;
  readonly commit: string;
  readonly patch: BinaryPatchCapture;
}

export interface WorkspaceProvider {
  readonly mode: TargetMode;
  /** Restores the index, tracked tree, and all untracked/ignored bytes to a capture. */
  restore(
    ws: PreparedWorkspace,
    baseline: CaptureResult,
  ): Promise<{ restoredFully: boolean }>;
  prepare(i: {
    itemId: WorkItemId;
    targetRepo: string;
    baseRef: string;
    workspacesDir: string;
    name: string;
  }): Promise<PreparedWorkspace>;
  /** `beforeHeadCommit` is the HEAD captured immediately before one executor invocation. */
  capture(ws: PreparedWorkspace, o?: { beforeHeadCommit?: string }): Promise<CaptureResult>;
  /** Restores the detached worktree exactly to `commit`, including untracked cleanup. */
  restoreDetached(ws: PreparedWorkspace, commit: string): Promise<void>;
  /** Captures a replayable binary patch between two commits without moving any ref. */
  captureBinaryPatch(
    ws: PreparedWorkspace,
    fromCommit: string,
    toCommit?: string,
  ): Promise<BinaryPatchCapture>;
  /** Applies a binary patch to the detached worktree index and working tree. */
  applyBinaryPatch(ws: PreparedWorkspace, patchPath: string): Promise<void>;
  /** Commits the current detached tree under the fixed supervisor identity. */
  checkpoint(ws: PreparedWorkspace): Promise<SupervisorCheckpoint>;
  discard(ws: PreparedWorkspace, o: { retain: boolean }): Promise<void>;
}

function isExecFileError(err: unknown): err is { stderr?: string } {
  return err instanceof Error && 'stderr' in err;
}

/** Runs `git -C <cwd> <args>` via `execFile` with array args. Never `shell: true`. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: SUPERVISOR_CHECKPOINT_DATE,
        GIT_COMMITTER_DATE: SUPERVISOR_CHECKPOINT_DATE,
      },
    });
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

/** Like `git`, but preserves the bytes of `git diff --binary` output. */
async function gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'buffer' });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (err) {
    const stderr = isExecFileError(err) ? (err.stderr ?? '') : '';
    throw new WorkspaceError(`git ${args.join(' ')} failed in ${cwd}`, { cwd, args, stderr });
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

    async capture(ws, o = {}) {
      const headCommit = (await git(ws.workdir, ['rev-parse', 'HEAD'])).trim();
      const trackedPatch = await gitBuffer(ws.workdir, [
        'diff', '--binary', '--full-index', '--no-color', 'HEAD',
      ]);
      const diff = trackedPatch.toString('utf8');
      const numstat = await git(ws.workdir, ['diff', '--numstat', 'HEAD']);
      const untrackedOutput = await git(ws.workdir, [
        'ls-files',
        '--others',
        '--exclude-standard',
      ]);
      // `--exclude-standard` deliberately omits ignored paths.  Ignored output is still a
      // workspace mutation (and can be executable code or a frozen test), so capture it in
      // the same baseline as ordinary untracked output.
      const ignoredOutput = await git(ws.workdir, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
      ]);
      const { filesTouched, insertions, deletions } = parseNumstat(numstat);
      const untracked = [...new Set([
        ...untrackedOutput.split('\n'),
        ...ignoredOutput.split('\n'),
      ].filter((line) => line.length > 0))].sort();

      // Sorted so the hash is order-independent; `\u0000` separates path from bytes so a
      // path/content boundary cannot be forged by a crafted filename.
      const untrackedFiles: { path: string; contentsBase64: string }[] = [];
      for (const relativePath of [...untracked].sort()) {
        let bytes: Buffer;
        try {
          bytes = await readFile(join(ws.workdir, relativePath));
        } catch {
          bytes = Buffer.alloc(0);
        }
        untrackedFiles.push({ path: relativePath, contentsBase64: bytes.toString('base64') });
      }

      return {
        diff,
        diffSha256: sha256Hex(trackedPatch),
        untrackedSha256: sha256Hex(
          untrackedFiles.map((file) => `${file.path}\u0000${file.contentsBase64}`).join('\u0000\u0000'),
        ),
        untrackedFiles,
        trackedPatchBase64: trackedPatch.toString('base64'),
        filesTouched,
        untracked,
        insertions,
        deletions,
        // A detached supervisor checkpoint is legitimate. Only a HEAD move made by the
        // executor invocation itself is a violation, so compare against that invocation's
        // pre-run HEAD when it is available.
        committedDuringRun: headCommit !== (o.beforeHeadCommit ?? ws.baseCommit),
        headCommit,
      };
    },

    async restore(ws, baseline) {
      // The executor may have changed both the working tree and the index. Reset both to the
      // invocation-start HEAD, remove every untracked/ignored path, then reconstruct the exact
      // pre-invocation tracked patch and untracked bytes.
      await git(ws.workdir, ['reset', '--hard', baseline.headCommit]);
      await git(ws.workdir, ['clean', '-ffdx']);

      const trackedPatch = Buffer.from(baseline.trackedPatchBase64, 'base64');
      if (trackedPatch.length > 0) {
        const tempDir = await mkdtemp(join(tmpdir(), 'miengu-sandbox-restore-'));
        const patchPath = join(tempDir, 'baseline.patch');
        try {
          await writeFile(patchPath, trackedPatch);
          await git(ws.workdir, ['apply', '--binary', patchPath]);
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }

      for (const file of baseline.untrackedFiles) {
        const destination = join(ws.workdir, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(file.contentsBase64, 'base64'));
      }

      const after = await this.capture(ws);
      return {
        restoredFully:
          after.headCommit === baseline.headCommit &&
          after.diffSha256 === baseline.diffSha256 &&
          after.untrackedSha256 === baseline.untrackedSha256,
      };
    },

    async restoreDetached(ws, commit) {
      // This worktree was created with `--detach`; checkout and reset operate only on its
      // detached HEAD and cannot advance the operator's target branch.
      await git(ws.workdir, ['checkout', '--detach', commit]);
      await git(ws.workdir, ['reset', '--hard', commit]);
      await git(ws.workdir, ['clean', '-ffdx']);
    },

    async captureBinaryPatch(ws, fromCommit, toCommit = 'HEAD') {
      const patch = await gitBuffer(ws.workdir, [
        'diff', '--binary', '--full-index', '--no-color', fromCommit, toCommit,
      ]);
      const numstat = await git(ws.workdir, ['diff', '--numstat', fromCommit, toCommit]);
      const parsed = parseNumstat(numstat);
      return {
        patch,
        sha256: sha256Hex(patch),
        filesTouched: parsed.filesTouched,
        insertions: parsed.insertions,
        deletions: parsed.deletions,
      };
    },

    async applyBinaryPatch(ws, patchPath) {
      await git(ws.workdir, ['apply', '--binary', '--index', '--whitespace=nowarn', patchPath]);
    },

    async checkpoint(ws) {
      const parentCommit = (await git(ws.workdir, ['rev-parse', 'HEAD'])).trim();
      // `add --all` deliberately includes newly-created tests and files before capturing
      // the patch. The commit remains reachable only from this detached worktree.
      await git(ws.workdir, ['add', '--all']);
      const patchBytes = await gitBuffer(ws.workdir, ['diff', '--cached', '--binary', '--full-index', '--no-color']);
      const numstat = await git(ws.workdir, ['diff', '--cached', '--numstat']);
      const parsed = parseNumstat(numstat);
      await git(ws.workdir, [
        '-c', 'user.name=miengu-supervisor',
        '-c', 'user.email=miengu-supervisor@local',
        'commit', '--no-gpg-sign', '--allow-empty', '-m', SUPERVISOR_CHECKPOINT_MESSAGE,
      ]);
      const commit = (await git(ws.workdir, ['rev-parse', 'HEAD'])).trim();
      return {
        parentCommit,
        commit,
        patch: {
          patch: patchBytes,
          sha256: sha256Hex(patchBytes),
          filesTouched: parsed.filesTouched,
          insertions: parsed.insertions,
          deletions: parsed.deletions,
        },
      };
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
