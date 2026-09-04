import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { EventIdSchema, RunIdSchema, WorkItemIdSchema } from './ids.js';
import type { EventId, RunId, WorkItemId, Slug } from './ids.js';

export interface Rng {
  uuid(): string;
  base36(len: number): string;
}

function bigIntToBase36(value: bigint, len: number): string {
  return value.toString(36).padStart(len, '0').slice(-len);
}

export const systemRng: Rng = {
  uuid(): string {
    return randomUUID();
  },
  base36(len: number): string {
    const bytes = randomBytes(16);
    const big = BigInt(`0x${bytes.toString('hex')}`);
    return bigIntToBase36(big, len);
  },
};

export function fixedRng(seed: string): Rng {
  let counter = 0;

  function digest(label: string): string {
    counter += 1;
    return createHash('sha256').update(`${seed}:${label}:${String(counter)}`).digest('hex');
  }

  return {
    uuid(): string {
      const hex = digest('uuid').slice(0, 32);
      return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
      ].join('-');
    },
    base36(len: number): string {
      const hex = digest('base36');
      const big = BigInt(`0x${hex}`);
      return bigIntToBase36(big, len);
    },
  };
}

export interface IdMinter {
  eventId(): EventId;
  runId(): RunId;
  sessionUuid(): string;
  workItemId(slug: Slug): WorkItemId;
}

export function createIdMinter(rng: Rng): IdMinter {
  return {
    eventId(): EventId {
      return EventIdSchema.parse(`evt-${rng.uuid()}`);
    },
    runId(): RunId {
      return RunIdSchema.parse(`run-${rng.uuid()}`);
    },
    sessionUuid(): string {
      return rng.uuid();
    },
    workItemId(slug: Slug): WorkItemId {
      return WorkItemIdSchema.parse(`wi-${slug}-${rng.base36(6)}`);
    },
  };
}
