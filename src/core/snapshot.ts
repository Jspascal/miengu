import { mkdir, open as fsOpen, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logging.js';
import { silentLogger } from '../logging.js';
import type { EventId, WorkItemId } from './ids.js';

export interface SnapshotEnvelope<S> {
  readonly projection_version: number;
  readonly item_id: WorkItemId;
  readonly seq: number;
  readonly event_id: EventId;
  readonly state_hash: string;
  readonly state: S;
}

export interface SnapshotStore<S> {
  latestValid(o: {
    lastSeq: number;
    eventIdAt(seq: number): Promise<EventId | null>;
  }): Promise<SnapshotEnvelope<S> | null>;
  write(env: SnapshotEnvelope<S>): Promise<void>;
  prune(keep: number): Promise<void>;
  dropAbove(seq: number): Promise<void>;
}

export interface CreateSnapshotStoreOptions<S> {
  readonly dir: string;
  readonly itemId: WorkItemId;
  readonly projectionVersion: number;
  hashState(s: S): string;
  parseState(v: unknown): S;
  /** Operational log sink for rejected-snapshot diagnostics. Defaults to silent. */
  readonly logger?: Logger;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

async function fsyncDir(dirPath: string): Promise<void> {
  const dh = await fsOpen(dirPath, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

export function createSnapshotStore<S>(o: CreateSnapshotStoreOptions<S>): SnapshotStore<S> {
  const logger = o.logger ?? silentLogger;

  function pathFor(seq: number): string {
    return join(o.dir, `${String(seq)}.json`);
  }

  async function listSeqsDescending(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(o.dir);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    const seqs: number[] = [];
    for (const entry of entries) {
      const match = /^(\d+)\.json$/.exec(entry);
      const seqPart = match?.[1];
      if (seqPart !== undefined) {
        seqs.push(Number.parseInt(seqPart, 10));
      }
    }
    return seqs.sort((a, b) => b - a);
  }

  async function readCandidate(seq: number): Promise<Record<string, unknown> | null> {
    let raw: string;
    try {
      raw = await readFile(pathFor(seq), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return {
    async latestValid(ctx) {
      const seqs = await listSeqsDescending();
      for (const seq of seqs) {
        const candidate = await readCandidate(seq);
        if (candidate === null) {
          logger.debug({ seq }, 'snapshot rejected: unreadable or malformed JSON');
          continue;
        }
        if (candidate['projection_version'] !== o.projectionVersion) {
          logger.debug({ seq }, 'snapshot rejected: projection_version mismatch');
          continue;
        }

        let state: S;
        try {
          state = o.parseState(candidate['state']);
        } catch {
          logger.debug({ seq }, 'snapshot rejected: parseState failed');
          continue;
        }

        let hash: string;
        try {
          hash = o.hashState(state);
        } catch {
          logger.debug({ seq }, 'snapshot rejected: hashState failed');
          continue;
        }
        if (hash !== candidate['state_hash']) {
          logger.debug({ seq }, 'snapshot rejected: state_hash mismatch');
          continue;
        }

        const expectedEventId = await ctx.eventIdAt(seq);
        if (expectedEventId === null || expectedEventId !== candidate['event_id']) {
          logger.debug({ seq }, 'snapshot rejected: event_id does not match the log');
          continue;
        }

        return {
          projection_version: o.projectionVersion,
          item_id: o.itemId,
          seq,
          event_id: expectedEventId,
          state_hash: hash,
          state,
        };
      }
      return null;
    },

    async write(env) {
      await mkdir(o.dir, { recursive: true });
      const target = pathFor(env.seq);
      const tmp = `${target}.tmp-${String(process.pid)}-${String(Math.random()).slice(2)}`;
      const fh = await fsOpen(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(env), 'utf8');
        await fh.datasync();
      } finally {
        await fh.close();
      }
      await rename(tmp, target);
      await fsyncDir(o.dir);
    },

    async prune(keep) {
      const seqs = await listSeqsDescending();
      for (const seq of seqs.slice(keep)) {
        await rm(pathFor(seq), { force: true });
      }
    },

    async dropAbove(seq) {
      const seqs = await listSeqsDescending();
      for (const s of seqs) {
        if (s > seq) {
          await rm(pathFor(s), { force: true });
        }
      }
    },
  };
}
