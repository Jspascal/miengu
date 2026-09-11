import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '../../src/core/hash.js';
import { writeBrownfieldEvidence } from '../../src/brownfield/evidence.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('writeBrownfieldEvidence', () => {
  it('writes canonical content-addressed evidence before returning its reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-evidence-')); roots.push(root);
    const reference = await writeBrownfieldEvidence(root, { z: 1, a: ['x'] });
    expect(reference.sha256).toBe(sha256Hex('{"a":["x"],"z":1}'));
    expect(reference.bytes).toBe(Buffer.byteLength('{"a":["x"],"z":1}'));
    expect(await readFile(reference.path, 'utf8')).toBe('{"a":["x"],"z":1}');
  });

  it('rehashes an existing attachment instead of trusting its path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-evidence-')); roots.push(root);
    const body = '{"a":1}'; const path = join(root, `${sha256Hex(body)}.json`);
    await (await import('node:fs/promises')).mkdir(root, { recursive: true });
    await writeFile(path, '{"x":1}');
    await expect(writeBrownfieldEvidence(root, { a: 1 })).rejects.toThrow(/evidence mismatch/);
  });
});
