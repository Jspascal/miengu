import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from '../../src/cli/commands/run.js';
import { EXIT } from '../../src/cli/exit.js';
import { EventLog, itemPaths, listItemIds } from '../../src/core/log.js';
import type { ParkReason } from '../../src/core/events.js';
import type { AccountId, WorkItemId } from '../../src/core/ids.js';
import { slugify } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { loadConfig } from '../../src/config/load.js';

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
  targetRepo = await mkdtemp(join(tmpdir(), 'miengu-cli-backlog-target-'));
  await git(targetRepo, ['init', '--initial-branch=main']);
  await git(targetRepo, ['config', 'user.email', 'test@example.com']);
  await git(targetRepo, ['config', 'user.name', 'Test']);
  await writeFile(join(targetRepo, 'README.md'), 'hello\n');
  await git(targetRepo, ['add', 'README.md']);
  await git(targetRepo, ['commit', '-m', 'initial']);

  workDir = await mkdtemp(join(tmpdir(), 'miengu-cli-backlog-work-'));
  configPath = join(workDir, 'miengu.config.yaml');
  await writeFile(configPath, stubOnlyConfigYaml(targetRepo), 'utf8');
});

afterEach(async () => {
  await rm(targetRepo, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

interface ParkedItemOptions {
  readonly title: string;
  readonly seed: string;
  readonly parkedAt: string;
  readonly park: {
    readonly reason: ParkReason;
    readonly detail: string;
    readonly resumable: boolean;
    readonly account: AccountId | null;
    readonly resetsAt: string | null;
  };
  /** Appended, in order, between `RunStarted` and `WorkItemParked` — used to build a
   *  rejected-blocking-checkpoint fixture without a real stage run. */
  readonly beforePark?: (log: EventLog) => Promise<void>;
}

/** Builds an item's log directly (`WorkItemCreated` -> `RunStarted` -> optional fixture
 *  events -> `WorkItemParked`), bypassing `runCommand` entirely: the backlog drain reads
 *  from the store alone, so it cannot distinguish a hand-built parked item from one a real
 *  run parked. */
async function makeParkedItem(storeDir: string, config: unknown, configHash: string, o: ParkedItemOptions): Promise<WorkItemId> {
  const ids = createIdMinter(fixedRng(o.seed));
  const slug = slugify(o.title);
  const itemId = ids.workItemId(slug);
  const runId = ids.runId();
  const clock = fixedClock(o.parkedAt);

  const { log } = await EventLog.create({ storeDir, itemId, runId, clock, ids, logger: silentLogger });
  try {
    await log.append({
      type: 'WorkItemCreated',
      data: {
        title: o.title,
        slug,
        source: { kind: 'prd-file', path: `${o.title}.md`, sha256: 'a'.repeat(64), bytes: 1 },
        config_hash: configHash,
      },
      actor: { kind: 'human', id: null },
      causationId: null,
    });
    await log.append({
      type: 'RunStarted',
      data: { miengu_version: '0.1.0', node_version: process.version, config_hash: configHash, config },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });
    if (o.beforePark !== undefined) {
      await o.beforePark(log);
    }
    await log.append({
      type: 'WorkItemParked',
      data: {
        reason: o.park.reason,
        detail: o.park.detail,
        resumable: o.park.resumable,
        account: o.park.account,
        resets_at: o.park.resetsAt,
      },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });
  } finally {
    await log.close();
  }
  return itemId;
}

async function lockFileExists(storeDir: string, itemId: WorkItemId): Promise<boolean> {
  const paths = itemPaths(storeDir, itemId);
  return readFile(paths.lockFile, 'utf8').then(
    () => true,
    () => false,
  );
}

async function readEventTypes(storeDir: string, itemId: WorkItemId): Promise<string[]> {
  const paths = itemPaths(storeDir, itemId);
  const raw = await readFile(paths.eventsFile, 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

async function readEvents(storeDir: string, itemId: WorkItemId): Promise<Record<string, unknown>[]> {
  const paths = itemPaths(storeDir, itemId);
  const raw = await readFile(paths.eventsFile, 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runCommand: backlog drain', () => {
  it('an empty store behaves exactly as Phase 4 and prints no backlog block', async () => {
    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    let result: number;
    try {
      result = await runCommand({ prdFile, configPath });
    } finally {
      write.mockRestore();
    }
    expect(result).toBe(EXIT.OK);
    expect(output).not.toContain('backlog');

    const storeDir = join(workDir, '.miengu');
    const itemIds = await listItemIds(storeDir);
    expect(itemIds).toHaveLength(1);
  });

  it('resumes only the cleared item, with RunStarted then WorkItemResumed under the shared RunId', async () => {
    const storeDir = join(workDir, '.miengu');
    const loaded = await loadConfig(configPath);

    const cleared = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'cleared',
      seed: 'backlog-cleared',
      parkedAt: '2024-01-01T00:00:00.000Z',
      park: { reason: 'operator-abort', detail: 'sigint', resumable: true, account: null, resetsAt: null },
    });
    const notCleared = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'notcleared',
      seed: 'backlog-notcleared',
      parkedAt: '2024-01-02T00:00:00.000Z',
      park: { reason: 'attempts-exhausted', detail: 'ran out', resumable: true, account: null, resetsAt: null },
    });

    const prdFile = join(workDir, 'new-item.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');
    const result = await runCommand({ prdFile, configPath });
    expect(result).toBe(EXIT.OK);

    const itemIds = await listItemIds(storeDir);
    const newItemId = itemIds.find((id) => id !== cleared && id !== notCleared);
    expect(newItemId).toBeDefined();
    if (newItemId === undefined) return;

    const newItemEvents = await readEvents(storeDir, newItemId);
    const runStarted = newItemEvents.find((e) => e['type'] === 'RunStarted');
    expect(runStarted).toBeDefined();
    const sharedRunId = runStarted?.['run_id'];

    const clearedEvents = await readEvents(storeDir, cleared);
    const clearedTypes = clearedEvents.map((e) => e['type']);
    const runStartedIndex = clearedTypes.lastIndexOf('RunStarted');
    const resumedIndex = clearedTypes.indexOf('WorkItemResumed');
    expect(runStartedIndex).toBeGreaterThanOrEqual(0);
    expect(resumedIndex).toBeGreaterThan(runStartedIndex);
    expect(clearedEvents[runStartedIndex]?.['run_id']).toBe(sharedRunId);
    expect(clearedEvents[resumedIndex]?.['run_id']).toBe(sharedRunId);
    expect(clearedTypes).toContain('WorkItemCompleted');
    // Binding decision item 33 finding 4: a backlog-drained resumption is the supervisor's
    // own opportunistic clearance, not an operator naming the item, so §8's audit trail
    // must not attribute it to a human.
    expect(clearedEvents[resumedIndex]?.['actor']).toEqual({ kind: 'supervisor', id: null });

    const notClearedTypes = await readEventTypes(storeDir, notCleared);
    expect(notClearedTypes).not.toContain('WorkItemResumed');
  });

  it('cross-item quota gate: item B is skipped with account-blocked-this-run and appends no ExecutorInvoked', async () => {
    const storeDir = join(workDir, '.miengu');
    const loaded = await loadConfig(configPath);

    const itemA = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'quota-a',
      seed: 'backlog-quota-a',
      parkedAt: '2024-01-01T00:00:00.000Z',
      park: {
        reason: 'provider-quota',
        detail: 'quota exhausted',
        resumable: true,
        account: 'stub-account' as AccountId,
        resetsAt: '2099-01-01T00:00:00.000Z',
      },
    });
    const itemB = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'quota-b',
      seed: 'backlog-quota-b',
      parkedAt: '2024-01-02T00:00:00.000Z',
      // `nextStageAccount` is `policy.stageAccounts[state.stage]`, so B must already be
      // sitting in a role stage (not the accountless `intake`) for the account gate to see
      // that its next stage needs the same account item A parked on.
      beforePark: async (log) => {
        await log.append({
          type: 'StageEntered',
          data: { stage: 'analysis', attempt: 1 },
          actor: { kind: 'supervisor', id: null },
          causationId: log.lastEventId,
        });
      },
      park: { reason: 'operator-abort', detail: 'sigint', resumable: true, account: null, resetsAt: null },
    });

    const prdFile = join(workDir, 'new-item.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await runCommand({ prdFile, configPath, json: true });
    } finally {
      write.mockRestore();
    }

    const parsed = JSON.parse(output.trim().split('\n')[0] ?? '{}') as {
      backlog: { item: string; ready: boolean; blocker: string | null }[];
    };
    const rowB = parsed.backlog.find((row) => row.item === itemB);
    expect(rowB?.ready).toBe(false);
    expect(rowB?.blocker).toBe('account-blocked-this-run');

    const bTypes = await readEventTypes(storeDir, itemB);
    expect(bTypes).not.toContain('ExecutorInvoked');
    expect(bTypes).not.toContain('WorkItemResumed');

    const aTypes = await readEventTypes(storeDir, itemA);
    // item A itself is still blocked on its own quota window (not cleared): never resumed either.
    expect(aTypes).not.toContain('WorkItemResumed');
  });

  it('drain order: the new item first, then ready backlog entries ascending by (park.since, itemId)', async () => {
    const storeDir = join(workDir, '.miengu');
    const loaded = await loadConfig(configPath);

    const later = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'order-later',
      seed: 'backlog-order-later',
      parkedAt: '2024-01-05T00:00:00.000Z',
      park: { reason: 'operator-abort', detail: 'x', resumable: true, account: null, resetsAt: null },
    });
    const earlier = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'order-earlier',
      seed: 'backlog-order-earlier',
      parkedAt: '2024-01-01T00:00:00.000Z',
      park: { reason: 'operator-abort', detail: 'x', resumable: true, account: null, resetsAt: null },
    });

    const prdFile = join(workDir, 'new-item.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await runCommand({ prdFile, configPath, json: true });
    } finally {
      write.mockRestore();
    }
    const parsed = JSON.parse(output.trim().split('\n')[0] ?? '{}') as {
      item: string;
      backlog: { item: string }[];
    };
    const order = parsed.backlog.map((row) => row.item);
    expect(order.indexOf(earlier)).toBeLessThan(order.indexOf(later));
    // The new item is not itself a backlog row; it always runs first by construction.
    expect(order).not.toContain(parsed.item);
  });

  it('a backlog item with a held lock is skipped, and the run still exits with the new item\'s code', async () => {
    const storeDir = join(workDir, '.miengu');
    const loaded = await loadConfig(configPath);

    const locked = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'locked',
      seed: 'backlog-locked',
      parkedAt: '2024-01-01T00:00:00.000Z',
      park: { reason: 'operator-abort', detail: 'x', resumable: true, account: null, resetsAt: null },
    });

    const holderIds = createIdMinter(fixedRng('backlog-locked-holder'));
    const { log: holderLog } = await EventLog.open({
      storeDir,
      itemId: locked,
      runId: holderIds.runId(),
      clock: fixedClock('2024-01-01T00:00:00.000Z'),
      ids: holderIds,
      logger: silentLogger,
    });

    try {
      const prdFile = join(workDir, 'new-item.md');
      await writeFile(prdFile, 'Build a thing.\n', 'utf8');
      const result = await runCommand({ prdFile, configPath, json: true });
      expect(result).toBe(EXIT.OK);
    } finally {
      await holderLog.close();
    }

    const lockedTypes = await readEventTypes(storeDir, locked);
    expect(lockedTypes).not.toContain('WorkItemResumed');
  });

  it('a backlog item with a rejected blocking checkpoint is never resumed', async () => {
    const storeDir = join(workDir, '.miengu');
    const loaded = await loadConfig(configPath);

    const rejected = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'rejected',
      seed: 'backlog-rejected',
      parkedAt: '2024-01-01T00:00:00.000Z',
      beforePark: async (log) => {
        await log.append({
          type: 'CheckpointRaised',
          data: {
            checkpoint: 'cp-rejected-1',
            kind: 'irreversible',
            stage: 'architecture',
            summary: 'irreversible decision',
            blocking: true,
            sla_seconds: null,
            default_decision: null,
          },
          actor: { kind: 'supervisor', id: null },
          causationId: log.lastEventId,
        });
        await log.append({
          type: 'CheckpointDecided',
          data: { checkpoint: 'cp-rejected-1', decision: 'reject', by: 'human', reason: null },
          actor: { kind: 'human', id: null },
          causationId: log.lastEventId,
        });
      },
      park: { reason: 'awaiting-human', detail: 'blocked', resumable: true, account: null, resetsAt: null },
    });

    const prdFile = join(workDir, 'new-item.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await runCommand({ prdFile, configPath, json: true });
    } finally {
      write.mockRestore();
    }
    const parsed = JSON.parse(output.trim().split('\n')[0] ?? '{}') as {
      backlog: { item: string; ready: boolean; blocker: string | null }[];
    };
    const row = parsed.backlog.find((r) => r.item === rejected);
    expect(row?.ready).toBe(false);
    expect(row?.blocker).toBe('blocking-checkpoint-rejected');

    const rejectedTypes = await readEventTypes(storeDir, rejected);
    expect(rejectedTypes).not.toContain('WorkItemResumed');
  });

  it('--no-backlog skips the scan entirely', async () => {
    const storeDir = join(workDir, '.miengu');
    const loaded = await loadConfig(configPath);

    const cleared = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'nobacklog',
      seed: 'backlog-nobacklog',
      parkedAt: '2024-01-01T00:00:00.000Z',
      park: { reason: 'operator-abort', detail: 'x', resumable: true, account: null, resetsAt: null },
    });

    const prdFile = join(workDir, 'new-item.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await runCommand({ prdFile, configPath, noBacklog: true, json: true });
    } finally {
      write.mockRestore();
    }
    const parsed = JSON.parse(output.trim().split('\n')[0] ?? '{}') as { backlog: unknown[] };
    expect(parsed.backlog).toEqual([]);

    const types = await readEventTypes(storeDir, cleared);
    expect(types).not.toContain('WorkItemResumed');
  });

  it('every item\'s lock file is absent after the run', async () => {
    const storeDir = join(workDir, '.miengu');
    const loaded = await loadConfig(configPath);

    const cleared = await makeParkedItem(storeDir, loaded.config, loaded.configHash, {
      title: 'locks',
      seed: 'backlog-locks',
      parkedAt: '2024-01-01T00:00:00.000Z',
      park: { reason: 'operator-abort', detail: 'x', resumable: true, account: null, resetsAt: null },
    });

    const prdFile = join(workDir, 'new-item.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');
    await runCommand({ prdFile, configPath });

    const itemIds = await listItemIds(storeDir);
    for (const itemId of itemIds) {
      expect(await lockFileExists(storeDir, itemId)).toBe(false);
    }
    expect(itemIds).toContain(cleared);
  });
});
