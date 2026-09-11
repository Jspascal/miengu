import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAccelerated, replayCommand } from '../../src/cli/commands/replay.js';
import { EXIT } from '../../src/cli/exit.js';
import { fixedClock } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { EventLog, itemPaths } from '../../src/core/log.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { createSnapshotStore } from '../../src/core/snapshot.js';
import { silentLogger } from '../../src/logging.js';
import { project } from '../../src/state/projector.js';
import { stateHash } from '../../src/state/stateHash.js';
import { PROJECTION_VERSION, WorkItemStateSchema } from '../../src/state/workitem.js';

let workDir: string;
let configPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'miengu-cli-replay-work-'));
  configPath = join(workDir, 'miengu.config.yaml');
  await writeFile(
    configPath,
    [
      'target:',
      '  repo: .',
      'accounts:',
      '  stub-account: {}',
      'executors:',
      '  stub-analyst: { type: stub, account: stub-account }',
      '  stub-architect: { type: stub, account: stub-account }',
      '  stub-planner: { type: stub, account: stub-account }',
      '  stub-testauthor: { type: stub, account: stub-account }',
      '  stub-coder: { type: stub, account: stub-account }',
      '  stub-reviewer: { type: stub, account: stub-account }',
      'tiers:',
      '  stub-analyst: 1',
      '  stub-architect: 1',
      '  stub-planner: 1',
      '  stub-testauthor: 1',
      '  stub-coder: 1',
      '  stub-reviewer: 1',
      'roles:',
      '  analyst: { executor: stub-analyst, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  architect: { executor: stub-architect, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  planner: { executor: stub-planner, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  testAuthor: { executor: stub-testauthor, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  coder: { executor: stub-coder, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  reviewer: { executor: stub-reviewer, maxTurns: 8, contextBudgetTokens: 40000 }',
      'store:',
      '  dir: .miengu',
      '  snapshotEvery: 3',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function createReplayFixture(): Promise<WorkItemId> {
  const storeDir = join(workDir, '.miengu');
  const ids = createIdMinter(fixedRng('replay-fixture'));
  const itemId = ids.workItemId('replay');
  const { log } = await EventLog.create({
    storeDir,
    itemId,
    runId: ids.runId(),
    clock: fixedClock('2024-01-01T00:00:00.000Z'),
    ids,
    logger: silentLogger,
  });
  await log.append({
    type: 'WorkItemCreated',
    data: {
      title: 'Replay fixture',
      slug: 'replay-fixture',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 },
      config_hash: 'replay-fixture',
    },
    actor: { kind: 'system', id: null },
    causationId: null,
  });
  await log.append({
    type: 'BudgetConsumed',
    data: { scope: 'item', account: 'stub-account', wall_seconds: 1, turns: 1, usd: null },
    actor: { kind: 'system', id: null },
    causationId: log.lastEventId,
  });
  await log.append({
    type: 'BudgetConsumed',
    data: { scope: 'item', account: 'stub-account', wall_seconds: 1, turns: 1, usd: null },
    actor: { kind: 'system', id: null },
    causationId: log.lastEventId,
  });
  const events = await log.readAll();
  const state = project(events);
  await createSnapshotStore({
    dir: itemPaths(storeDir, itemId).snapshotsDir,
    itemId,
    projectionVersion: PROJECTION_VERSION,
    hashState: stateHash,
    parseState: (value) => WorkItemStateSchema.parse(value),
  }).write({
    projection_version: PROJECTION_VERSION,
    item_id: itemId,
    seq: log.lastSeq,
    event_id: log.lastEventId!,
    state_hash: stateHash(state),
    state,
  });
  await log.close();
  return itemId;
}

describe('replayCommand', () => {
  it('exits 0 and the two hashes match for a healthy log', async () => {
    const itemId = await createReplayFixture();
    const result = await replayCommand({ itemId, configPath, json: true });
    expect(result).toBe(EXIT.OK);
  });

  it('does not acquire the write lock', async () => {
    const itemId = await createReplayFixture();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    await replayCommand({ itemId, configPath, json: true });

    await expect(
      readFile(paths.lockFile, 'utf8').then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });

  it('does not write any event or snapshot into the item directory', async () => {
    const itemId = await createReplayFixture();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);
    const before = await readFile(paths.eventsFile, 'utf8');

    await replayCommand({ itemId, configPath, json: true });

    const after = await readFile(paths.eventsFile, 'utf8');
    expect(after).toBe(before);
  });

  it('succeeds against a log with a torn final line, truncated in memory only', async () => {
    const itemId = await createReplayFixture();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    const raw = await readFile(paths.eventsFile);
    const torn = raw.subarray(0, raw.length - 10);
    await writeFile(paths.eventsFile, torn);

    const result = await replayCommand({ itemId, configPath, json: true });
    expect(result).toBe(EXIT.OK);
  });

  it('replays a v2 log read-only and ignores its stale v2 snapshot', async () => {
    const itemId = await createReplayFixture();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);
    const v3 = await readFile(paths.eventsFile, 'utf8');
    // Every fixture event belongs to the Phase 2 vocabulary, so this becomes a valid v2
    // log without altering the event identity that its pre-existing snapshot references.
    const v2 = v3.trim().split('\n').map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...event, schema_version: 2 });
    }).join('\n').concat('\n');
    await writeFile(paths.eventsFile, v2, 'utf8');
    expect(await replayCommand({ itemId, configPath, json: true })).toBe(EXIT.OK);
    expect((await projectAccelerated(storeDir, itemId)).snapshotSeq).toBeNull();
    expect(await readFile(paths.eventsFile, 'utf8')).toBe(v2);
  });

  it('exits 4 when a complete middle line is corrupted', async () => {
    const itemId = await createReplayFixture();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    const raw = await readFile(paths.eventsFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    const middleIndex = Math.floor(lines.length / 2);
    lines[middleIndex] = 'not valid json for this line';
    await writeFile(paths.eventsFile, `${lines.join('\n')}\n`, 'utf8');

    await expect(replayCommand({ itemId, configPath, json: true })).rejects.toMatchObject({
      exitCode: 4,
    });
  });

  it('exits 4 against a log carrying a v1 schema_version line (the clean break, observable)', async () => {
    const itemId = await createReplayFixture();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    const raw = await readFile(paths.eventsFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    const firstLine = JSON.parse(lines[0] ?? '{}') as { schema_version: number };
    expect(firstLine.schema_version).toBe(4);
    firstLine.schema_version = 1;
    lines[0] = JSON.stringify(firstLine);
    await writeFile(paths.eventsFile, `${lines.join('\n')}\n`, 'utf8');

    await expect(replayCommand({ itemId, configPath, json: true })).rejects.toMatchObject({
      exitCode: 4,
    });
  });
});
