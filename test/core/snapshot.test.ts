import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshotStore } from '../../src/core/snapshot.js';
import type { SnapshotEnvelope } from '../../src/core/snapshot.js';
import { WorkItemIdSchema, EventIdSchema } from '../../src/core/ids.js';
import type { WorkItemId, EventId } from '../../src/core/ids.js';

interface State {
  readonly count: number;
}

function hashState(s: State): string {
  return `hash:${String(s.count)}`;
}

function parseState(v: unknown): State {
  if (v === null || typeof v !== 'object' || !('count' in v) || typeof v.count !== 'number') {
    throw new Error('invalid state');
  }
  return { count: v.count };
}

const itemId: WorkItemId = WorkItemIdSchema.parse('wi-example-abc123');

function eventId(n: number): EventId {
  const hex = n.toString(16).padStart(12, '0');
  return EventIdSchema.parse(`evt-00000000-0000-0000-0000-${hex}`);
}

function envelope(seq: number, count: number, overrides: Partial<SnapshotEnvelope<State>> = {}) {
  const state: State = { count };
  return {
    projection_version: 1,
    item_id: itemId,
    seq,
    event_id: eventId(seq),
    state_hash: hashState(state),
    state,
    ...overrides,
  } satisfies SnapshotEnvelope<State>;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'miengu-snapshot-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStore() {
  return createSnapshotStore<State>({
    dir,
    itemId,
    projectionVersion: 1,
    hashState,
    parseState,
  });
}

function logAt(seqToEventId: Map<number, EventId>) {
  return {
    async eventIdAt(seq: number): Promise<EventId | null> {
      return seqToEventId.get(seq) ?? null;
    },
  };
}

describe('createSnapshotStore', () => {
  it('writes and reads back a valid snapshot', async () => {
    const store = makeStore();
    const env = envelope(10, 5);
    await store.write(env);

    const log = logAt(new Map([[10, eventId(10)]]));
    const result = await store.latestValid({ lastSeq: 10, ...log });
    expect(result).toEqual(env);
  });

  it('rejects a tampered state_hash and falls back to the next-older valid snapshot', async () => {
    const store = makeStore();
    const older = envelope(5, 2);
    await store.write(older);
    const tampered = envelope(10, 5, { state_hash: 'sha256:tampered' });
    await store.write(tampered);

    const log = logAt(
      new Map([
        [5, eventId(5)],
        [10, eventId(10)],
      ]),
    );
    const result = await store.latestValid({ lastSeq: 10, ...log });
    expect(result).toEqual(older);
  });

  it('rejects a stale projection_version', async () => {
    const store = makeStore();
    const stale = envelope(10, 5, { projection_version: 0 });
    await store.write(stale);

    const log = logAt(new Map([[10, eventId(10)]]));
    const result = await store.latestValid({ lastSeq: 10, ...log });
    expect(result).toBeNull();
  });

  it('rejects a snapshot whose event_id does not match the log at that seq', async () => {
    const store = makeStore();
    const env = envelope(10, 5);
    await store.write(env);

    const log = logAt(new Map([[10, eventId(999)]]));
    const result = await store.latestValid({ lastSeq: 10, ...log });
    expect(result).toBeNull();
  });

  it('rejects a snapshot whose state fails parseState', async () => {
    const store = makeStore();
    const env = envelope(10, 5, { state: { bogus: true } as unknown as State });
    await store.write(env);

    const log = logAt(new Map([[10, eventId(10)]]));
    const result = await store.latestValid({ lastSeq: 10, ...log });
    expect(result).toBeNull();
  });

  it('never throws for an invalid snapshot; it returns null (or an older valid one) instead', async () => {
    const store = makeStore();
    const tampered = envelope(10, 5, { state_hash: 'sha256:tampered' });
    await store.write(tampered);
    const log = logAt(new Map([[10, eventId(10)]]));
    await expect(store.latestValid({ lastSeq: 10, ...log })).resolves.toBeNull();
  });

  it('dropAbove(n) deletes exactly the right files', async () => {
    const store = makeStore();
    await store.write(envelope(5, 1));
    await store.write(envelope(10, 2));
    await store.write(envelope(15, 3));

    await store.dropAbove(10);

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(['10.json', '5.json']);
  });

  it('prune(keep) retains only the newest `keep` snapshots', async () => {
    const store = makeStore();
    await store.write(envelope(5, 1));
    await store.write(envelope(10, 2));
    await store.write(envelope(15, 3));

    await store.prune(2);

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(['10.json', '15.json']);
  });
});
