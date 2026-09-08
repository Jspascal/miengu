import { readFile, stat } from 'node:fs/promises';
import { canonicalJson } from '../../core/canonical.js';
import { StoredEventSchema } from '../../core/events.js';
import type { MienguEvent } from '../../core/events.js';
import { itemPaths } from '../../core/log.js';
import type { EventId, WorkItemId } from '../../core/ids.js';
import { LogCorruptError, StoreError } from '../../errors.js';
import { createSnapshotStore } from '../../core/snapshot.js';
import { loadConfig } from '../../config/load.js';
import { PROJECTION_VERSION, WorkItemStateSchema } from '../../state/workitem.js';
import type { WorkItemState } from '../../state/workitem.js';
import { project } from '../../state/projector.js';
import { stateHash } from '../../state/stateHash.js';
import { EXIT } from '../exit.js';

const NEWLINE_BYTE = 10;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads `eventsFile` for a read-only caller: never locks, never truncates the file on disk. A
 * torn final line is dropped in memory only (it was never durable, so this is not "repair").
 * Every complete line is fully validated; a malformed complete line is a hard refusal, matching
 * `core/log.ts`'s open/recovery discipline without touching the filesystem.
 */
export async function readEventsReadOnly(eventsFile: string, itemId: WorkItemId): Promise<MienguEvent[]> {
  let raw: Buffer;
  try {
    raw = await readFile(eventsFile);
  } catch {
    throw new LogCorruptError(`${eventsFile} is missing for a known item directory`, {
      eventsFile,
    });
  }

  let content = raw;
  if (content.length > 0 && content[content.length - 1] !== NEWLINE_BYTE) {
    const lastNewline = content.lastIndexOf(NEWLINE_BYTE);
    content = content.subarray(0, lastNewline + 1);
  }

  const text = content.toString('utf8');
  const lines = text.length === 0 ? [] : text.split('\n').slice(0, -1);

  const events: MienguEvent[] = [];
  let lastSeq = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const line = lines[i] ?? '';
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      throw new LogCorruptError(`${eventsFile}: line ${String(lineNumber)}: not valid JSON`);
    }
    const result = StoredEventSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new LogCorruptError(
        `${eventsFile}: line ${String(lineNumber)}: failed schema validation: ${result.error.message}`,
      );
    }
    const event = result.data;
    if (event.item_id !== itemId) {
      throw new LogCorruptError(
        `${eventsFile}: line ${String(lineNumber)}: item_id "${event.item_id}" does not match expected "${itemId}"`,
      );
    }
    const expectedSeq = lastSeq + 1;
    if (event.seq !== expectedSeq) {
      throw new LogCorruptError(
        `${eventsFile}: line ${String(lineNumber)}: seq ${String(event.seq)} is not contiguous (expected ${String(expectedSeq)})`,
      );
    }
    if (lineNumber === 1 && event.type !== 'WorkItemCreated') {
      throw new LogCorruptError(
        `${eventsFile}: line ${String(lineNumber)}: first event must be WorkItemCreated, got "${event.type}"`,
      );
    }
    lastSeq = event.seq;
    events.push(event);
  }
  return events;
}

/** Cheap, non-validating pass used only to feed `SnapshotStore.latestValid`'s `eventIdAt`. */
async function scanEventIds(eventsFile: string): Promise<{
  lastSeq: number;
  seqToEventId: Map<number, EventId>;
  containsV2: boolean;
}> {
  let raw: Buffer;
  try {
    raw = await readFile(eventsFile);
  } catch {
    throw new LogCorruptError(`${eventsFile} is missing for a known item directory`, {
      eventsFile,
    });
  }
  let content = raw;
  if (content.length > 0 && content[content.length - 1] !== NEWLINE_BYTE) {
    const lastNewline = content.lastIndexOf(NEWLINE_BYTE);
    content = content.subarray(0, lastNewline + 1);
  }
  const text = content.toString('utf8');
  const lines = text.length === 0 ? [] : text.split('\n').slice(0, -1);

  const seqToEventId = new Map<number, EventId>();
  let lastSeq = 0;
  let containsV2 = false;
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>)['schema_version'] === 2) containsV2 = true;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'seq' in parsed &&
        'event_id' in parsed &&
        typeof (parsed as Record<string, unknown>)['seq'] === 'number'
      ) {
        const seq = (parsed as Record<string, unknown>)['seq'] as number;
        const eventId = (parsed as Record<string, unknown>)['event_id'];
        if (typeof eventId === 'string') {
          seqToEventId.set(seq, eventId as EventId);
          if (seq > lastSeq) {
            lastSeq = seq;
          }
        }
      }
    } catch {
      // A line this pass cannot even parse contributes nothing to eventIdAt; the snapshot
      // store treats an unresolvable seq as invalid and falls back, never crashing here.
    }
  }
  return { lastSeq, seqToEventId, containsV2 };
}

export interface AcceleratedProjection {
  readonly state: WorkItemState;
  readonly snapshotSeq: number | null;
  readonly tailFrom: number;
  readonly tailTo: number;
}

/** Full read from seq 1, snapshots ignored entirely. This is the acceptance-criterion side. */
export async function projectFromSeq1(storeDir: string, itemId: WorkItemId): Promise<WorkItemState> {
  const paths = itemPaths(storeDir, itemId);
  if (!(await pathExists(paths.itemDir))) {
    throw new StoreError(`unknown work item: ${itemId}`, { itemDir: paths.itemDir });
  }
  const events = await readEventsReadOnly(paths.eventsFile, itemId);
  return project(events);
}

/** `latestValid` snapshot + a validated tail, never touching the write lock. */
export async function projectAccelerated(
  storeDir: string,
  itemId: WorkItemId,
): Promise<AcceleratedProjection> {
  const paths = itemPaths(storeDir, itemId);
  if (!(await pathExists(paths.itemDir))) {
    throw new StoreError(`unknown work item: ${itemId}`, { itemDir: paths.itemDir });
  }

  const { lastSeq, seqToEventId, containsV2 } = await scanEventIds(paths.eventsFile);

  const snapshots = createSnapshotStore<WorkItemState>({
    dir: paths.snapshotsDir,
    itemId,
    projectionVersion: PROJECTION_VERSION,
    hashState: stateHash,
    parseState: (v) => WorkItemStateSchema.parse(v),
  });

  const snapshot = containsV2 ? null : await snapshots.latestValid({
    lastSeq,
    eventIdAt: (seq) => Promise.resolve(seqToEventId.get(seq) ?? null),
  });

  const allEvents = await readEventsReadOnly(paths.eventsFile, itemId);
  const tailFrom = snapshot === null ? 1 : snapshot.seq + 1;
  const tail = allEvents.filter((e) => e.seq >= tailFrom);
  const state = project(tail, snapshot?.state);
  const tailTo = allEvents.length > 0 ? (allEvents[allEvents.length - 1]?.seq ?? tailFrom - 1) : tailFrom - 1;

  return { state, snapshotSeq: snapshot?.seq ?? null, tailFrom, tailTo };
}

function firstDifferingPath(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) {
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return path;
    }
    for (let i = 0; i < a.length; i += 1) {
      const diff = firstDifferingPath(a[i], b[i], `${path}[${String(i)}]`);
      if (diff !== null) {
        return diff;
      }
    }
    return null;
  }
  const aIsObject = a !== null && typeof a === 'object';
  const bIsObject = b !== null && typeof b === 'object';
  if (aIsObject && bIsObject) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(aRecord), ...Object.keys(bRecord)])).sort();
    for (const key of keys) {
      const diff = firstDifferingPath(aRecord[key], bRecord[key], `${path}.${key}`);
      if (diff !== null) {
        return diff;
      }
    }
    return null;
  }
  return path;
}

export interface ReplayCommandOptions {
  readonly itemId: WorkItemId;
  readonly configPath?: string | undefined;
  readonly json?: boolean | undefined;
}

/**
 * Projects from seq 1 with snapshots ignored entirely; separately projects using
 * `latestValid` + tail; compares `stateHash`. This command IS the Phase 1 acceptance
 * criterion. Never writes an event, writes a snapshot, acquires the write lock, or repairs
 * anything.
 */
export async function replayCommand(options: ReplayCommandOptions): Promise<number> {
  const loaded = await loadConfig(options.configPath);

  const fromScratch = await projectFromSeq1(loaded.storeDir, options.itemId);
  const accelerated = await projectAccelerated(loaded.storeDir, options.itemId);

  const scratchHash = stateHash(fromScratch);
  const acceleratedHash = stateHash(accelerated.state);
  const match = scratchHash === acceleratedHash;

  if (options.json === true) {
    const payload: Record<string, unknown> = {
      item: options.itemId,
      events: fromScratch.seq,
      stage: fromScratch.stage,
      status: fromScratch.status,
      stateHash: `sha256:${scratchHash}`,
      snapshotHash: `sha256:${acceleratedHash}`,
      snapshotSeq: accelerated.snapshotSeq,
      match,
    };
    if (!match) {
      payload['firstDifferingPath'] = firstDifferingPath(
        JSON.parse(canonicalJson(fromScratch)) as unknown,
        JSON.parse(canonicalJson(accelerated.state)) as unknown,
      );
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return match ? EXIT.OK : EXIT.REPLAY_MISMATCH;
  }

  const snapshotDescription =
    accelerated.snapshotSeq === null
      ? `no snapshot + events 1..${String(accelerated.tailTo)}`
      : `snapshot@${String(accelerated.snapshotSeq)} + events ${String(accelerated.tailFrom)}..${String(accelerated.tailTo)}`;

  const lines = [
    `item      ${options.itemId}`,
    `events    ${String(fromScratch.seq)}`,
    `stage     ${fromScratch.stage}          status ${fromScratch.status}`,
    `state     sha256:${scratchHash}   (projected from seq 1, snapshots ignored)`,
    `snapshot  sha256:${acceleratedHash}   (${snapshotDescription})   ${match ? 'MATCH' : 'MISMATCH'}`,
  ];
  if (!match) {
    const diffPath = firstDifferingPath(
      JSON.parse(canonicalJson(fromScratch)) as unknown,
      JSON.parse(canonicalJson(accelerated.state)) as unknown,
    );
    lines.push(`first differing key path: ${diffPath ?? '(unknown)'}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  return match ? EXIT.OK : EXIT.REPLAY_MISMATCH;
}
