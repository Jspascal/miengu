import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalJson } from './canonical.js';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export async function sha256File(path: string): Promise<string> {
  const contents = await readFile(path);
  return sha256Hex(contents);
}
