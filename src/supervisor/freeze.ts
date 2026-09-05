import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { SuiteId } from '../core/ids.js';
import { canonicalJson } from '../core/canonical.js';
import { sha256Hex } from '../core/hash.js';
import { AgentError } from '../errors.js';
import type { FrozenTestsState } from '../state/workitem.js';

export interface FrozenFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * PURE. §3.6's normative `content_hash` definition:
 * `sha256Hex(canonicalJson(files.map(f => [f.path, f.sha256]).sort(byPathAscending)))`.
 * Order-independent of the caller's listing order, stable across platforms, and
 * recomputable from the `TestsFrozen` event alone.
 */
export function computeContentHash(files: readonly FrozenFile[]): string {
  const pairs = files
    .map((f) => [f.path, f.sha256] as const)
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(canonicalJson(pairs));
}

/** Resolves `relPath` under `root`, throwing `AgentError` if it escapes `root` (path traversal). */
function resolveInside(root: string, relPath: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, relPath);
  const rel = relative(absoluteRoot, absolute);
  if (rel.startsWith('..') || resolve(absoluteRoot, rel) !== absolute) {
    throw new AgentError(`declared test path escapes the worktree: "${relPath}"`, {
      root: absoluteRoot,
      path: relPath,
    });
  }
  return absolute;
}

async function readFileOrThrow(absolute: string, relPath: string): Promise<Buffer> {
  try {
    return await readFile(absolute);
  } catch (err) {
    throw new AgentError(`declared test path is missing: "${relPath}"`, {
      path: relPath,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Copies each declared test path from `workdir` into `frozenCopyDir`, hashing each file as
 * it is copied, and returns the `TestsFrozen` payload materials. Refuses a declared path
 * that is missing or resolves outside `workdir` (path traversal) with `AgentError`. Does
 * not read the clock — `frozen_at` is derived from the `TestsFrozen` event, never from a
 * fresh clock read here.
 */
export async function freezeTests(i: {
  readonly workdir: string;
  readonly frozenCopyDir: string;
  readonly paths: readonly string[];
  readonly suiteId: SuiteId;
}): Promise<{ readonly contentHash: string; readonly files: readonly FrozenFile[] }> {
  const files: FrozenFile[] = [];
  for (const relPath of i.paths) {
    const absolute = resolveInside(i.workdir, relPath);
    const bytes = await readFileOrThrow(absolute, relPath);
    const dest = resolveInside(i.frozenCopyDir, relPath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    files.push({ path: relPath, sha256: sha256Hex(bytes), bytes: bytes.length });
  }
  return { contentHash: computeContentHash(files), files };
}

export type VerifyResult =
  | { readonly kind: 'intact' }
  | { readonly kind: 'tampered'; readonly observedHash: string; readonly paths: readonly string[] };

/**
 * Re-hashes the frozen files against the current worktree. Returns only the differing or
 * missing paths, never the whole list — §15.4/§15.5's "the tests are the specification"
 * demands the supervisor be able to name exactly what changed, not merely that something did.
 */
export async function verifyFrozenTests(i: {
  readonly workdir: string;
  readonly frozen: FrozenTestsState;
}): Promise<VerifyResult> {
  const differing: string[] = [];
  const observed: FrozenFile[] = [];
  for (const file of i.frozen.files) {
    const absolute = join(i.workdir, file.path);
    let currentSha: string;
    let currentBytes: number;
    try {
      const bytes = await readFile(absolute);
      currentSha = sha256Hex(bytes);
      currentBytes = bytes.length;
    } catch {
      currentSha = 'missing';
      currentBytes = 0;
      differing.push(file.path);
    }
    if (currentSha !== file.sha256 && currentSha !== 'missing') {
      differing.push(file.path);
    }
    observed.push({ path: file.path, sha256: currentSha, bytes: currentBytes });
  }

  if (differing.length === 0) {
    return { kind: 'intact' };
  }
  return { kind: 'tampered', observedHash: computeContentHash(observed), paths: differing };
}

/** Byte-for-byte restore from `frozen.frozenCopyDir` into `workdir`, recreating deleted files. */
export async function restoreFrozenTests(i: {
  readonly workdir: string;
  readonly frozen: FrozenTestsState;
}): Promise<void> {
  for (const file of i.frozen.files) {
    const source = join(i.frozen.frozenCopyDir, file.path);
    const dest = join(i.workdir, file.path);
    const bytes = await readFile(source);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
}
