import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, itemPaths, listItemIds } from '../../src/core/log.js';
import type { AppendInput, OpenLogOptions } from '../../src/core/log.js';
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
