import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from '../../src/cli/commands/run.js';
import { decideCommand } from '../../src/cli/commands/decide.js';
import { replayCommand } from '../../src/cli/commands/replay.js';
import { EXIT } from '../../src/cli/exit.js';
import { EventLog, itemPaths, listItemIds } from '../../src/core/log.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { LockHeldError, StoreError } from '../../src/errors.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

let targetRepo: string;
let workDir: string;
let configPath: string;

function stubOnlyConfigYaml(repo: string): string {
  return [
    'target:',
    `  repo: ${repo}`,
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
  ].join('\n');
}

beforeEach(async () => {
  targetRepo = await mkdtemp(join(tmpdir(), 'miengu-cli-decide-target-'));
  await git(targetRepo, ['init', '--initial-branch=main']);
  await git(targetRepo, ['config', 'user.email', 'test@example.com']);
  await git(targetRepo, ['config', 'user.name', 'Test']);
  await writeFile(join(targetRepo, 'README.md'), 'hello\n');
  await git(targetRepo, ['add', 'README.md']);
  await git(targetRepo, ['commit', '-m', 'initial']);

  workDir = await mkdtemp(join(tmpdir(), 'miengu-cli-decide-work-'));
  configPath = join(workDir, 'miengu.config.yaml');
  await writeFile(configPath, stubOnlyConfigYaml(targetRepo), 'utf8');
});

afterEach(async () => {
  await rm(targetRepo, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

/** Appends `CheckpointRaised` (and, optionally, `AutoApproved`) directly to an already-run
 *  item's log, opening and closing the write lock strictly around the append — exactly the
 *  discipline `decide.ts` itself is required to follow. */
async function appendCheckpointRaised(
  storeDir: string,
  itemId: WorkItemId,
  o: {
    readonly checkpoint: string;
    readonly kind?: 'irreversible' | 'agent-originated' | 'blast-radius' | 'assumption-gate' | 'escalation';
    readonly blocking?: boolean;
    readonly slaSeconds?: number | null;
    readonly defaultDecision?: 'accept' | null;
  },
): Promise<void> {
  const ids = createIdMinter(fixedRng(`decide-fixture-${o.checkpoint}`));
  const { log } = await EventLog.open({
    storeDir,
    itemId,
    runId: ids.runId(),
    clock: fixedClock('2024-01-01T00:00:00.000Z'),
    ids,
    logger: silentLogger,
  });
  try {
    await log.append({
      type: 'CheckpointRaised',
      data: {
        checkpoint: o.checkpoint,
        kind: o.kind ?? 'irreversible',
        stage: 'architecture',
        summary: 'fixture checkpoint',
        blocking: o.blocking ?? true,
        sla_seconds: o.slaSeconds ?? null,
        default_decision: o.defaultDecision ?? null,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: log.lastEventId,
    });
  } finally {
    await log.close();
  }
}

async function appendAutoApproved(storeDir: string, itemId: WorkItemId, checkpoint: string): Promise<void> {
  const ids = createIdMinter(fixedRng(`decide-fixture-auto-${checkpoint}`));
  const { log } = await EventLog.open({
    storeDir,
    itemId,
    runId: ids.runId(),
    clock: fixedClock('2024-01-01T00:00:01.000Z'),
    ids,
    logger: silentLogger,
  });
  try {
    await log.append({
      type: 'AutoApproved',
      data: { checkpoint, after: '86400s', no_human_response: true },
      actor: { kind: 'supervisor', id: null },
      causationId: log.lastEventId,
    });
  } finally {
    await log.close();
  }
}

async function lockFileExists(storeDir: string, itemId: WorkItemId): Promise<boolean> {
  const paths = itemPaths(storeDir, itemId);
  return readFile(paths.lockFile, 'utf8').then(
    () => true,
    () => false,
  );
}

async function createItem(prdFileName: string): Promise<WorkItemId> {
  const prdFile = join(workDir, prdFileName);
  await writeFile(prdFile, `Build a thing (${prdFileName}).\n`, 'utf8');
  const storeDir = join(workDir, '.miengu');
  // `listItemIds` sorts, and an item id ends in a random suffix, so "the last entry" is not
  // "the one just minted": a second item whose suffix sorts lower silently yields the first
  // item's id. Diff the set instead.
  const before = new Set(await listItemIds(storeDir));
  await runCommand({ prdFile, configPath, noBacklog: true });
  const minted = (await listItemIds(storeDir)).filter((id) => !before.has(id));
  expect(minted).toHaveLength(1);
  const itemId = minted[0];
  if (itemId === undefined) {
    throw new Error('createItem: no item minted');
  }
  return itemId;
}

describe('decideCommand', () => {
  it('accept appends exactly one CheckpointDecided{by:human}, actor {kind:human,id:null}; status becomes accepted; exit 0', async () => {
    const itemId = await createItem('accept.md');
    const storeDir = join(workDir, '.miengu');
    await appendCheckpointRaised(storeDir, itemId, { checkpoint: 'cp-x-1' });

    const result = await decideCommand({ checkpoint: 'cp-x-1', decision: 'accept', reason: 'looks fine', configPath });
    expect(result).toBe(EXIT.OK);

    const paths = itemPaths(storeDir, itemId);
    const raw = await readFile(paths.eventsFile, 'utf8');
    const events = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const decided = events.filter((e) => e['type'] === 'CheckpointDecided');
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      data: { checkpoint: 'cp-x-1', decision: 'accept', by: 'human', reason: 'looks fine' },
      actor: { kind: 'human', id: null },
    });

    expect(await lockFileExists(storeDir, itemId)).toBe(false);
  });

  it('reject appends exactly one CheckpointDecided{decision:reject}; status becomes rejected; exit 0', async () => {
    const itemId = await createItem('reject.md');
    const storeDir = join(workDir, '.miengu');
    await appendCheckpointRaised(storeDir, itemId, { checkpoint: 'cp-x-1' });

    const result = await decideCommand({ checkpoint: 'cp-x-1', decision: 'reject', configPath });
    expect(result).toBe(EXIT.OK);

    const paths = itemPaths(storeDir, itemId);
    const raw = await readFile(paths.eventsFile, 'utf8');
    const events = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const decided = events.filter((e) => e['type'] === 'CheckpointDecided');
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ data: { decision: 'reject', by: 'human' } });
  });

  it('an unknown checkpoint throws StoreError, exit 4', async () => {
    await createItem('unknown.md');
    await expect(decideCommand({ checkpoint: 'cp-nope-1', decision: 'accept', configPath })).rejects.toBeInstanceOf(
      StoreError,
    );
  });

  it('a malformed checkpoint id is exit 2 with no store read (no lock file ever created)', async () => {
    const itemId = await createItem('malformed-id.md');
    const storeDir = join(workDir, '.miengu');

    const result = await decideCommand({ checkpoint: 'not-a-checkpoint-id', decision: 'accept', configPath });
    expect(result).toBe(EXIT.USAGE);
    expect(await lockFileExists(storeDir, itemId)).toBe(false);
  });

  it('a malformed decision word is exit 2', async () => {
    const itemId = await createItem('malformed-word.md');
    const storeDir = join(workDir, '.miengu');
    await appendCheckpointRaised(storeDir, itemId, { checkpoint: 'cp-x-1' });

    const result = await decideCommand({ checkpoint: 'cp-x-1', decision: 'maybe', configPath });
    expect(result).toBe(EXIT.USAGE);
  });

  it('an already-decided checkpoint is exit 2 and appends no second event', async () => {
    const itemId = await createItem('already-decided.md');
    const storeDir = join(workDir, '.miengu');
    await appendCheckpointRaised(storeDir, itemId, { checkpoint: 'cp-x-1' });
    await decideCommand({ checkpoint: 'cp-x-1', decision: 'accept', configPath });

    const paths = itemPaths(storeDir, itemId);
    const before = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').length;

    const result = await decideCommand({ checkpoint: 'cp-x-1', decision: 'reject', configPath });
    expect(result).toBe(EXIT.USAGE);

    const after = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').length;
    expect(after).toBe(before);
    expect(await lockFileExists(storeDir, itemId)).toBe(false);
  });

  it('an auto-approved checkpoint is exit 2 and appends no event', async () => {
    const itemId = await createItem('auto-approved.md');
    const storeDir = join(workDir, '.miengu');
    await appendCheckpointRaised(storeDir, itemId, {
      checkpoint: 'cp-x-1',
      kind: 'agent-originated',
      blocking: false,
      slaSeconds: 86400,
      defaultDecision: 'accept',
    });
    await appendAutoApproved(storeDir, itemId, 'cp-x-1');

    const paths = itemPaths(storeDir, itemId);
    const before = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').length;

    const result = await decideCommand({ checkpoint: 'cp-x-1', decision: 'accept', configPath });
    expect(result).toBe(EXIT.USAGE);

    const after = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').length;
    expect(after).toBe(before);
    expect(await lockFileExists(storeDir, itemId)).toBe(false);
  });

  it('a held lock rejects with LockHeldError, exit 5, and appends no event', async () => {
    const itemId = await createItem('held-lock.md');
    const storeDir = join(workDir, '.miengu');
    await appendCheckpointRaised(storeDir, itemId, { checkpoint: 'cp-x-1' });

    const paths = itemPaths(storeDir, itemId);
    const before = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').length;

    const ids = createIdMinter(fixedRng('held-lock-holder'));
    const { log: holder } = await EventLog.open({
      storeDir,
      itemId,
      runId: ids.runId(),
      clock: fixedClock('2024-01-01T00:00:00.000Z'),
      ids,
      logger: silentLogger,
    });
    try {
      await expect(
        decideCommand({ checkpoint: 'cp-x-1', decision: 'accept', configPath }),
      ).rejects.toBeInstanceOf(LockHeldError);
    } finally {
      await holder.close();
    }

    const after = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').length;
    expect(after).toBe(before);
  });

  it('an ambiguous checkpoint id across two items is exit 2 naming both; --item disambiguates to exit 0', async () => {
    const itemA = await createItem('conflict.md');
    const itemB = await createItem('conflict.md');
    expect(itemA).not.toBe(itemB);
    const storeDir = join(workDir, '.miengu');
    await appendCheckpointRaised(storeDir, itemA, { checkpoint: 'cp-conflict-1' });
    await appendCheckpointRaised(storeDir, itemB, { checkpoint: 'cp-conflict-1' });

    const ambiguous = await decideCommand({ checkpoint: 'cp-conflict-1', decision: 'accept', configPath });
    expect(ambiguous).toBe(EXIT.USAGE);

    const disambiguated = await decideCommand({
      checkpoint: 'cp-conflict-1',
      decision: 'accept',
      item: itemA,
      configPath,
    });
    expect(disambiguated).toBe(EXIT.OK);

    const paths = itemPaths(storeDir, itemA);
    const raw = await readFile(paths.eventsFile, 'utf8');
    expect(raw).toContain('CheckpointDecided');
    const bPaths = itemPaths(storeDir, itemB);
    const bRaw = await readFile(bPaths.eventsFile, 'utf8');
    expect(bRaw).not.toContain('CheckpointDecided');
  });

  it('appends no RunStarted, writes no snapshot, and leaves replay reporting MATCH', async () => {
    const itemId = await createItem('replay-match.md');
    const storeDir = join(workDir, '.miengu');
    await appendCheckpointRaised(storeDir, itemId, { checkpoint: 'cp-x-1' });

    const paths = itemPaths(storeDir, itemId);
    const runStartedBefore = (await readFile(paths.eventsFile, 'utf8')).split('RunStarted').length;
    const { readdir } = await import('node:fs/promises');
    const snapshotsBefore = await readdir(paths.snapshotsDir).catch(() => []);

    await decideCommand({ checkpoint: 'cp-x-1', decision: 'accept', configPath });

    const rawAfter = await readFile(paths.eventsFile, 'utf8');
    const runStartedAfter = rawAfter.split('RunStarted').length;
    expect(runStartedAfter).toBe(runStartedBefore);

    const snapshotsAfter = await readdir(paths.snapshotsDir).catch(() => []);
    expect(snapshotsAfter).toEqual(snapshotsBefore);

    const replayResult = await replayCommand({ itemId, configPath, json: true });
    expect(replayResult).toBe(EXIT.OK);
  });
});
