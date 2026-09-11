import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from '../core/canonical.js';
import { sha256Hex } from '../core/hash.js';
import type { EvidenceRef } from '../core/events.js';

/** Write canonical evidence durably before its event is appended. */
export async function writeBrownfieldEvidence(evidenceDir: string, value: unknown): Promise<EvidenceRef> {
  const body = Buffer.from(canonicalJson(value), 'utf8');
  const sha256 = sha256Hex(body);
  const path = join(evidenceDir, `${sha256}.json`);
  await mkdir(evidenceDir, { recursive: true });
  try {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const existing = await readFile(path);
    if (!existing.equals(body) || sha256Hex(existing) !== sha256) {
      throw new Error(`content-addressed evidence mismatch: ${path}`);
    }
  }
  return { sha256, path, bytes: body.byteLength };
}
