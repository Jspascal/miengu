import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeContentHash,
  freezeTests,
  restoreFrozenTests,
  verifyFrozenTests,
} from '../../src/supervisor/freeze.js';
import type { FrozenFile } from '../../src/supervisor/freeze.js';
import { SuiteIdSchema } from '../../src/core/ids.js';
import type { FrozenTestsState } from '../../src/state/workitem.js';
import type { IsoTimestamp } from '../../src/core/clock.js';

const suiteId = SuiteIdSchema.parse('suite-example-1');

let root: string;
let workdir: string;
let frozenCopyDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'miengu-freeze-'));
  workdir = join(root, 'workdir');
  frozenCopyDir = join(root, 'frozen-tests');
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeCase(relPath: string, contents: string): Promise<void> {
  const absolute = join(workdir, relPath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents);
}

describe('computeContentHash', () => {
  it('is stable across two calls for the same files', () => {
    const files: FrozenFile[] = [
      { path: 'test/a.test.ts', sha256: 'aaa', bytes: 3 },
      { path: 'test/b.test.ts', sha256: 'bbb', bytes: 3 },
    ];
    expect(computeContentHash(files)).toBe(computeContentHash(files));
  });

  it('is stable across file ordering', () => {
    const files: FrozenFile[] = [
      { path: 'test/a.test.ts', sha256: 'aaa', bytes: 3 },
      { path: 'test/b.test.ts', sha256: 'bbb', bytes: 3 },
    ];
    expect(computeContentHash(files)).toBe(computeContentHash([...files].reverse()));
  });
});

describe('freezeTests', () => {
  it('copies each declared path, hashes it, and returns a stable content_hash', async () => {
    await writeCase('test/a.test.ts', 'A');
    await writeCase('test/b.test.ts', 'B');
    await writeCase('test/c.test.ts', 'C');

    const result = await freezeTests({
      workdir,
      frozenCopyDir,
      paths: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
      suiteId,
    });

    expect(result.files).toHaveLength(3);
    expect(result.contentHash).toBe(computeContentHash(result.files));

    const reversed = await freezeTests({
      workdir,
      frozenCopyDir: join(root, 'frozen-tests-2'),
      paths: ['test/c.test.ts', 'test/b.test.ts', 'test/a.test.ts'],
      suiteId,
    });
    expect(reversed.contentHash).toBe(result.contentHash);

    const copied = await readFile(join(frozenCopyDir, 'test/a.test.ts'), 'utf8');
    expect(copied).toBe('A');
  });

  it('refuses a declared path missing from the worktree', async () => {
    await expect(
      freezeTests({ workdir, frozenCopyDir, paths: ['test/missing.test.ts'], suiteId }),
    ).rejects.toThrow(/missing/);
  });

  it('refuses a declared path that escapes the worktree', async () => {
    await expect(
      freezeTests({ workdir, frozenCopyDir, paths: ['../outside.test.ts'], suiteId }),
    ).rejects.toThrow(/escapes/);
  });
});

describe('verifyFrozenTests / restoreFrozenTests', () => {
  async function frozenState(): Promise<FrozenTestsState> {
    await writeCase('test/a.test.ts', 'A');
    await writeCase('test/b.test.ts', 'B');
    const frozen = await freezeTests({
      workdir,
      frozenCopyDir,
      paths: ['test/a.test.ts', 'test/b.test.ts'],
      suiteId,
    });
    return {
      suiteId,
      contentHash: frozen.contentHash,
      files: frozen.files,
      frozenCopyDir,
      at: '2024-01-01T00:00:00.000Z' as IsoTimestamp,
    };
  }

  it('reports intact when nothing changed', async () => {
    const frozen = await frozenState();
    expect(await verifyFrozenTests({ workdir, frozen })).toEqual({ kind: 'intact' });
  });

  it('names only the mutated path on a single-byte mutation', async () => {
    const frozen = await frozenState();
    await writeFile(join(workdir, 'test/a.test.ts'), 'X');

    const result = await verifyFrozenTests({ workdir, frozen });
    expect(result.kind).toBe('tampered');
    if (result.kind === 'tampered') {
      expect(result.paths).toEqual(['test/a.test.ts']);
    }
  });

  it('names a deleted file', async () => {
    const frozen = await frozenState();
    await rm(join(workdir, 'test/b.test.ts'));

    const result = await verifyFrozenTests({ workdir, frozen });
    expect(result.kind).toBe('tampered');
    if (result.kind === 'tampered') {
      expect(result.paths).toEqual(['test/b.test.ts']);
    }
  });

  it('restores byte-for-byte after tampering, and verify then reports intact', async () => {
    const frozen = await frozenState();
    await writeFile(join(workdir, 'test/a.test.ts'), 'TAMPERED');
    await rm(join(workdir, 'test/b.test.ts'));

    await restoreFrozenTests({ workdir, frozen });

    expect(await readFile(join(workdir, 'test/a.test.ts'), 'utf8')).toBe('A');
    expect(await readFile(join(workdir, 'test/b.test.ts'), 'utf8')).toBe('B');
    expect(await verifyFrozenTests({ workdir, frozen })).toEqual({ kind: 'intact' });
  });
});
