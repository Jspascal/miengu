import {
  open as fsOpen,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { LockHeldError, LogCorruptError, StoreError } from '../errors.js';
import type { Logger } from '../logging.js';
import { canonicalJson } from './canonical.js';
import type { Clock } from './clock.js';
import type { IdMinter } from './idgen.js';
import { WorkItemIdSchema } from './ids.js';
import type { EventId, RunId, WorkItemId } from './ids.js';
import type { ProvenanceTier } from './provenance.js';
import { DEFAULT_TIER, EVENT_SCHEMA_VERSION, MienguEventSchema, StoredEventSchema } from './events.js';
import type { Actor, EventType, MienguEvent } from './events.js';

export const LOG_FILENAME = 'events.jsonl';
const NEWLINE_BYTE = 10;

export interface ItemPaths {
  readonly itemDir: string;
  readonly eventsFile: string;
  readonly lockFile: string;
  readonly snapshotsDir: string;
  readonly transcriptsDir: string;
  readonly diffsDir: string;
  readonly oraclesDir: string;
  readonly brownfieldDir: string;
  readonly workspacesDir: string;
}

export function itemPaths(storeDir: string, itemId: WorkItemId): ItemPaths {
  const itemDir = join(storeDir, 'items', itemId);
  return {
    itemDir,
    eventsFile: join(itemDir, LOG_FILENAME),
    lockFile: join(itemDir, 'lock'),
    snapshotsDir: join(itemDir, 'snapshots'),
    transcriptsDir: join(itemDir, 'transcripts'),
    diffsDir: join(itemDir, 'diffs'),
    oraclesDir: join(itemDir, 'oracles'),
    brownfieldDir: join(itemDir, 'brownfield'),
    workspacesDir: join(itemDir, 'workspaces'),
  };
}

export async function listItemIds(storeDir: string): Promise<WorkItemId[]> {
  const itemsDir = join(storeDir, 'items');
  let entries: Dirent[];
  try {
    entries = await readdir(itemsDir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const ids: WorkItemId[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const parsed = WorkItemIdSchema.safeParse(entry.name);
    if (parsed.success) {
      ids.push(parsed.data);
    }
  }
  return ids.sort();
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

async function fsyncDir(dirPath: string): Promise<void> {
  const dh = await fsOpen(dirPath, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

async function dropSnapshotsAbove(snapshotsDir: string, lastSeq: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(snapshotsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }
  for (const entry of entries) {
    const match = /^(\d+)\.json$/.exec(entry);
    if (match === null) {
      continue;
    }
    const seqPart = match[1];
    if (seqPart === undefined) {
      continue;
    }
    const seq = Number.parseInt(seqPart, 10);
    if (seq > lastSeq) {
      await rm(join(snapshotsDir, entry), { force: true });
    }
  }
}

interface LockPayload {
  readonly pid: number;
  readonly host: string;
  readonly run_id: RunId;
  readonly started_at: string;
}

async function acquireLock(lockFile: string, o: OpenLogOptions): Promise<void> {
  const payload: LockPayload = {
    pid: process.pid,
    host: hostname(),
    run_id: o.runId,
    started_at: o.clock.now(),
  };
  try {
    const fh = await fsOpen(lockFile, 'wx');
    try {
      await fh.writeFile(canonicalJson(payload), 'utf8');
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EEXIST') {
      if (o.force === true) {
        await rm(lockFile, { force: true });
        await acquireLock(lockFile, o);
        return;
      }
      let holder: unknown = null;
      try {
        holder = JSON.parse(await readFile(lockFile, 'utf8'));
      } catch {
        // ignore: report the generic lock-held error below regardless
      }
      throw new LockHeldError(`lock already held: ${lockFile}`, { lockFile, holder });
    }
    throw err;
  }
}

interface ScanResult {
  readonly lastSeq: number;
  readonly lastEventId: EventId | null;
  readonly truncatedBytes: number;
  readonly containsV2: boolean;
}

/**
 * Writable v2 refusal must happen before either the writer lock or torn-tail recovery.
 * A legacy log may itself have a torn final line, so this intentionally examines the raw
 * bytes instead of asking the v3 event parser to validate every line first.
 */
async function containsV2Envelope(eventsFile: string): Promise<boolean> {
  const content = await readFile(eventsFile);
  // Preflight is non-mutating and only considers complete JSONL envelopes.  This avoids
  // treating a payload string as a legacy header while a complete v2 prefix protects any
  // torn tail from writable-open recovery.
  const complete = content.lastIndexOf(NEWLINE_BYTE);
  if (complete < 0) return false;
  for (const line of content.subarray(0, complete).toString('utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)['schema_version'] === 2) return true;
    } catch {
      // The normal scan reports malformed complete lines after writable preflight.
    }
  }
  return false;
}

async function scanAndRecover(
  eventsFile: string,
  itemId: WorkItemId,
  logger: Logger,
): Promise<ScanResult> {
  let content = await readFile(eventsFile);

  let truncatedBytes = 0;
  if (content.length > 0 && content[content.length - 1] !== NEWLINE_BYTE) {
    const lastNewlineIndex = content.lastIndexOf(NEWLINE_BYTE);
    const validLength = lastNewlineIndex + 1;
    truncatedBytes = content.length - validLength;
    content = content.subarray(0, validLength);
    await truncate(eventsFile, validLength);
    logger.warn(
      { eventsFile, truncatedBytes },
      'torn final line truncated at open: that event was never durable',
    );
  }

  const text = content.toString('utf8');
  const lines = text.length === 0 ? [] : text.split('\n').slice(0, -1);

  let lastSeq = 0;
  let lastEventId: EventId | null = null;
  let containsV2 = false;
  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      throw new LogCorruptError(
        `${eventsFile}: line ${String(lineNumber)}: not valid JSON`,
      );
    }
    const result = StoredEventSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new LogCorruptError(
        `${eventsFile}: line ${String(lineNumber)}: failed schema validation: ${result.error.message}`,
      );
    }
    const event = result.data;
    if (parsedJson !== null && typeof parsedJson === 'object' && (parsedJson as Record<string, unknown>)['schema_version'] === 2) containsV2 = true;
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
    lastEventId = event.event_id;
  }

  return { lastSeq, lastEventId, truncatedBytes, containsV2 };
}

export type FullLogValidation =
  | { readonly ok: true; readonly events: readonly MienguEvent[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Non-mutating validation of a complete event-log file body, for readers that must not repair
 * or lock the log they inspect (notably brownfield sibling-store scans).  Applies the same
 * rules the writable-open scan enforces — ownership, first event, contiguous sequence — but
 * reports the first failure as a classified reason instead of throwing or truncating.  A
 * non-newline-terminated final fragment is ignored as never durable, exactly as the
 * writable-open scan and the replay reader treat a torn tail; the preceding durable lines are
 * still fully validated.  An empty body is a valid empty log.
 */
export function validateFullLog(content: string, itemId: WorkItemId): FullLogValidation {
  if (content.length === 0) {
    return { ok: true, events: [] };
  }
  const lines = content.split('\n').slice(0, -1);
  const events: MienguEvent[] = [];
  let lastSeq = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      return { ok: false, reason: `line ${String(lineNumber)}: not valid JSON` };
    }
    const result = StoredEventSchema.safeParse(parsedJson);
    if (!result.success) {
      return { ok: false, reason: `line ${String(lineNumber)}: failed schema validation` };
    }
    const event = result.data;
    if (lineNumber === 1 && event.type !== 'WorkItemCreated') {
      return {
        ok: false,
        reason: `line 1: first event must be WorkItemCreated, got "${event.type}"`,
      };
    }
    if (event.item_id !== itemId) {
      return {
        ok: false,
        reason: `line ${String(lineNumber)}: item_id "${event.item_id}" does not match expected "${itemId}"`,
      };
    }
    const expectedSeq = lastSeq + 1;
    if (event.seq !== expectedSeq) {
      return {
        ok: false,
        reason: `line ${String(lineNumber)}: seq ${String(event.seq)} is not contiguous (expected ${String(expectedSeq)})`,
      };
    }
    lastSeq = event.seq;
    events.push(event);
  }
  return { ok: true, events };
}

export interface AppendInput {
  readonly type: EventType;
  readonly data: unknown;
  readonly actor: Actor;
  readonly causationId: EventId | null;
  readonly tier?: ProvenanceTier;
}

export interface OpenLogOptions {
  readonly storeDir: string;
  readonly itemId: WorkItemId;
  readonly runId: RunId;
  readonly clock: Clock;
  readonly ids: IdMinter;
  readonly logger: Logger;
  /** Called after an event has been written and synced. Observer failures never fail the log append. */
  readonly onAppend?: ((event: MienguEvent) => void) | undefined;
  readonly force?: boolean;
}

export interface OpenResult {
  readonly log: EventLog;
  readonly truncatedBytes: number;
}

interface EventLogInit {
  readonly itemId: WorkItemId;
  readonly runId: RunId;
  readonly clock: Clock;
  readonly ids: IdMinter;
  readonly paths: ItemPaths;
  readonly fileHandle: FileHandle;
  readonly lastSeq: number;
  readonly lastEventId: EventId | null;
  readonly logger: Logger;
  readonly onAppend?: ((event: MienguEvent) => void) | undefined;
}

export class EventLog {
  readonly itemId: WorkItemId;
  private readonly runId: RunId;
  private readonly clock: Clock;
  private readonly ids: IdMinter;
  private readonly paths: ItemPaths;
  private readonly fileHandle: FileHandle;
  private readonly logger: Logger;
  private readonly onAppend: ((event: MienguEvent) => void) | undefined;
  private _lastSeq: number;
  private _lastEventId: EventId | null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(init: EventLogInit) {
    this.itemId = init.itemId;
    this.runId = init.runId;
    this.clock = init.clock;
    this.ids = init.ids;
    this.paths = init.paths;
    this.fileHandle = init.fileHandle;
    this.logger = init.logger;
    this.onAppend = init.onAppend;
    this._lastSeq = init.lastSeq;
    this._lastEventId = init.lastEventId;
  }

  static async create(o: OpenLogOptions): Promise<OpenResult> {
    const paths = itemPaths(o.storeDir, o.itemId);
    await mkdir(paths.itemDir, { recursive: true });
    await mkdir(paths.snapshotsDir, { recursive: true });
    await mkdir(paths.transcriptsDir, { recursive: true });
    await mkdir(paths.diffsDir, { recursive: true });
    await mkdir(paths.oraclesDir, { recursive: true });
    await mkdir(paths.brownfieldDir, { recursive: true });
    await mkdir(paths.workspacesDir, { recursive: true });
    const createHandle = await fsOpen(paths.eventsFile, 'wx');
    await createHandle.close();
    await fsyncDir(join(o.storeDir, 'items'));
    return EventLog.open(o);
  }

  static async open(o: OpenLogOptions): Promise<OpenResult> {
    const paths = itemPaths(o.storeDir, o.itemId);

    if (!(await pathExists(paths.itemDir))) {
      throw new StoreError(`unknown work item: ${o.itemId}`, { itemDir: paths.itemDir });
    }

    if (!(await pathExists(paths.eventsFile))) {
      throw new LogCorruptError(
        `${paths.eventsFile} is missing for a known item directory`,
        { eventsFile: paths.eventsFile },
      );
    }

    // Never acquire a writer lock or repair a legacy file.  V2 is replay-only; the raw
    // check deliberately also recognizes a v2 header in a torn final record.
    if (await containsV2Envelope(paths.eventsFile)) {
      throw new StoreError('v2 event logs are read-only; writable open is refused', { eventsFile: paths.eventsFile });
    }

    await acquireLock(paths.lockFile, o);

    const scan = await scanAndRecover(paths.eventsFile, o.itemId, o.logger);
    if (scan.truncatedBytes > 0) {
      await dropSnapshotsAbove(paths.snapshotsDir, scan.lastSeq);
    }

    const fileHandle = await fsOpen(paths.eventsFile, 'a');
    const log = new EventLog({
      itemId: o.itemId,
      runId: o.runId,
      clock: o.clock,
      ids: o.ids,
      paths,
      fileHandle,
      lastSeq: scan.lastSeq,
      lastEventId: scan.lastEventId,
      logger: o.logger,
      onAppend: o.onAppend,
    });
    return { log, truncatedBytes: scan.truncatedBytes };
  }

  get lastSeq(): number {
    return this._lastSeq;
  }

  get lastEventId(): EventId | null {
    return this._lastEventId;
  }

  append(input: AppendInput): Promise<MienguEvent> {
    const task = this.chain.then(() => this.doAppend(input));
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async doAppend(input: AppendInput): Promise<MienguEvent> {
    if (this.closed) {
      throw new StoreError('cannot append to a closed event log');
    }
    const seq = this._lastSeq + 1;
    if (seq === 1 && input.type !== 'WorkItemCreated') {
      throw new StoreError(
        `the first event of a log must be WorkItemCreated, got "${input.type}"`,
      );
    }

    const eventId = this.ids.eventId();
    const ts = this.clock.now();
    const tier = input.tier ?? DEFAULT_TIER[input.type];

    const candidate = {
      schema_version: EVENT_SCHEMA_VERSION,
      event_id: eventId,
      seq,
      item_id: this.itemId,
      run_id: this.runId,
      ts,
      tier,
      actor: input.actor,
      causation_id: input.causationId,
      type: input.type,
      data: input.data,
    };

    const parsed = MienguEventSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new StoreError(
        `invalid event payload for type "${input.type}": ${parsed.error.message}`,
      );
    }
    const event = parsed.data;
    const line = `${canonicalJson(event)}\n`;
    await this.fileHandle.write(line, null, 'utf8');
    await this.fileHandle.datasync();

    this._lastSeq = seq;
    this._lastEventId = eventId;
    try {
      this.onAppend?.(event);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), eventType: event.type },
        'event append observer failed after the event was durable',
      );
    }
    return event;
  }

  read(fromSeq = 1): AsyncIterable<MienguEvent> {
    const eventsFile = this.paths.eventsFile;
    return (async function* readGenerator() {
      const raw = await readFile(eventsFile, 'utf8');
      const lines = raw.length === 0 ? raw.split('\n').slice(0, 0) : raw.split('\n').slice(0, -1);
      for (const line of lines) {
        const parsedJson: unknown = JSON.parse(line);
        const event = StoredEventSchema.parse(parsedJson);
        if (event.seq >= fromSeq) {
          yield event;
        }
      }
    })();
  }

  async readAll(fromSeq = 1): Promise<MienguEvent[]> {
    const out: MienguEvent[] = [];
    for await (const event of this.read(fromSeq)) {
      out.push(event);
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.chain;
    await this.fileHandle.close();
    await rm(this.paths.lockFile, { force: true });
  }
}
