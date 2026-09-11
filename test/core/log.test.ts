import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, itemPaths, listItemIds, validateFullLog } from '../../src/core/log.js';
import type { AppendInput, OpenLogOptions } from '../../src/core/log.js';
import type { MienguEvent } from '../../src/core/events.js';
import { WorkItemIdSchema, RunIdSchema } from '../../src/core/ids.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { LockHeldError, LogCorruptError, StoreError } from '../../src/errors.js';

const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;

function makeOptions(storeDir: string, itemId: WorkItemId, seed: string): OpenLogOptions {
  return {
    storeDir,
    itemId,
    runId: RunIdSchema.parse('run-01234567-89ab-cdef-0123-456789abcdef'),
    clock: fixedClock(START, 1000),
    ids: createIdMinter(fixedRng(seed)),
    logger: silentLogger,
  };
}

const WORK_ITEM_CREATED: AppendInput = {
  type: 'WorkItemCreated',
  data: {
    title: 'Example',
    slug: 'example',
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    config_hash: 'deadbeef',
  },
  actor: { kind: 'system', id: null },
  causationId: null,
};

function budgetConsumed(): AppendInput {
  return {
    type: 'BudgetConsumed',
    data: { scope: 'task', account: 'claude-personal', wall_seconds: 1, turns: 1, usd: null },
    actor: { kind: 'system', id: null },
    causationId: null,
  };
}

let storeDir: string;
const itemId = WorkItemIdSchema.parse('wi-example-abc123');

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'miengu-log-'));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe('EventLog', () => {
  it('create initializes every item-layout directory, including oracle evidence', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'layout-dirs'));
    const paths = itemPaths(storeDir, itemId);
    await Promise.all([
      access(paths.snapshotsDir), access(paths.transcriptsDir), access(paths.diffsDir),
      access(paths.oraclesDir), access(paths.workspacesDir),
    ]);
    await log.close();
  });

  it('append -> read round trip preserves order and seq', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'seed-a'));
    await log.append(WORK_ITEM_CREATED);
    await log.append(budgetConsumed());
    await log.append(budgetConsumed());
    const events = await log.readAll();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]?.type).toBe('WorkItemCreated');
    expect(events[1]?.type).toBe('BudgetConsumed');
    expect(events[2]?.type).toBe('BudgetConsumed');
    await log.close();
  });

  it('notifies an observer only after an event is durably appended', async () => {
    const observed: MienguEvent[] = [];
    const options = {
      ...makeOptions(storeDir, itemId, 'observer'),
      onAppend: (event: MienguEvent): void => {
        observed.push(event);
      },
    };
    const { log } = await EventLog.create(options);

    expect(observed).toEqual([]);
    const appended = await log.append(WORK_ITEM_CREATED);

    expect(observed).toEqual([appended]);
    expect(await readFile(itemPaths(storeDir, itemId).eventsFile, 'utf8')).toContain(appended.event_id);
    await log.close();
  });

  it('rejects an append whose event 1 is not WorkItemCreated', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'seed-b'));
    await expect(log.append(budgetConsumed())).rejects.toBeInstanceOf(StoreError);
    await log.close();
  });

  it('50 concurrent appends yield contiguous seq 1..50', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'seed-c'));
    const promises = [log.append(WORK_ITEM_CREATED)];
    for (let i = 0; i < 49; i += 1) {
      promises.push(log.append(budgetConsumed()));
    }
    await Promise.all(promises);
    expect(log.lastSeq).toBe(50);
    const events = await log.readAll();
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    await log.close();
  });

  it('opens with truncatedBytes > 0 and correct lastSeq when the final line is torn', async () => {
    const options = makeOptions(storeDir, itemId, 'seed-d');
    const { log } = await EventLog.create(options);
    await log.append(WORK_ITEM_CREATED);
    await log.append(budgetConsumed());
    await log.append(budgetConsumed());
    await log.close();

    const paths = itemPaths(storeDir, itemId);
    const original = await readFile(paths.eventsFile, 'utf8');
    const torn = original.slice(0, -5); // chop the tail off the last line, no trailing \n
    await writeFile(paths.eventsFile, torn, 'utf8');

    const reopened = await EventLog.open(makeOptions(storeDir, itemId, 'seed-d'));
    expect(reopened.truncatedBytes).toBeGreaterThan(0);
    expect(reopened.log.lastSeq).toBe(2);
    await reopened.log.close();
  });

  it('throws LogCorruptError naming the line number for a corrupted middle line', async () => {
    const options = makeOptions(storeDir, itemId, 'seed-e');
    const { log } = await EventLog.create(options);
    await log.append(WORK_ITEM_CREATED);
    await log.append(budgetConsumed());
    await log.append(budgetConsumed());
    await log.close();

    const paths = itemPaths(storeDir, itemId);
    const original = await readFile(paths.eventsFile, 'utf8');
    const lines = original.split('\n').filter((l) => l.length > 0);
    lines[1] = '{"not":"a valid event"}';
    await writeFile(paths.eventsFile, `${lines.join('\n')}\n`, 'utf8');

    await expect(EventLog.open(makeOptions(storeDir, itemId, 'seed-e'))).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(LogCorruptError);
        expect((error as LogCorruptError).message).toContain('line 2');
        return true;
      },
    );
  });

  it('throws LogCorruptError on a seq gap (1, 2, 4)', async () => {
    const options = makeOptions(storeDir, itemId, 'seed-f');
    const { log } = await EventLog.create(options);
    await log.append(WORK_ITEM_CREATED);
    const second = await log.append(budgetConsumed());
    await log.close();

    const paths = itemPaths(storeDir, itemId);
    const third = { ...second, seq: 4, event_id: 'evt-00000000-0000-0000-0000-000000000004' };
    const original = await readFile(paths.eventsFile, 'utf8');
    await writeFile(paths.eventsFile, `${original}${JSON.stringify(third)}\n`, 'utf8');

    await expect(EventLog.open(makeOptions(storeDir, itemId, 'seed-f'))).rejects.toBeInstanceOf(
      LogCorruptError,
    );
  });

  it('a second open while locked throws LockHeldError', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'seed-g'));
    await log.append(WORK_ITEM_CREATED);

    await expect(EventLog.open(makeOptions(storeDir, itemId, 'seed-g'))).rejects.toBeInstanceOf(
      LockHeldError,
    );

    await log.close();
  });

  it('open({force:true}) steals the lock and succeeds', async () => {
    const { log: first } = await EventLog.create(makeOptions(storeDir, itemId, 'seed-h'));
    await first.append(WORK_ITEM_CREATED);

    const forcedOptions = { ...makeOptions(storeDir, itemId, 'seed-h'), force: true };
    const { log: second } = await EventLog.open(forcedOptions);
    expect(second.lastSeq).toBe(1);
    await second.close();
    await first.close();
  });

  it('refuses writable open of a valid v2 log without rewriting its durable bytes', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'v2-read-only'));
    await log.append(WORK_ITEM_CREATED);
    await log.append(budgetConsumed());
    await log.close();
    const paths = itemPaths(storeDir, itemId);
    const v2 = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...event, schema_version: 2 });
    }).join('\n').concat('\n');
    await writeFile(paths.eventsFile, v2, 'utf8');
    await expect(EventLog.open(makeOptions(storeDir, itemId, 'v2-read-only'))).rejects.toBeInstanceOf(StoreError);
    expect(await readFile(paths.eventsFile, 'utf8')).toBe(v2);
    await expect(readFile(paths.lockFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a torn v2 tail without truncating bytes or acquiring a lock', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'v2-bad-type'));
    await log.append(WORK_ITEM_CREATED);
    await log.close();
    const paths = itemPaths(storeDir, itemId);
    const event = JSON.parse((await readFile(paths.eventsFile, 'utf8')).trim()) as Record<string, unknown>;
    const tornV2 = `${JSON.stringify({ ...event, schema_version: 2 })}\n${JSON.stringify({ ignored: 'torn tail' }).slice(0, -7)}`;
    await writeFile(paths.eventsFile, tornV2, 'utf8');

    await expect(EventLog.open(makeOptions(storeDir, itemId, 'v2-bad-type'))).rejects.toBeInstanceOf(StoreError);
    expect(await readFile(paths.eventsFile, 'utf8')).toBe(tornV2);
    await expect(readFile(paths.lockFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('opens a valid v3 log, upcasts reads, and appends only a v4 event', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'v3-writable'));
    await log.append(WORK_ITEM_CREATED);
    await log.append(budgetConsumed());
    await log.close();

    const paths = itemPaths(storeDir, itemId);
    const v3 = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...event, schema_version: 3 });
    }).join('\n').concat('\n');
    await writeFile(paths.eventsFile, v3, 'utf8');

    const reopened = await EventLog.open(makeOptions(storeDir, itemId, 'v3-writable'));
    expect((await reopened.log.readAll()).map((event) => event.schema_version)).toEqual([4, 4]);
    await reopened.log.append(budgetConsumed());
    await reopened.log.close();

    const versions = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').map((line) =>
      (JSON.parse(line) as { schema_version: number }).schema_version,
    );
    expect(versions).toEqual([3, 3, 4]);
  });

  it('recovers a torn v4 tail after a valid v3 prefix', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'mixed-torn-tail'));
    await log.append(WORK_ITEM_CREATED);
    await log.close();
    const paths = itemPaths(storeDir, itemId);
    const v3First = JSON.stringify({ ...JSON.parse((await readFile(paths.eventsFile, 'utf8')).trim()), schema_version: 3 });
    await writeFile(paths.eventsFile, `${v3First}\n{"schema_version":4`, 'utf8');

    const reopened = await EventLog.open(makeOptions(storeDir, itemId, 'mixed-torn-tail'));
    expect(reopened.truncatedBytes).toBeGreaterThan(0);
    expect(reopened.log.lastSeq).toBe(1);
    await reopened.log.close();
  });

  it('does not misclassify a v3 payload mentioning schema_version 2 as a v2 envelope', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'v3-payload-version'));
    await log.append({
      ...WORK_ITEM_CREATED,
      data: { ...WORK_ITEM_CREATED.data, title: 'payload says "schema_version": 2' },
    });
    await log.close();
    const reopened = await EventLog.open(makeOptions(storeDir, itemId, 'v3-payload-version'));
    expect(reopened.log.lastSeq).toBe(1);
    await reopened.log.close();
  });
});

describe('validateFullLog', () => {
  async function validBody(seed: string): Promise<string> {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, seed));
    await log.append(WORK_ITEM_CREATED);
    await log.append(budgetConsumed());
    await log.append(budgetConsumed());
    await log.close();
    return readFile(itemPaths(storeDir, itemId).eventsFile, 'utf8');
  }

  it('accepts an empty body as a valid empty log', () => {
    expect(validateFullLog('', itemId)).toEqual({ ok: true, events: [] });
  });

  it('accepts a well-formed, owned, contiguous log and returns its events', async () => {
    const result = validateFullLog(await validBody('vfl-ok'), itemId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(result.events[0]?.type).toBe('WorkItemCreated');
    }
  });

  it('ignores a non-newline-terminated final fragment and validates the durable prefix', async () => {
    const body = await validBody('vfl-torn');
    // Chop the newline plus part of the third line: that record was never durable, exactly as
    // the writable-open scan and the replay reader treat a torn tail.
    const result = validateFullLog(body.slice(0, -5), itemId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events.map((e) => e.seq)).toEqual([1, 2]);
    }
  });

  it('treats a body whose only line is a torn fragment as an empty log', () => {
    expect(validateFullLog('{"schema_version":3', itemId)).toEqual({ ok: true, events: [] });
  });

  it('classifies a foreign item_id as corrupt', async () => {
    const body = await validBody('vfl-owner');
    const other = WorkItemIdSchema.parse('wi-other-def456');
    const result = validateFullLog(body, other);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('does not match expected') });
  });

  it('classifies a non-contiguous sequence as corrupt', async () => {
    const body = await validBody('vfl-seq');
    const lines = body.trimEnd().split('\n');
    const third = JSON.parse(lines[2] as string) as Record<string, unknown>;
    lines[2] = JSON.stringify({ ...third, seq: 9 });
    const result = validateFullLog(`${lines.join('\n')}\n`, itemId);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('not contiguous') });
  });

  it('classifies a first event that is not WorkItemCreated as corrupt', async () => {
    const body = await validBody('vfl-first');
    const lines = body.trimEnd().split('\n');
    const result = validateFullLog(`${lines[1] as string}\n`, itemId);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('first event must be WorkItemCreated') });
  });

  it('classifies a non-JSON line as corrupt', () => {
    const result = validateFullLog('not json\n', itemId);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('not valid JSON') });
  });
});

describe('listItemIds', () => {
  it('returns [] when the items directory does not exist', async () => {
    const ids = await listItemIds(storeDir);
    expect(ids).toEqual([]);
  });

  it('lists created item ids', async () => {
    const { log } = await EventLog.create(makeOptions(storeDir, itemId, 'seed-i'));
    await log.append(WORK_ITEM_CREATED);
    await log.close();
    const ids = await listItemIds(storeDir);
    expect(ids).toEqual([itemId]);
  });
});
