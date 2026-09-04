import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, sha256Canonical, sha256File } from '../../src/core/hash.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('sha256Hex', () => {
  it('matches the known vector for the empty string', () => {
    expect(sha256Hex('')).toBe(EMPTY_SHA256);
  });

  it('matches the known vector for the empty Uint8Array', () => {
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
  });

  it('produces a 64-character lowercase hex digest', () => {
    const digest = sha256Hex('hello world');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256Canonical', () => {
  it('equals sha256Hex of the canonical JSON serialisation', () => {
    const value = { b: 1, a: 2 };
    expect(sha256Canonical(value)).toBe(sha256Hex('{"a":2,"b":1}'));
  });

  it('is independent of key insertion order', () => {
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }));
  });
});

describe('sha256File', () => {
  it('hashes file contents identically to sha256Hex', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'miengu-hash-'));
    const path = join(dir, 'fixture.txt');
    try {
      await writeFile(path, 'hello world', 'utf8');
      const fileHash = await sha256File(path);
      expect(fileHash).toBe(sha256Hex('hello world'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
